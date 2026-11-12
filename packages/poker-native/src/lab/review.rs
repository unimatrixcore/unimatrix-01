use super::datasets::{file, DatasetContext};
use super::{bad, conflict, now_ms, sha256, uuid, LabRequest, LabResponse, LabResult, LabService};
use crate::{labels, media};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, sync::Arc};

#[derive(Clone, Debug)]
pub struct SampleInput {
    pub key: String,
    pub region_id: String,
    pub png: Vec<u8>,
    pub filename: Option<String>,
}
#[derive(Clone)]
struct Sample {
    region: String,
    pixels: String,
    image: String,
    filename: Option<String>,
    label: String,
}
pub fn validation_contract() -> Value {
    json!({"version":labels::contract_version(),"sha256":sha256(labels::CONTRACT_BYTES)})
}
pub fn image_identity(png: &[u8]) -> LabResult<(String, String)> {
    let image = media::decode_image(png).map_err(bad)?;
    if u64::from(image.width()) * u64::from(image.height()) > 16_000_000 {
        return Err(bad("Crop exceeds size limit"));
    }
    let rgb = image.to_rgb8();
    let mut bytes = format!("{}x{}:RGB:", rgb.width(), rgb.height()).into_bytes();
    bytes.extend_from_slice(rgb.as_raw());
    Ok((sha256(png), sha256(&bytes)))
}
pub fn ensure(ctx: &DatasetContext) -> LabResult<()> {
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_samples'",
            [],
            |r| r.get::<_, i32>(0),
        )
        .optional()?
        .is_some();
    if !exists
        && ctx.id == "legacy"
        && conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0))? > 0
    {
        let root = ctx
            .directory
            .parent()
            .ok_or_else(|| bad("Invalid dataset directory"))?
            .join("backups");
        fs::create_dir_all(&root)?;
        let mut dest = Connection::open(root.join(format!(
            "legacy-before-review-{}-{}.db",
            now_ms(),
            &uuid()[..8]
        )))?;
        let backup = rusqlite::backup::Backup::new(&conn, &mut dest)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(2), None)?;
    }
    ensure_conn(&conn)
}
pub fn ensure_conn(conn: &Connection) -> LabResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS review_samples(sample_key TEXT PRIMARY KEY,region_id TEXT NOT NULL,pixel_sha256 TEXT NOT NULL,image_sha256 TEXT NOT NULL,filename TEXT,label TEXT NOT NULL DEFAULT '',crop BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS model_predictions(id TEXT PRIMARY KEY,sample_key TEXT NOT NULL,region_id TEXT NOT NULL,pixel_sha256 TEXT NOT NULL,dataset_id TEXT NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS label_review_events(id INTEGER PRIMARY KEY AUTOINCREMENT,sample_key TEXT NOT NULL,filename TEXT,prediction_id TEXT,prior_label TEXT NOT NULL,label TEXT NOT NULL,action TEXT NOT NULL,pixel_sha256 TEXT NOT NULL,dataset_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_events_sample ON label_review_events(sample_key);
CREATE TABLE IF NOT EXISTS review_mapping_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
INSERT OR IGNORE INTO review_mapping_revision VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS review_mapping_insert AFTER INSERT ON review_samples WHEN NEW.filename IS NOT NULL BEGIN UPDATE review_mapping_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS review_mapping_delete AFTER DELETE ON review_samples WHEN OLD.filename IS NOT NULL BEGIN UPDATE review_mapping_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS review_mapping_update AFTER UPDATE OF filename,sample_key ON review_samples WHEN OLD.filename IS NOT NEW.filename OR OLD.sample_key IS NOT NEW.sample_key BEGIN UPDATE review_mapping_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS review_events_no_update BEFORE UPDATE ON label_review_events BEGIN SELECT RAISE(ABORT,'Review history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_events_no_delete BEFORE DELETE ON label_review_events BEGIN SELECT RAISE(ABORT,'Review history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS predictions_no_update BEFORE UPDATE ON model_predictions BEGIN SELECT RAISE(ABORT,'Predictions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS predictions_no_delete BEFORE DELETE ON model_predictions BEGIN SELECT RAISE(ABORT,'Predictions are immutable'); END;")?;
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(label_review_events)")?
        .query_map([], |r| r.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, kind) in [
        ("contract_version", "TEXT"),
        ("contract_sha256", "TEXT"),
        ("schema_valid", "INTEGER"),
        ("outside_contract", "INTEGER"),
    ] {
        if !columns.iter().any(|c| c == name) {
            conn.execute_batch(&format!(
                "ALTER TABLE label_review_events ADD COLUMN {name} {kind}"
            ))?;
        }
    }
    Ok(())
}
pub fn row_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    use rusqlite::types::ValueRef;
    let mut map = serde_json::Map::new();
    for n in 0..row.as_ref().column_count() {
        let name = row.as_ref().column_name(n)?.to_owned();
        let value = match row.get_ref(n)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => json!(n),
            ValueRef::Real(n) => json!(n),
            ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
            ValueRef::Blob(v) => json!(STANDARD.encode(v)),
        };
        map.insert(name, value);
    }
    Ok(Value::Object(map))
}
fn sample(conn: &Connection, input: &SampleInput) -> LabResult<Sample> {
    if input.key.is_empty() || input.key.chars().count() > 512 {
        return Err(bad(
            "sample_key is required and must be at most 512 characters",
        ));
    }
    if input.region_id.is_empty() || input.region_id.chars().count() > 200 {
        return Err(bad("Region id is required"));
    }
    let (image, pixels) = image_identity(&input.png)?;
    let existing:Option<Sample>=conn.query_row("SELECT region_id,pixel_sha256,image_sha256,filename,label FROM review_samples WHERE sample_key=?",[&input.key],|r|Ok(Sample{region:r.get(0)?,pixels:r.get(1)?,image:r.get(2)?,filename:r.get(3)?,label:r.get(4)?})).optional()?;
    if let Some(row) = &existing {
        if row.region != input.region_id {
            return Err(conflict("Sample region changed"));
        }
        if row.pixels != pixels {
            if input.filename.is_none() {
                return Err(conflict("Sample pixels or region changed"));
            }
            conn.execute(
                "UPDATE review_samples SET pixel_sha256=?,image_sha256=?,crop=? WHERE sample_key=?",
                params![pixels, image, input.png, input.key],
            )?;
        }
    }
    let mut prior = String::new();
    if let Some(filename) = &input.filename {
        let saved: Option<(String, String)> = conn
            .query_row(
                "SELECT COALESCE(label,''),region_id FROM images WHERE filename=?",
                [filename],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (label, region) =
            saved.ok_or_else(|| conflict("Saved sample is missing or its region changed"))?;
        if region != input.region_id {
            return Err(conflict("Saved sample is missing or its region changed"));
        }
        prior = label;
    }
    if existing.is_some() {
        conn.execute("UPDATE review_samples SET image_sha256=?,crop=?,filename=COALESCE(?,filename) WHERE sample_key=?",params![image,input.png,input.filename,input.key])?;
    }
    conn.execute("INSERT OR IGNORE INTO review_samples(sample_key,region_id,pixel_sha256,image_sha256,filename,label,crop) VALUES(?,?,?,?,?,?,?)",params![input.key,input.region_id,pixels,image,input.filename,prior,input.png])?;
    Ok(conn.query_row("SELECT region_id,pixel_sha256,image_sha256,filename,label FROM review_samples WHERE sample_key=?",[&input.key],|r|Ok(Sample{region:r.get(0)?,pixels:r.get(1)?,image:r.get(2)?,filename:r.get(3)?,label:r.get(4)?}))?)
}
pub fn prediction_conn(
    conn: &Connection,
    ctx: &DatasetContext,
    input: &SampleInput,
    mut result: Value,
) -> LabResult<Value> {
    let sample = sample(conn, input)?;
    let category = labels::category_for_region(&input.region_id)
        .ok_or_else(|| bad("Unsupported OCR region"))?;
    let schema_valid = match result.get("text").and_then(Value::as_str) {
        Some("") => result.get("raw_text").and_then(Value::as_str) == Some(""),
        Some(text) => labels::validate_text(category, text, false),
        None => false,
    };
    let payload = result
        .as_object_mut()
        .ok_or_else(|| bad("Invalid model result"))?;
    payload.insert("schema_valid".into(), json!(schema_valid));
    payload.insert("category".into(), json!(category));
    payload.insert("validation_contract".into(), validation_contract());
    payload.insert("image_sha256".into(), json!(sample.image));
    payload.insert("pixel_sha256".into(), json!(sample.pixels));
    let id = uuid();
    let created = now_ms();
    conn.execute("INSERT INTO model_predictions(id,sample_key,region_id,pixel_sha256,dataset_id,created_at,payload) VALUES(?,?,?,?,?,?,?)",params![id,input.key,input.region_id,sample.pixels,ctx.id,created,serde_json::to_string(&result)?])?;
    let payload = result.as_object_mut().expect("validated object");
    payload.insert("id".into(), json!(id));
    payload.insert("sample_key".into(), json!(input.key));
    payload.insert("dataset_id".into(), json!(ctx.id));
    payload.insert("created_at".into(), json!(created));
    Ok(result)
}
pub fn prediction(ctx: &DatasetContext, input: &SampleInput, result: Value) -> LabResult<Value> {
    ensure(ctx)?;
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let value = prediction_conn(&tx, ctx, input, result)?;
    tx.commit()?;
    Ok(value)
}
pub fn review_conn(
    conn: &Connection,
    ctx: &DatasetContext,
    input: &SampleInput,
    label: &str,
    action: &str,
    prediction_id: Option<&str>,
    allow_outside_contract: bool,
) -> LabResult<Value> {
    let schema_valid =
        labels::validate_reviewed_label(&input.region_id, label, action, allow_outside_contract)
            .map_err(bad)?;
    let current = sample(conn, input)?;
    if let Some(id) = prediction_id {
        let prediction: Option<Value> = conn
            .query_row("SELECT * FROM model_predictions WHERE id=?", [id], row_json)
            .optional()?;
        let prediction = prediction.ok_or_else(|| {
            conflict("Prediction does not match this dataset, sample, or current crop")
        })?;
        if prediction["sample_key"] != input.key
            || prediction["dataset_id"] != ctx.id
            || prediction["region_id"] != input.region_id
            || prediction["pixel_sha256"] != current.pixels
        {
            return Err(conflict(
                "Prediction does not match this dataset, sample, or current crop",
            ));
        }
        if action == "accepted" {
            let suggestion: Value = serde_json::from_str(
                prediction["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Invalid stored prediction"))?,
            )?;
            if suggestion["validation_contract"] != validation_contract() {
                return Err(bad(
                    "Prediction validation policy changed; request a fresh suggestion",
                ));
            }
            if suggestion["text"] != label || suggestion["schema_valid"] != true || !schema_valid {
                return Err(bad(
                    "Only an unchanged, schema-valid suggestion can be accepted",
                ));
            }
        }
    } else if action == "accepted" {
        return Err(bad("Accept requires a stored prediction"));
    }
    let mut prior = current.label;
    let filename = input.filename.as_ref().or(current.filename.as_ref());
    if let Some(filename) = filename {
        if let Some(saved) = conn
            .query_row(
                "SELECT COALESCE(label,'') FROM images WHERE filename=?",
                [filename],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            prior = saved;
            conn.execute(
                "UPDATE images SET label=? WHERE filename=?",
                params![label, filename],
            )?;
        }
    }
    let contract = validation_contract();
    conn.execute("INSERT INTO label_review_events(sample_key,filename,prediction_id,prior_label,label,action,pixel_sha256,dataset_id,created_at,contract_version,contract_sha256,schema_valid,outside_contract) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![input.key,filename,prediction_id,prior,label,action,current.pixels,ctx.id,now_ms(),labels::contract_version().to_string(),contract["sha256"].as_str(),i64::from(schema_valid),i64::from(!schema_valid)])?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE review_samples SET label=? WHERE sample_key=?",
        params![label, input.key],
    )?;
    Ok(conn.query_row(
        "SELECT * FROM label_review_events WHERE id=?",
        [id],
        row_json,
    )?)
}
pub fn review(
    ctx: &DatasetContext,
    input: &SampleInput,
    label: &str,
    action: &str,
    prediction_id: Option<&str>,
    allow_outside_contract: bool,
) -> LabResult<Value> {
    ensure(ctx)?;
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let value = review_conn(
        &tx,
        ctx,
        input,
        label,
        action,
        prediction_id,
        allow_outside_contract,
    )?;
    tx.commit()?;
    Ok(value)
}
pub fn sample_input(ctx: &DatasetContext, data: &Value) -> LabResult<SampleInput> {
    for field in ["filename", "sample_key", "id", "base64_image", "queue_mode"] {
        if data
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            return Err(bad(format!("{field} must be a string")));
        }
    }
    ensure(ctx)?;
    let filename = data.get("filename").and_then(Value::as_str);
    let key = data
        .get("sample_key")
        .and_then(Value::as_str)
        .or(filename)
        .ok_or_else(|| bad("sample_key is required"))?;
    let rid = data.get("id").and_then(Value::as_str);
    if let Some(filename) = filename {
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        let region: Option<String> = conn
            .query_row(
                "SELECT region_id FROM images WHERE filename=?",
                [filename],
                |r| r.get(0),
            )
            .optional()?;
        let region = region.ok_or_else(|| bad("Saved crop does not exist in this dataset"))?;
        if rid.is_some_and(|rid| rid != region) {
            return Err(conflict("Region does not match saved crop"));
        }
        drop(conn);
        let path = file(&ctx.images(), filename)?;
        let png = fs::read(path).map_err(|_| conflict("Saved crop file is missing"))?;
        return Ok(SampleInput {
            key: key.into(),
            region_id: region,
            png,
            filename: Some(filename.into()),
        });
    }
    let existing: Option<(String, Option<String>, Vec<u8>)> = {
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        conn.query_row(
            "SELECT region_id,filename,crop FROM review_samples WHERE sample_key=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
    };
    let png = if let Some(encoded) = data.get("base64_image") {
        let encoded = encoded
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 12_000_000)
            .ok_or_else(|| bad("A base64 PNG crop is required (maximum 9 MB)"))?;
        let raw = STANDARD
            .decode(encoded)
            .map_err(|e| bad(format!("Invalid crop: {e}")))?;
        if image::guess_format(&raw).map_err(|e| bad(e.to_string()))? != image::ImageFormat::Png {
            return Err(bad("Crop must be a PNG image"));
        }
        image_identity(&raw)?;
        if let Some((_, Some(filename), _)) = &existing {
            let mut next = data.clone();
            next["filename"] = json!(filename);
            return sample_input(ctx, &next);
        }
        raw
    } else if data.get("queue_id").is_some()
        || data.get("queue_mode").and_then(Value::as_str) == Some("paged")
    {
        super::queue::ensure(ctx)?;
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        let queued: Option<(String, Vec<u8>, i64)> = conn
            .query_row(
                "SELECT region_id,crop,queue_id FROM queue_items WHERE sample_key=? AND active=1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (region, png, id) =
            queued.ok_or_else(|| bad("Queued crop no longer exists in this dataset"))?;
        if rid.is_some_and(|rid| rid != region) {
            return Err(conflict("Region does not match queued crop"));
        }
        if data.get("queue_id").is_some_and(|v| v.as_i64() != Some(id)) {
            return Err(conflict("Queue identity does not match queued crop"));
        }
        return Ok(SampleInput {
            key: key.into(),
            region_id: region,
            png,
            filename: None,
        });
    } else {
        if let Some((_, Some(filename), _)) = &existing {
            let mut next = data.clone();
            next["filename"] = json!(filename);
            return sample_input(ctx, &next);
        }
        existing
            .as_ref()
            .map(|(_, _, png)| png.clone())
            .ok_or_else(|| bad("A crop or known sample_key is required"))?
    };
    let region = rid
        .or_else(|| existing.as_ref().map(|(rid, _, _)| rid.as_str()))
        .ok_or_else(|| bad("Region id is required"))?;
    if region.is_empty()
        || region.chars().count() > 200
        || key.is_empty()
        || key.chars().count() > 512
    {
        return Err(bad("Region id and sample_key are required"));
    }
    Ok(SampleInput {
        key: key.into(),
        region_id: region.into(),
        png,
        filename: None,
    })
}
pub fn history(
    ctx: &DatasetContext,
    key: Option<&str>,
    filename: Option<&str>,
) -> LabResult<Value> {
    ensure(ctx)?;
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    let mut keys = Vec::new();
    if let Some(key) = key {
        keys.push(key.to_owned());
    }
    if let Some(filename) = filename {
        super::datasets::safe_filename(filename)?;
        let mapped: Vec<String> = conn
            .prepare("SELECT sample_key FROM review_samples WHERE filename=?")?
            .query_map([filename], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        keys.extend(mapped);
        keys.push(filename.into());
    }
    keys.retain(|k| !k.is_empty());
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    if keys.is_empty() {
        return Ok(json!({"events":[],"predictions":[]}));
    }
    let selectors = vec!["?"; keys.len()].join(",");
    let events: Vec<Value> = conn
        .prepare(&format!(
            "SELECT * FROM label_review_events WHERE sample_key IN ({selectors}) ORDER BY id DESC"
        ))?
        .query_map(rusqlite::params_from_iter(&keys), row_json)?
        .collect::<rusqlite::Result<_>>()?;
    let predictions:Vec<Value>=conn.prepare(&format!("SELECT * FROM model_predictions WHERE sample_key IN ({selectors}) ORDER BY created_at DESC,rowid DESC"))?.query_map(rusqlite::params_from_iter(&keys),row_json)?.map(|row|{let mut row=row?;let mut payload:Value=serde_json::from_str(row["payload"].as_str().unwrap_or("{}"))?;row.as_object_mut().expect("row object").remove("payload");if let Some(fields)=payload.as_object_mut(){fields.extend(row.as_object().expect("row object").clone());}Ok(payload)}).collect::<LabResult<_>>()?;
    Ok(json!({"events":events,"predictions":predictions}))
}
pub fn history_page(
    ctx: &DatasetContext,
    key: Option<&str>,
    filename: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> LabResult<Value> {
    ensure(ctx)?;
    if key.is_some_and(|s| s.len() > 512) {
        return Err(bad("Invalid sample key"));
    }
    if let Some(filename) = filename {
        super::datasets::safe_filename(filename)?;
    }
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let mapping_revision: i64 = tx.query_row(
        "SELECT revision FROM review_mapping_revision WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let (events, predictions, offset) = if let Some(raw) = cursor {
        let value: Value = serde_json::from_str(raw).map_err(|_| bad("Invalid history cursor"))?;
        if filename.is_some() && value["mapping_revision"].as_i64() != Some(mapping_revision) {
            return Err(conflict("History sample mapping changed; reload the list"));
        }
        (
            value["events"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or_else(|| bad("Invalid history cursor"))?,
            value["predictions"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or_else(|| bad("Invalid history cursor"))?,
            value["offset"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or_else(|| bad("Invalid history cursor"))?,
        )
    } else {
        (
            tx.query_row(
                "SELECT COALESCE(MAX(rowid),0) FROM label_review_events",
                [],
                |r| r.get(0),
            )?,
            tx.query_row(
                "SELECT COALESCE(MAX(rowid),0) FROM model_predictions",
                [],
                |r| r.get(0),
            )?,
            0,
        )
    };
    let next = offset
        .checked_add(limit as i64)
        .ok_or_else(|| bad("Invalid history cursor"))?;
    let predicate="(?1 IS NOT NULL AND sample_key=?1) OR (?2 IS NOT NULL AND (sample_key=?2 OR sample_key IN (SELECT sample_key FROM review_samples WHERE filename=?2)))";
    let union=format!("SELECT 'event' kind,rowid rid,created_at FROM label_review_events WHERE rowid<=?3 AND ({predicate}) UNION ALL SELECT 'prediction' kind,rowid rid,created_at FROM model_predictions WHERE rowid<=?4 AND ({predicate})");
    let total: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM ({union})"),
        params![key, filename, events, predictions],
        |r| r.get(0),
    )?;
    let selected: Vec<(String, i64)> = {
        let mut q=tx.prepare(&format!("SELECT kind,rid FROM ({union}) ORDER BY created_at DESC,kind DESC,rid DESC LIMIT ?5 OFFSET ?6"))?;
        let rows = q
            .query_map(
                params![
                    key,
                    filename,
                    events,
                    predictions,
                    (limit + 1) as i64,
                    offset
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    let more = selected.len() > limit;
    let mut items = Vec::new();
    for (kind, id) in selected.into_iter().take(limit) {
        let table = if kind == "event" {
            "label_review_events"
        } else {
            "model_predictions"
        };
        let mut payload = tx.query_row(
            &format!("SELECT * FROM {table} WHERE rowid=?"),
            [id],
            row_json,
        )?;
        if kind == "prediction" {
            let fields = payload.as_object_mut().expect("row object");
            let raw = fields
                .remove("payload")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let mut parsed: Value = serde_json::from_str(&raw)?;
            if let Some(object) = parsed.as_object_mut() {
                object.extend(fields.clone());
            }
            payload = parsed;
        }
        items.push(json!({"kind":kind,"payload":payload}));
    }
    Ok(
        json!({"items":items,"total":total,"next_cursor":if more {Some(json!({"events":events,"predictions":predictions,"offset":next,"mapping_revision":mapping_revision}).to_string())} else {None},"meta":{}}),
    )
}

pub fn commit(
    ctx: &DatasetContext,
    entries: &[(Value, Vec<u8>, String)],
) -> LabResult<Vec<String>> {
    ensure(ctx)?;
    let mut prepared = Vec::new();
    for (entry, png, phash) in entries {
        let rid = entry["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.chars().count() <= 200)
            .ok_or_else(|| bad("Region id is required"))?;
        let label = entry
            .get("label")
            .map(|value| value.as_str().ok_or_else(|| bad("Label must be a string")))
            .transpose()?
            .unwrap_or("");
        prediction_id(entry)?;
        if !labels::validate_text(labels::category_for_region(rid).unwrap_or(""), label, true) {
            labels::validate_reviewed_label(rid, label, "manual", true).map_err(bad)?;
        }
        let stem = rid.replace(['.', '[', ']'], "_");
        let filename = format!("{stem}_{phash}.png");
        super::datasets::safe_filename(&filename)?;
        let source = entry
            .get("source")
            .or_else(|| entry.get("game_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = entry["sample_key"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{rid}:{phash}:{source}"));
        prepared.push((entry, png, phash, filename, key));
    }
    let mut originals: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let result = (|| -> LabResult<Vec<String>> {
        let tx = conn.transaction()?;
        for (entry, png, phash, filename, key) in &prepared {
            let rid = entry["id"].as_str().expect("prepared region");
            let label = entry["label"].as_str().unwrap_or("");
            let existing: Option<String> = tx
                .query_row(
                    "SELECT COALESCE(label,'') FROM images WHERE filename=?",
                    [filename],
                    |r| r.get(0),
                )
                .optional()?;
            let input = SampleInput {
                key: key.clone(),
                region_id: rid.into(),
                png: (*png).clone(),
                filename: existing.as_ref().map(|_| filename.clone()),
            };
            let current = sample(&tx, &input)?;
            let outside =
                !labels::validate_text(labels::category_for_region(rid).unwrap_or(""), label, true);
            if outside {
                let reviewed:Option<(String,i64)>=tx.query_row("SELECT label,outside_contract FROM label_review_events WHERE sample_key=? AND pixel_sha256=? AND dataset_id=? ORDER BY id DESC LIMIT 1",params![key,current.pixels,ctx.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if !reviewed.is_some_and(|(prior, flag)| prior == label && flag != 0) {
                    return Err(bad(
                        "Outside-contract status requires a matching explicit human review",
                    ));
                }
            }
            let prediction_id = prediction_id(entry)?;
            if let Some(id) = prediction_id {
                let bound:Option<(String,String,String,String)>=tx.query_row("SELECT sample_key,dataset_id,region_id,pixel_sha256 FROM model_predictions WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                if !bound.is_some_and(|(k, d, r, p)| {
                    k == *key && d == ctx.id && r == rid && p == current.pixels
                }) {
                    return Err(conflict(
                        "Prediction does not match this dataset, sample, or current crop",
                    ));
                }
            }
            let has_review = tx
                .query_row(
                    "SELECT id FROM label_review_events WHERE sample_key=? LIMIT 1",
                    [key],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if !has_review
                || current.label != label
                || existing
                    .as_ref()
                    .is_some_and(|label_before| label_before != label)
            {
                review_conn(
                    &tx,
                    ctx,
                    &input,
                    label,
                    if prediction_id.is_some() {
                        "corrected"
                    } else {
                        "manual"
                    },
                    prediction_id,
                    outside,
                )?;
            }
            let source = entry["source"].as_str();
            let source_id: Option<i64> = if let Some(source) = source {
                tx.query_row(
                    "SELECT id FROM full_captures WHERE filename=?",
                    [source],
                    |r| r.get(0),
                )
                .optional()?
            } else {
                None
            };
            let rect = &entry["rect"];
            tx.execute("INSERT INTO images(filename,phash,label,region_id,source_id,timestamp,x,y,w,h) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(filename) DO UPDATE SET label=excluded.label,source_id=excluded.source_id,x=excluded.x,y=excluded.y,w=excluded.w,h=excluded.h",params![filename,phash,label,rid,source_id,now_ms(),rect["x"].as_i64(),rect["y"].as_i64(),rect["w"].as_i64(),rect["h"].as_i64()])?;
            tx.execute(
                "UPDATE review_samples SET filename=? WHERE sample_key=?",
                params![filename, key],
            )?;
            let path = file(&ctx.images(), filename)?;
            if !originals.contains_key(filename) {
                originals.insert(
                    filename.clone(),
                    if path.exists() {
                        Some(fs::read(&path)?)
                    } else {
                        None
                    },
                );
            }
            fs::write(path, png)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO session_progress(id,data) VALUES(1,?)",
            [json!({"frames":[],"pool":[]}).to_string()],
        )?;
        tx.commit()?;
        Ok(prepared
            .iter()
            .map(|(_, _, _, filename, _)| filename.clone())
            .collect())
    })();
    if result.is_err() {
        for (filename, prior) in originals {
            let path = file(&ctx.images(), &filename)?;
            if let Some(prior) = prior {
                fs::write(path, prior)?;
            } else if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    result
}
pub fn handle(
    service: &LabService,
    ctx: &Arc<DatasetContext>,
    request: &LabRequest,
) -> Option<LabResult<LabResponse>> {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/model_suggestion") => Some((|| {
            let input = {
                let _operation = ctx.lock_operation()?;
                service.registry.resolve(&ctx.id)?;
                sample_input(ctx, &request.body)?
            };
            let result = service.model.predict(&input.png, &input.region_id)?;
            let _operation = ctx.lock_operation()?;
            service.registry.resolve(&ctx.id)?;
            let current = sample_input(ctx, &request.body)?;
            if image_identity(&current.png)?.1 != image_identity(&input.png)?.1 {
                return Err(conflict("Crop changed while model inference was running"));
            }
            Ok(LabResponse::ok(
                json!({"prediction":prediction(ctx,&input,result)?}),
            ))
        })()),
        ("POST", "/api/review_label") => Some((|| {
            let input = sample_input(ctx, &request.body)?;
            let action = match request.body["action"].as_str().unwrap_or("corrected") {
                "accept" => "accepted",
                "correct" => "corrected",
                action => action,
            };
            let label = request
                .body
                .get("label")
                .map(|v| v.as_str().ok_or_else(|| bad("Label must be a string")))
                .transpose()?
                .unwrap_or("");
            let outside = request
                .body
                .get("allow_outside_contract")
                .map(|v| {
                    v.as_bool()
                        .ok_or_else(|| bad("allow_outside_contract must be a boolean"))
                })
                .transpose()?
                .unwrap_or(false);
            let event = review(
                ctx,
                &input,
                label,
                action,
                prediction_id(&request.body)?,
                outside,
            )?;
            let summary = if super::queue::initialized(ctx)? {
                super::queue::refresh_review(ctx, &input.key)?;
                super::queue::summary(ctx)?
            } else {
                Value::Null
            };
            Ok(LabResponse::ok(
                json!({"success":true,"event":event,"summary":summary}),
            ))
        })()),
        ("GET", "/api/label_history") => Some(
            history(ctx, request.query("sample_key"), request.query("filename"))
                .map(LabResponse::ok),
        ),
        _ => None,
    }
}

pub fn prediction_id(data: &Value) -> LabResult<Option<&str>> {
    data.get("prediction_id")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str().ok_or_else(|| {
                conflict("Prediction does not match this dataset, sample, or current crop")
            })
        })
        .transpose()
}
