use super::{
    bad, conflict, now_ms, python_json, sha256, uuid, LabRequest, LabResponse, LabResult,
    LabService,
};
use super::{datasets::DatasetContext, review};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub const MAX_PAGE: usize = 100;
pub const STREAM_WINDOW: usize = 61;
pub const METADATA_COLUMNS:&str="queue_id,sample_key,frame_id,source,region_id,phash,game_id,payload,pixel_sha256,created_at,active,reviewed,discarded,label,prediction_id";
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn index(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(default).max(0)
}
fn rows(conn: &Connection, sql: &str, params: Vec<SqlValue>) -> LabResult<Vec<Value>> {
    Ok(conn
        .prepare(sql)?
        .query_map(params_from_iter(params), review::row_json)?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn meta(conn: &Connection, key: &str, default: Value) -> LabResult<Value> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM queue_meta WHERE key=?", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or(default))
}
pub fn put_meta(conn: &Connection, key: &str, value: &Value) -> LabResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO queue_meta(key,value) VALUES(?,?)",
        params![key, value.to_string()],
    )?;
    Ok(())
}
pub fn bump(conn: &Connection) -> LabResult<()> {
    conn.execute("INSERT INTO queue_meta(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(())
}
pub fn sample_key(item: &Value, source: &str) -> String {
    item.get("sample_key")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}:{}:{}",
                text(item, "id"),
                text(item, "phash"),
                item.get("source")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| if source.is_empty() {
                        text(item, "game_id")
                    } else {
                        source
                    })
            )
        })
}
pub fn ensure(ctx: &DatasetContext) -> LabResult<()> {
    review::ensure(ctx)?;
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS queue_items(queue_id INTEGER PRIMARY KEY AUTOINCREMENT,sample_key TEXT UNIQUE NOT NULL,frame_id TEXT,source TEXT,region_id TEXT NOT NULL,phash TEXT,game_id TEXT,payload TEXT NOT NULL,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,reviewed INTEGER NOT NULL DEFAULT 0,discarded INTEGER NOT NULL DEFAULT 0,label TEXT NOT NULL DEFAULT '',prediction_id TEXT);
CREATE INDEX IF NOT EXISTS queue_active_id ON queue_items(active,queue_id);CREATE INDEX IF NOT EXISTS queue_region_hash ON queue_items(active,region_id,phash);CREATE INDEX IF NOT EXISTS queue_frame ON queue_items(frame_id,active);CREATE TABLE IF NOT EXISTS queue_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
    if conn
        .query_row(
            "SELECT 1 FROM queue_meta WHERE key='migration_v1'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some()
    {
        mark_initialized(ctx)?;
        return Ok(());
    }
    let tx = conn.transaction()?;
    let raw: Option<String> = tx
        .query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let session: Value = raw
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(json!({}));
    tx.execute(
        "INSERT OR IGNORE INTO queue_meta(key,value) VALUES('legacy_session_backup',?)",
        [session.to_string()],
    )?;
    let frames: BTreeMap<String, Value> = session["frames"]
        .as_array()
        .map(|f| {
            f.iter()
                .filter(|f| f.is_object())
                .map(|f| (text(f, "source").into(), f.clone()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(items) = session["pool"].as_array() {
        for item in items {
            ingest_conn(
                &tx,
                ctx,
                item,
                frames.get(text(item, "source")).unwrap_or(&Value::Null),
            )?;
        }
    }
    for frame in frames.values() {
        if let Some(items) = frame["regions"].as_array() {
            for item in items {
                ingest_conn(&tx, ctx, item, frame)?;
            }
        }
    }
    if tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name='watch_inbox'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some()
    {
        let frames: Vec<String> = tx
            .prepare("SELECT payload FROM watch_inbox ORDER BY created_at,frame_id")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for raw in frames {
            let frame: Value = serde_json::from_str(&raw)?;
            if let Some(items) = frame["regions"].as_array() {
                for item in items {
                    ingest_conn(&tx, ctx, item, &frame)?;
                }
            }
        }
    }
    let mut checkpoint = session.clone();
    let map = checkpoint
        .as_object_mut()
        .ok_or_else(|| bad("Session must be an object"))?;
    map.remove("frames");
    map.remove("pool");
    let current = index(&session, "currentReviewIdx", 0);
    let offset = current / 100 * 100;
    let keys:Vec<String>=tx.prepare("SELECT sample_key FROM queue_items WHERE active=1 ORDER BY queue_id LIMIT 100 OFFSET ?")?.query_map([offset],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM queue_items WHERE active=1", [], |r| {
        r.get(0)
    })?;
    let active = session["pool"].as_array().is_some_and(|p| !p.is_empty());
    checkpoint["queue_mode"] = json!("paged");
    checkpoint["frames"] = json!([]);
    checkpoint["pool"] = json!([]);
    checkpoint["currentReviewIdx"] = json!(current - offset);
    checkpoint["maxReachedIdx"] =
        json!((index(&session, "maxReachedIdx", current) - offset).max(0));
    checkpoint["review_batch"] = if active {
        json!({"batch_id":uuid(),"keys":keys,"legacy_offset":offset,"total_at_start":total})
    } else {
        Value::Null
    };
    put_meta(&tx, "checkpoint", &checkpoint)?;
    put_meta(&tx, "migration_v1", &json!(1))?;
    bump(&tx)?;
    tx.commit()?;
    mark_initialized(ctx)?;
    Ok(())
}
pub fn ingest_conn(
    conn: &Connection,
    ctx: &DatasetContext,
    item: &Value,
    frame: &Value,
) -> LabResult<()> {
    if !item.is_object() || text(item, "id").is_empty() {
        return Ok(());
    }
    let mut item = item.clone();
    if text(&item, "source").is_empty() {
        item["source"] = frame.get("source").cloned().unwrap_or(Value::Null);
    }
    if text(&item, "game_id").is_empty() {
        item["game_id"] = frame.get("game_id").cloned().unwrap_or(Value::Null);
    }
    let key = sample_key(&item, text(frame, "source"));
    if key.is_empty() || key.chars().count() > 512 {
        return Err(bad("Invalid queue sample identity"));
    }
    item["sample_key"] = json!(key);
    if conn
        .query_row(
            "SELECT 1 FROM queue_items WHERE sample_key=?",
            [&key],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    let encoded = item.as_object_mut().expect("object").remove("base64_image");
    let Some(encoded) = encoded else {
        return Ok(());
    };
    let encoded = encoded
        .as_str()
        .ok_or_else(|| bad("Expected bounded PNG crop bytes"))?;
    if encoded.len() > 16_000_000 {
        return Err(bad("Expected bounded PNG crop bytes"));
    }
    let raw = STANDARD.decode(encoded).map_err(|e| bad(e.to_string()))?;
    if raw.len() > 12_000_000
        || image::guess_format(&raw).map_err(|e| bad(e.to_string()))? != image::ImageFormat::Png
    {
        return Err(bad("Expected bounded PNG crop"));
    }
    let (_, pixels) = review::image_identity(&raw)?;
    let rid = text(&item, "id");
    let mut label = text(&item, "label").to_owned();
    let mut reviewed = item["reviewed"].as_bool().unwrap_or(false);
    let mut prediction_id = item["prediction_id"].as_str().map(str::to_owned);
    let event:Option<(String,Option<String>)>=conn.query_row("SELECT e.label,e.prediction_id FROM review_samples s JOIN label_review_events e ON e.sample_key=s.sample_key WHERE s.sample_key=? AND s.region_id=? AND s.pixel_sha256=? AND e.dataset_id=? AND e.pixel_sha256=? AND e.label=s.label ORDER BY e.id DESC LIMIT 1",params![key,rid,pixels,ctx.id,pixels],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((l, p)) = event {
        label = l;
        reviewed = true;
        prediction_id = p;
    }
    let frame_id = [
        item.get("frame_id"),
        item.get("watch_frame_id"),
        frame.get("id"),
        item.get("source"),
    ]
    .into_iter()
    .flatten()
    .find(|value| match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    })
    .map(|value| match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        _ => value.to_string(),
    })
    .unwrap_or_default();
    let watch =
        item["watch"].as_bool().unwrap_or(false) || frame["watch"].as_bool().unwrap_or(false);
    item["frame_id"] = json!(frame_id);
    item["watch"] = json!(watch);
    conn.execute("INSERT INTO queue_items(sample_key,frame_id,source,region_id,phash,game_id,payload,crop,pixel_sha256,created_at,reviewed,discarded,label,prediction_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![key,frame_id,item["source"].as_str(),text(&item,"id"),item["phash"].as_str(),item["game_id"].as_str(),item.to_string(),raw,pixels,now_ms(),i64::from(reviewed),i64::from(item["discarded"].as_bool().unwrap_or(false)),label,prediction_id])?;
    Ok(())
}
pub fn metadata(ctx: &DatasetContext, row: &Value) -> LabResult<Value> {
    let mut result: Value = serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Invalid queue payload"))?,
    )?;
    let map = result
        .as_object_mut()
        .ok_or_else(|| bad("Invalid queue payload"))?;
    map.remove("base64_image");
    for (field, column) in [
        ("queue_id", "queue_id"),
        ("sample_key", "sample_key"),
        ("id", "region_id"),
        ("frame_id", "frame_id"),
        ("source", "source"),
        ("phash", "phash"),
        ("game_id", "game_id"),
        ("label", "label"),
        ("prediction_id", "prediction_id"),
    ] {
        map.insert(field.into(), row[column].clone());
    }
    map.insert(
        "reviewed".into(),
        json!(row["reviewed"].as_i64().unwrap_or(0) != 0),
    );
    map.insert(
        "discarded".into(),
        json!(row["discarded"].as_i64().unwrap_or(0) != 0),
    );
    map.insert(
        "image_url".into(),
        json!(format!(
            "/api/queue/image/{}?dataset_id={}",
            row["queue_id"], ctx.id
        )),
    );
    Ok(result)
}
pub fn summary_conn(conn: &Connection) -> LabResult<Value> {
    let mut summary=conn.query_row("SELECT COUNT(*) total,COALESCE(SUM(reviewed=0 AND discarded=0),0) pending,COALESCE(SUM(reviewed=1),0) reviewed,COUNT(DISTINCT source) captures FROM queue_items WHERE active=1",[],review::row_json)?;
    let revision: Option<String> = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key='revision'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    summary["revision"] = json!(revision.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0));
    Ok(summary)
}
pub fn summary(ctx: &DatasetContext) -> LabResult<Value> {
    ensure(ctx)?;
    summary_conn(&*ctx.connection()?)
}
pub fn get_conn(
    conn: &Connection,
    key: Option<&str>,
    id: Option<i64>,
    include_crop: bool,
) -> LabResult<Option<Value>> {
    let columns = if include_crop { "*" } else { METADATA_COLUMNS };
    Ok(if let Some(key) = key {
        conn.query_row(
            &format!("SELECT {columns} FROM queue_items WHERE sample_key=? AND active=1"),
            [key],
            review::row_json,
        )
        .optional()?
    } else {
        conn.query_row(
            &format!("SELECT {columns} FROM queue_items WHERE queue_id=? AND active=1"),
            [id],
            review::row_json,
        )
        .optional()?
    })
}
fn cursor(ctx: &DatasetContext, value: Option<&str>, order: &str) -> LabResult<Option<i64>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let pieces: Vec<_> = value.split(':').collect();
    if pieces.len() != 3
        || pieces[0] != ctx.id
        || pieces[1] != order
        || pieces[2].is_empty()
        || !pieces[2].bytes().all(|b| b.is_ascii_digit())
    {
        return Err(bad("Invalid dataset queue cursor"));
    }
    Ok(Some(
        pieces[2]
            .parse()
            .map_err(|_| bad("Invalid dataset queue cursor"))?,
    ))
}
fn encode(ctx: &DatasetContext, id: &Value, order: &str) -> String {
    format!("{}:{order}:{}", ctx.id, id)
}
pub fn page(
    ctx: &DatasetContext,
    from: Option<&str>,
    limit: usize,
    order: &str,
) -> LabResult<Value> {
    ensure(ctx)?;
    if !(1..=100).contains(&limit) {
        return Err(bad("Page size must be between 1 and 100"));
    }
    if !["newest", "oldest"].contains(&order) {
        return Err(bad("Unsupported queue order"));
    }
    let boundary = cursor(ctx, from, order)?;
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    let comparison = if order == "newest" { "<" } else { ">" };
    let direction = if order == "newest" { "DESC" } else { "ASC" };
    let mut params = Vec::new();
    let where_clause = if let Some(boundary) = boundary {
        params.push(boundary.into());
        format!("active=1 AND queue_id {comparison} ?")
    } else {
        "active=1".into()
    };
    params.push(((limit + 1) as i64).into());
    let mut found=rows(&conn,&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE {where_clause} ORDER BY queue_id {direction} LIMIT ?"),params)?;
    let more = found.len() > limit;
    found.truncate(limit);
    let next = if more {
        found.last().map(|r| encode(ctx, &r["queue_id"], order))
    } else {
        None
    };
    let items: Vec<_> = found
        .iter()
        .map(|r| metadata(ctx, r))
        .collect::<LabResult<_>>()?;
    Ok(json!({"items":items,"next_cursor":next,"summary":summary_conn(&conn)?}))
}
pub fn stream_conn(
    conn: &Connection,
    ctx: &DatasetContext,
    id: &str,
    require_active: bool,
) -> LabResult<Value> {
    if id.is_empty() || id.chars().count() > 64 {
        return Err(bad("Review run identity is required"));
    }
    let run = meta(conn, &format!("stream:{id}"), Value::Null)?;
    if run.is_null() || run["dataset_id"] != ctx.id {
        return Err(bad("Review run does not belong to this dataset"));
    }
    if require_active && meta(conn, "active_stream", Value::Null)? != id {
        return Err(conflict("Review run changed; reload the current review"));
    }
    Ok(run)
}
pub fn stream(ctx: &DatasetContext, id: &str, require_active: bool) -> LabResult<Value> {
    ensure(ctx)?;
    stream_conn(&*ctx.connection()?, ctx, id, require_active)
}
pub fn stream_stats_conn(conn: &Connection, ctx: &DatasetContext, id: &str) -> LabResult<Value> {
    let run = stream_conn(conn, ctx, id, false)?;
    let receipt = meta(conn, &format!("stream_commit:{id}"), Value::Null)?;
    if !receipt.is_null() {
        return Ok(receipt["total_stats"].clone());
    }
    if run["state"] == "committing" && !run["total_stats"].is_null() {
        return Ok(run["total_stats"].clone());
    }
    let ceiling = run["ceiling"].as_i64().unwrap_or(0);
    let mut result=conn.query_row("SELECT COUNT(*) total,COALESCE(SUM(reviewed=1 AND discarded=0),0) reviewed,COALESCE(SUM(discarded=1),0) discarded,COALESCE(SUM(reviewed=0 AND discarded=0),0) pending FROM queue_items WHERE active=1 AND queue_id<=?",[ceiling],review::row_json)?;
    let times:Vec<Value>=rows(conn,"SELECT json_extract(payload,'$.labelTime') AS value FROM queue_items WHERE active=1 AND queue_id<=? AND reviewed=1 AND discarded=0 AND json_valid(payload)",vec![ceiling.into()])?;
    let times: Vec<f64> = times
        .iter()
        .filter_map(|v| v["value"].as_f64())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .collect();
    result["items"] = json!(times.len());
    result["time"] = json!(times.iter().sum::<f64>());
    result["complete"] = json!(result["pending"] == 0);
    Ok(result)
}
pub fn stream_stats(ctx: &DatasetContext, id: &str) -> LabResult<Value> {
    ensure(ctx)?;
    stream_stats_conn(&*ctx.connection()?, ctx, id)
}
pub fn refresh_review(ctx: &DatasetContext, key: &str) -> LabResult<()> {
    ensure(ctx)?;
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let pixels: Option<String> = tx
        .query_row(
            "SELECT pixel_sha256 FROM queue_items WHERE sample_key=? AND active=1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(pixels) = pixels {
        if let Some((label,prediction))=tx.query_row("SELECT label,prediction_id FROM label_review_events WHERE sample_key=? AND pixel_sha256=? AND dataset_id=? ORDER BY id DESC LIMIT 1",params![key,pixels,ctx.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?{tx.execute("UPDATE queue_items SET label=?,reviewed=1,discarded=0,prediction_id=? WHERE sample_key=?",params![label,prediction,key])?;bump(&tx)?;}
    }
    tx.commit()?;
    Ok(())
}
pub fn session(ctx: &DatasetContext) -> LabResult<Value> {
    ensure(ctx)?;
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    session_conn(&conn, ctx)
}
fn session_conn(conn: &Connection, ctx: &DatasetContext) -> LabResult<Value> {
    let mut checkpoint = meta(conn, "checkpoint", json!({}))?;
    let mut batch = checkpoint
        .get("review_batch")
        .cloned()
        .unwrap_or(Value::Null);
    if batch.is_null() {
        if let Some(id) = meta(conn, "active_stream", Value::Null)?.as_str() {
            if meta(conn, &format!("stream:{id}"), Value::Null)?["state"] == "committing" {
                return Ok(start_stream_conn(conn, ctx)?["session"].clone());
            }
        }
    }
    let keys: Vec<String> = batch["keys"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let old = index(&checkpoint, "currentReviewIdx", 0) as usize;
    let current = keys
        .get(old)
        .cloned()
        .or_else(|| checkpoint["current_sample_key"].as_str().map(str::to_owned));
    let mut found = Vec::new();
    for key in &keys {
        if let Some(row) = get_conn(conn, Some(key), None, false)? {
            found.push(row);
        }
    }
    if let Some(last) = found.last() {
        let ceiling = if batch["mode"] == "stream" {
            batch["ceiling"].as_i64()
        } else {
            None
        };
        let query = "SELECT 1 FROM queue_items WHERE active=1 AND queue_id>?";
        let more = if let Some(ceiling) = ceiling {
            conn.query_row(
                &format!("{query} AND queue_id<=? LIMIT 1"),
                params![last["queue_id"].as_i64(), ceiling],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        } else {
            conn.query_row(
                &format!("{query} LIMIT 1"),
                [last["queue_id"].as_i64()],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        };
        batch["next_cursor"] = if more {
            json!(encode(ctx, &last["queue_id"], "oldest"))
        } else {
            Value::Null
        };
    }
    let keys: Vec<_> = found.iter().map(|r| r["sample_key"].clone()).collect();
    if batch.is_object() {
        batch["keys"] = json!(keys);
    }
    let committing = if batch["mode"] == "stream" {
        stream_conn(conn, ctx, text(&batch, "batch_id"), false)?["state"] == "committing"
    } else {
        false
    };
    if batch["mode"] == "stream" {
        batch["committing"] = json!(committing);
    }
    checkpoint["queue_mode"] = json!("paged");
    checkpoint["frames"] = json!([]);
    checkpoint["pool"] = json!(found
        .iter()
        .map(|r| metadata(ctx, r))
        .collect::<LabResult<Vec<_>>>()?);
    checkpoint["review_batch"] = batch.clone();
    checkpoint["queue_summary"] = summary_conn(conn)?;
    if found.is_empty() && !committing {
        checkpoint["review_batch"] = Value::Null;
        checkpoint["labelingUnlocked"] = json!(false);
        checkpoint["reviewUnlocked"] = json!(false);
        checkpoint["currentView"] = json!("collection");
    }
    let current_index = current
        .as_ref()
        .and_then(|key| keys.iter().position(|v| v == key))
        .unwrap_or_else(|| old.min(found.len().saturating_sub(1)));
    checkpoint["currentReviewIdx"] = json!(current_index);
    checkpoint["current_sample_key"] = keys.get(current_index).cloned().unwrap_or(Value::Null);
    if batch["mode"] == "stream" {
        checkpoint["review_stats"] = stream_stats_conn(conn, ctx, text(&batch, "batch_id"))?;
    }
    let mut stored = checkpoint.clone();
    for key in ["pool", "frames", "queue_summary", "review_stats"] {
        stored
            .as_object_mut()
            .ok_or_else(|| bad("Invalid checkpoint"))?
            .remove(key);
    }
    put_meta(conn, "checkpoint", &stored)?;
    Ok(checkpoint)
}
pub fn save_checkpoint(
    ctx: &DatasetContext,
    value: &Value,
    replace_batch: bool,
) -> LabResult<Value> {
    ensure(ctx)?;
    if !value.is_object() {
        return Err(bad("Session must be an object"));
    }
    let items = value
        .get("pool")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_array()
                .ok_or_else(|| bad("Checkpoint pool is limited to 100 metadata items"))
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    if items.len() > 100 {
        return Err(bad("Checkpoint pool is limited to 100 metadata items"));
    }
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let prior = meta(&tx, "checkpoint", json!({}))?;
    let mut batch = value
        .get("review_batch")
        .cloned()
        .unwrap_or_else(|| prior.get("review_batch").cloned().unwrap_or(Value::Null));
    if !batch.is_null() && !batch.is_object() {
        return Err(bad("Review batch must be an object or null"));
    }
    let mut keys: Vec<String> = match batch.get("keys") {
        None => vec![],
        Some(v) => v
            .as_array()
            .ok_or_else(|| bad("Review batch must contain at most 100 keys"))?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| bad("Review batch must contain at most 100 keys"))
            })
            .collect::<LabResult<_>>()?,
    };
    if keys.len() > 100 {
        return Err(bad("Review batch must contain at most 100 keys"));
    }
    if !replace_batch && batch["batch_id"] != prior["review_batch"]["batch_id"] {
        return Err(conflict("Review batch changed; reload the current batch"));
    }
    if batch["mode"] == "stream" {
        let run = stream_conn(&tx, ctx, text(&batch, "batch_id"), true)?;
        if keys.len() > 61 {
            return Err(bad("Continuous review retains at most 61 metadata items"));
        }
        if items.len() > 61 {
            return Err(bad(
                "Continuous checkpoint retains at most 61 metadata items",
            ));
        }
        if let Some(sequence) = value.get("checkpoint_sequence") {
            let sequence = sequence
                .as_u64()
                .ok_or_else(|| bad("Invalid checkpoint sequence"))?;
            if !replace_batch
                && prior["checkpoint_sequence"]
                    .as_u64()
                    .is_some_and(|old| sequence <= old)
            {
                tx.commit()?;
                return session_conn(&conn, ctx);
            }
        }
        if !keys.is_empty() {
            let mut found = BTreeMap::new();
            for key in &keys {
                if let Some(row) = get_conn(&tx, Some(key), None, false)? {
                    let id = row["queue_id"].as_i64().unwrap_or(0);
                    if id > run["ceiling"].as_i64().unwrap_or(0) {
                        return Err(bad("Crop is outside this review run"));
                    }
                    found.insert(key.clone(), id);
                }
            }
            keys.retain(|key| found.contains_key(key));
            let ids: Vec<_> = keys.iter().map(|k| found[k]).collect();
            let sorted: Vec<_> = found
                .values()
                .copied()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            if ids != sorted {
                return Err(bad("Review window must retain queue order"));
            }
            let offset = if let Some(first) = ids.first() {
                tx.query_row(
                    "SELECT COUNT(*) FROM queue_items WHERE active=1 AND queue_id<?",
                    [first],
                    |r| r.get::<_, i64>(0),
                )?
            } else {
                0
            };
            batch["keys"] = json!(keys);
            batch["ceiling"] = run["ceiling"].clone();
            batch["total_at_start"] = run["total_at_start"].clone();
            batch["legacy_offset"] = json!(offset);
        }
    }
    let mut checkpoint = prior.clone();
    let map = checkpoint
        .as_object_mut()
        .ok_or_else(|| bad("Invalid checkpoint"))?;
    for (key, value) in value.as_object().expect("checked object") {
        if !["frames", "pool", "queue_summary"].contains(&key.as_str()) {
            map.insert(key.clone(), value.clone());
        }
    }
    checkpoint["queue_mode"] = json!("paged");
    checkpoint["frames"] = json!([]);
    checkpoint["pool"] = json!([]);
    checkpoint["review_batch"] = batch;
    if let Some(awards) = checkpoint.get_mut("reviewAwards") {
        let awards = awards
            .as_object_mut()
            .ok_or_else(|| bad("Review awards must be an object"))?;
        awards.retain(|key, _| keys.contains(key));
    }
    let mut changed = false;
    for item in items {
        if !item.is_object() {
            return Err(bad("Invalid checkpoint item"));
        }
        let key = text(&item, "sample_key");
        if let Some(row) = get_conn(&tx, Some(key), None, false)? {
            let mut payload: Value = serde_json::from_str(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Invalid queue payload"))?,
            )?;
            for field in ["review_clock", "review_reward", "labelTime"] {
                if let Some(value) = item.get(field) {
                    payload[field] = value.clone();
                }
            }
            tx.execute(
                "UPDATE queue_items SET payload=? WHERE sample_key=? AND active=1",
                params![payload.to_string(), key],
            )?;
            if let Some(discarded) = item["discarded"].as_bool() {
                changed|=tx.execute("UPDATE queue_items SET discarded=? WHERE sample_key=? AND active=1 AND discarded!=?",params![i64::from(discarded),key,i64::from(discarded)])?>0;
            }
        }
    }
    if changed {
        bump(&tx)?;
    }
    put_meta(&tx, "checkpoint", &checkpoint)?;
    tx.commit()?;
    session_conn(&conn, ctx)
}
pub fn start_stream(ctx: &DatasetContext) -> LabResult<Value> {
    ensure(ctx)?;
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    start_stream_conn(&conn, ctx)
}
fn start_stream_conn(conn: &Connection, ctx: &DatasetContext) -> LabResult<Value> {
    let mut checkpoint = meta(&conn, "checkpoint", json!({}))?;
    let active = meta(&conn, "active_stream", Value::Null)?;
    let mut run = if let Some(id) = active.as_str() {
        meta(&conn, &format!("stream:{id}"), Value::Null)?
    } else {
        Value::Null
    };
    if run["state"] == "committing" {
        checkpoint = run.get("checkpoint").cloned().unwrap_or(checkpoint);
    }
    let old_batch = checkpoint
        .get("review_batch")
        .cloned()
        .unwrap_or(Value::Null);
    let any = if run.is_null() {
        false
    } else {
        conn.query_row(
            "SELECT 1 FROM queue_items WHERE active=1 AND queue_id<=? LIMIT 1",
            [run["ceiling"].as_i64()],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some()
    };
    if run.is_null() || run["state"] == "finished" || (run["state"] != "committing" && !any) {
        let ceiling: i64 = conn.query_row(
            "SELECT COALESCE(MAX(queue_id),0) FROM queue_items WHERE active=1",
            [],
            |r| r.get(0),
        )?;
        run = json!({"batch_id":uuid(),"dataset_id":ctx.id,"state":"active","ceiling":ceiling,"total_at_start":summary_conn(&conn)?["total"]});
    }
    let id = text(&run, "batch_id").to_owned();
    let old_index = index(&checkpoint, "currentReviewIdx", 0);
    let keys = old_batch["keys"].as_array().cloned().unwrap_or_default();
    let current_key = checkpoint
        .get("current_sample_key")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| keys.get(old_index as usize).cloned());
    let ceiling = run["ceiling"].as_i64().unwrap_or(0);
    let mut current = if let Some(key) = current_key.as_ref().and_then(Value::as_str) {
        get_conn(&conn, Some(key), None, false)?
            .filter(|row| row["queue_id"].as_i64().unwrap_or(i64::MAX) <= ceiling)
    } else {
        None
    };
    if current.is_none() {
        current=conn.query_row(&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE active=1 AND queue_id<=? ORDER BY queue_id LIMIT 1"),[ceiling],review::row_json).optional()?;
    }
    let mut found = Vec::new();
    let mut local = 0;
    let mut current_sample = Value::Null;
    if let Some(current) = current {
        current_sample = current["sample_key"].clone();
        let current_id = current["queue_id"].as_i64().unwrap_or(0);
        let mut before=rows(&conn,&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE active=1 AND queue_id<? ORDER BY queue_id DESC LIMIT 50"),vec![current_id.into()])?;
        before.reverse();
        local = before.len() as i64;
        found.extend(before);
        found.push(current);
        found.extend(rows(&conn,&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE active=1 AND queue_id>? AND queue_id<=? ORDER BY queue_id LIMIT 10"),vec![current_id.into(),ceiling.into()])?);
    }
    let offset = if let Some(first) = found.first() {
        conn.query_row(
            "SELECT COUNT(*) FROM queue_items WHERE active=1 AND queue_id<?",
            [first["queue_id"].as_i64()],
            |r| r.get::<_, i64>(0),
        )?
    } else {
        0
    };
    let last = found
        .last()
        .map(|r| r["queue_id"].as_i64().unwrap_or(0))
        .unwrap_or(0);
    let more = conn
        .query_row(
            "SELECT 1 FROM queue_items WHERE active=1 AND queue_id>? AND queue_id<=? LIMIT 1",
            params![last, ceiling],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    let committing = run["state"] == "committing";
    let batch = json!({"batch_id":id,"ceiling":ceiling,"total_at_start":run["total_at_start"],"mode":"stream","keys":found.iter().map(|r|r["sample_key"].clone()).collect::<Vec<_>>(),"legacy_offset":offset,"next_cursor":if more{Some(format!("{}:oldest:{last}",ctx.id))}else{None},"committing":committing});
    checkpoint["queue_mode"] = json!("paged");
    checkpoint["frames"] = json!([]);
    checkpoint["pool"] = json!([]);
    checkpoint["review_batch"] = if !found.is_empty() || committing {
        batch.clone()
    } else {
        Value::Null
    };
    checkpoint["currentReviewIdx"] = json!(local);
    checkpoint["maxReachedIdx"] = json!(local.max(
        (found.len() as i64 - 1)
            .min(index(&checkpoint, "maxReachedIdx", local) - (old_index - local).max(0))
    ));
    checkpoint["current_sample_key"] = current_sample;
    checkpoint["labelingUnlocked"] = json!(!found.is_empty());
    checkpoint["reviewUnlocked"] = json!(committing && found.is_empty());
    checkpoint["currentView"] = json!(if !found.is_empty() {
        "labeling"
    } else if committing {
        "session-review"
    } else {
        "collection"
    });
    if found.is_empty() && !committing {
        run["state"] = json!("finished");
    }
    put_meta(&conn, &format!("stream:{id}"), &run)?;
    put_meta(&conn, "active_stream", &json!(id))?;
    put_meta(&conn, "checkpoint", &checkpoint)?;
    let session = session_conn(&conn, ctx)?;
    Ok(
        json!({"session":session,"items":session["pool"],"review_batch":session["review_batch"],"summary":summary_conn(&conn)?,"review_stats":stream_stats_conn(&conn,ctx,&id)?}),
    )
}
pub fn stream_next(
    ctx: &DatasetContext,
    id: &str,
    from: Option<&str>,
    limit: usize,
) -> LabResult<Value> {
    ensure(ctx)?;
    if !(1..=10).contains(&limit) {
        return Err(bad("Prefetch size must be between 1 and 10"));
    }
    let boundary = cursor(ctx, from, "oldest")?.unwrap_or(0);
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    let run = stream_conn(&conn, ctx, id, true)?;
    let mut found=rows(&conn,&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE active=1 AND queue_id>? AND queue_id<=? ORDER BY queue_id LIMIT ?"),vec![boundary.into(),run["ceiling"].as_i64().unwrap_or(0).into(),((limit+1)as i64).into()])?;
    let more = found.len() > limit;
    found.truncate(limit);
    let items = found
        .iter()
        .map(|row| metadata(ctx, row))
        .collect::<LabResult<Vec<_>>>()?;
    Ok(
        json!({"items":items,"next_cursor":if more{found.last().map(|r|encode(ctx,&r["queue_id"],"oldest"))}else{None},"review_stats":stream_stats_conn(&conn,ctx,id)?,"summary":summary_conn(&conn)?}),
    )
}
pub fn review_page(ctx: &DatasetContext, from: Option<&str>, limit: usize) -> LabResult<Value> {
    let mut page = page(ctx, from, limit, "oldest")?;
    let boundary = cursor(ctx, from, "oldest")?.unwrap_or(0);
    let offset = ctx.connection()?.query_row(
        "SELECT COUNT(*) FROM queue_items WHERE active=1 AND queue_id<=?",
        [boundary],
        |r| r.get::<_, i64>(0),
    )?;
    let items = page["items"].as_array().expect("page items");
    let complete = !items.is_empty()
        && items
            .iter()
            .all(|item| item["reviewed"] == true || item["discarded"] == true);
    let nonempty = !items.is_empty();
    page["review_batch"] = if nonempty {
        json!({"batch_id":uuid(),"keys":items.iter().map(|r|r["sample_key"].clone()).collect::<Vec<_>>(),"cursor":from,"next_cursor":page["next_cursor"],"legacy_offset":offset,"total_at_start":page["summary"]["total"]})
    } else {
        Value::Null
    };
    save_checkpoint(
        ctx,
        &json!({"queue_mode":"paged","review_batch":page["review_batch"],"currentReviewIdx":0,"maxReachedIdx":0,"labelingUnlocked":nonempty&&!complete,"reviewUnlocked":complete,"currentView":if complete{"session-review"}else{"labeling"}}),
        true,
    )?;
    Ok(page)
}
pub fn review_items(
    ctx: &DatasetContext,
    id: &str,
    from: Option<&str>,
    limit: usize,
    search: &str,
    filter: &str,
) -> LabResult<Value> {
    ensure(ctx)?;
    if !(1..=100).contains(&limit) {
        return Err(bad("Review page size must be between 1 and 100"));
    }
    if search.chars().count() > 200 {
        return Err(bad("Review search must contain at most 200 characters"));
    }
    let search = search.trim();
    let predicate = match filter {
        "all" | "ai_flagged" | "ai_corrected" => "1",
        "reviewed" => "reviewed=1 AND discarded=0",
        "blank" => "reviewed=1 AND discarded=0 AND label=''",
        "pending" => "reviewed=0 AND discarded=0",
        "discarded" => "discarded=1",
        _ => return Err(bad("Unsupported review filter")),
    };
    let hash = sha256(python_json(&json!([search, filter]), true)?.as_bytes());
    let prefix = format!("{}:review:{id}:{}:", ctx.id, &hash[..16]);
    let boundary = if let Some(cursor) = from.filter(|v| !v.is_empty()) {
        if cursor.chars().count() > 512 || !cursor.starts_with(&prefix) {
            return Err(bad(
                "Review cursor does not match this dataset, run, or query",
            ));
        }
        let raw = &cursor[prefix.len()..];
        if raw.is_empty() || raw.len() > 19 || !raw.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad("Invalid review cursor"));
        }
        Some(
            raw.parse::<i64>()
                .map_err(|_| bad("Invalid review cursor"))?,
        )
    } else {
        None
    };
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    let run = stream_conn(&conn, ctx, id, true)?;
    let ceiling = run["ceiling"].as_i64().unwrap_or(0);
    if boundary.is_some_and(|n| n > ceiling) {
        return Err(bad("Review cursor is outside this run"));
    }
    let mut where_clause = format!("active=1 AND queue_id<=? AND ({predicate})");
    let mut params = vec![SqlValue::Integer(ceiling)];
    if ["ai_flagged", "ai_corrected"].contains(&filter) {
        if conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_review_items'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_none()
        {
            where_clause.push_str(" AND 0");
        } else {
            let outcomes = if filter == "ai_flagged" {
                "'flagged','conflict'"
            } else {
                "'corrected'"
            };
            where_clause.push_str(&format!(" AND EXISTS(SELECT 1 FROM ai_review_items ai WHERE ai.sample_key=queue_items.sample_key AND ai.state IN ({outcomes}) AND ai.job_id=(SELECT id FROM ai_review_jobs WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1))"));
            params.push(id.to_owned().into());
        }
    }
    if !search.is_empty() {
        where_clause.push_str(
            " AND (instr(lower(region_id),lower(?))>0 OR instr(lower(label),lower(?))>0)",
        );
        params.push(search.to_owned().into());
        params.push(search.to_owned().into());
    }
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM queue_items WHERE {where_clause}"),
        params_from_iter(&params),
        |r| r.get(0),
    )?;
    if let Some(boundary) = boundary {
        where_clause.push_str(" AND queue_id>?");
        params.push(boundary.into());
    }
    params.push(((limit + 1) as i64).into());
    let mut found=rows(&conn,&format!("SELECT {METADATA_COLUMNS} FROM queue_items WHERE {where_clause} ORDER BY queue_id LIMIT ?"),params)?;
    let more = found.len() > limit;
    found.truncate(limit);
    let items = found
        .iter()
        .map(|r| metadata(ctx, r))
        .collect::<LabResult<Vec<_>>>()?;
    Ok(
        json!({"items":items,"next_cursor":if more{found.last().map(|r|format!("{prefix}{}",r["queue_id"]))}else{None},"total":total,"review_stats":stream_stats_conn(&conn,ctx,id)?,"summary":summary_conn(&conn)?,"run_id":id}),
    )
}
pub fn discard(
    ctx: &DatasetContext,
    keys: &[String],
    frames: &[String],
    clear: bool,
) -> LabResult<Value> {
    ensure(ctx)?;
    if keys.len() > 100 || frames.len() > 100 {
        return Err(bad("Bounded queue selectors required"));
    }
    if !clear && keys.is_empty() && frames.is_empty() {
        return Err(bad("Select queue records to discard"));
    }
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    if clear {
        tx.execute("UPDATE queue_items SET active=0 WHERE active=1", [])?;
        put_meta(&tx, "active_stream", &Value::Null)?;
    }
    for key in keys {
        tx.execute("UPDATE queue_items SET active=0 WHERE sample_key=?", [key])?;
    }
    for frame in frames {
        tx.execute("UPDATE queue_items SET active=0 WHERE frame_id=?", [frame])?;
    }
    bump(&tx)?;
    tx.commit()?;
    summary_conn(&conn)
}
fn commit_identity(ctx: &DatasetContext, keys: &[String]) -> LabResult<(Vec<String>, String)> {
    if keys.is_empty() || keys.len() > 100 {
        return Err(bad("Commit selects 1 to 100 queue keys"));
    }
    let keys: Vec<String> = keys
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let id = sha256(python_json(&json!([ctx.id, keys]), true)?.as_bytes());
    Ok((keys, id))
}
pub fn receipt(ctx: &DatasetContext, keys: &[String]) -> LabResult<Option<Value>> {
    ensure(ctx)?;
    let (_, id) = commit_identity(ctx, keys)?;
    let result = meta(&*ctx.connection()?, &format!("commit:{id}"), Value::Null)?;
    Ok((!result.is_null()).then_some(result))
}
pub fn commit(ctx: &DatasetContext, keys: &[String]) -> LabResult<Value> {
    ensure(ctx)?;
    let (keys, id) = commit_identity(ctx, keys)?;
    if let Some(receipt) = receipt(ctx, &keys)? {
        return Ok(receipt);
    }
    let mut prepared = Vec::new();
    {
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        for key in &keys {
            let row = get_conn(&conn, Some(key), None, true)?
                .ok_or_else(|| bad("Queue sample is no longer active"))?;
            if row["discarded"] == 1 {
                continue;
            }
            if row["reviewed"] != 1 {
                return Err(bad("Only reviewed queue samples can be committed"));
            }
            let image = STANDARD
                .decode(row["crop"].as_str().unwrap_or(""))
                .map_err(|e| bad(e.to_string()))?;
            prepared.push((metadata(ctx, &row)?, image, text(&row, "phash").to_owned()));
        }
    }
    let filenames = if prepared.is_empty() {
        vec![]
    } else {
        review::commit(ctx, &prepared)?
    };
    let receipt = json!({"id":id,"sample_keys":keys,"filenames":filenames});
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    let mut checkpoint = meta(&tx, "checkpoint", json!({}))?;
    let fields = json!({"queue_mode":"paged","review_batch":null,"frames":[],"pool":[],"currentReviewIdx":0,"maxReachedIdx":0,"current_sample_key":null,"labelingUnlocked":false,"reviewUnlocked":false,"currentView":"collection"});
    checkpoint
        .as_object_mut()
        .ok_or_else(|| bad("Invalid checkpoint"))?
        .extend(fields.as_object().expect("object").clone());
    for key in &keys {
        tx.execute("UPDATE queue_items SET active=0 WHERE sample_key=?", [key])?;
    }
    tx.execute(
        "INSERT INTO queue_meta(key,value) VALUES(?,?)",
        params![format!("commit:{id}"), receipt.to_string()],
    )?;
    put_meta(&tx, "checkpoint", &checkpoint)?;
    tx.execute(
        "INSERT OR REPLACE INTO session_progress(id,data) VALUES(1,?)",
        [checkpoint.to_string()],
    )?;
    bump(&tx)?;
    tx.commit()?;
    Ok(receipt)
}
pub fn commit_stream(ctx: &DatasetContext, id: &str) -> LabResult<Value> {
    ensure(ctx)?;
    let mut run;
    let stats;
    {
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        let old = meta(&conn, &format!("stream_commit:{id}"), Value::Null)?;
        if !old.is_null() {
            return Ok(old);
        }
        run = stream_conn(&conn, ctx, id, true)?;
        stats = stream_stats_conn(&conn, ctx, id)?;
        if stats["pending"] != 0 {
            return Err(bad("Finish reviewing all queued crops before saving"));
        }
        if run["total_stats"].is_null() {
            run["total_stats"] = stats.clone();
        }
        if run["state"] != "committing" {
            run["checkpoint"] = meta(&conn, "checkpoint", json!({}))?;
        }
        run["state"] = json!("committing");
        put_meta(&conn, &format!("stream:{id}"), &run)?;
    }
    loop {
        let keys: Vec<String> = {
            let conn = ctx.connection()?;
            ctx.ensure_active()?;
            let result=conn.prepare("SELECT sample_key FROM queue_items WHERE active=1 AND queue_id<=? ORDER BY queue_id LIMIT 100")?.query_map([run["ceiling"].as_i64()],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
            result
        };
        if keys.is_empty() {
            break;
        }
        commit(ctx, &keys)?;
    }
    let total = run.get("total_stats").cloned().unwrap_or(stats);
    let receipt = json!({"id":format!("stream:{id}"),"run_id":id,"committed":total["total"],"total_stats":total});
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    let tx = conn.transaction()?;
    put_meta(&tx, &format!("stream_commit:{id}"), &receipt)?;
    run["state"] = json!("finished");
    run["total_stats"] = total;
    put_meta(&tx, &format!("stream:{id}"), &run)?;
    put_meta(&tx, "active_stream", &Value::Null)?;
    tx.commit()?;
    Ok(receipt)
}
pub fn frame_metadata(ctx: &DatasetContext, frame: &Value) -> LabResult<Value> {
    ensure(ctx)?;
    let mut result = frame.clone();
    let object = result.as_object_mut().ok_or_else(|| bad("Invalid frame"))?;
    for field in ["regions", "thumb", "thumbnail"] {
        object.remove(field);
    }
    let mut found = Vec::new();
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    if let Some(items) = frame["regions"].as_array() {
        for item in items {
            let key = sample_key(item, text(frame, "source"));
            if let Some(row) = get_conn(&conn, Some(&key), None, false)? {
                found.push(metadata(ctx, &row)?);
            }
        }
    }
    result["regions"] = json!(found);
    Ok(result)
}
pub fn ingest_frame(ctx: &DatasetContext, frame: &Value) -> LabResult<Value> {
    ensure(ctx)?;
    {
        let mut conn = ctx.connection()?;
        ctx.ensure_active()?;
        let tx = conn.transaction()?;
        if let Some(items) = frame["regions"].as_array() {
            for item in items {
                ingest_conn(&tx, ctx, item, frame)?;
            }
        }
        bump(&tx)?;
        tx.commit()?;
    }
    frame_metadata(ctx, frame)
}
pub fn selectors(value: &Value, field: &str, maximum: usize) -> LabResult<Vec<String>> {
    match value.get(field) {
        None => Ok(vec![]),
        Some(value) => {
            let values = value
                .as_array()
                .filter(|a| a.len() <= maximum)
                .ok_or_else(|| bad("Bounded queue selectors required"))?;
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| bad("Queue selectors must be lists"))
                })
                .collect()
        }
    }
}
fn idle(service: &LabService, ctx: &DatasetContext) -> LabResult<()> {
    if service.ai_review.is_busy(ctx)? {
        return Err(conflict("Pause AI review before saving this collection"));
    }
    Ok(())
}
pub fn handle(
    service: &LabService,
    ctx: &Arc<DatasetContext>,
    request: &LabRequest,
) -> Option<LabResult<LabResponse>> {
    let id = request.query("run_id").unwrap_or("");
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/queue") => Some((|| {
            Ok(LabResponse::ok(page(
                ctx,
                request.query("cursor"),
                request.number("limit", 60)?,
                request.query("order").unwrap_or("newest"),
            )?))
        })()),
        ("GET", "/api/queue/review") => Some((|| {
            Ok(LabResponse::ok(review_page(
                ctx,
                request.query("cursor"),
                request.number("limit", 100)?,
            )?))
        })()),
        ("POST", "/api/queue/review/start") => Some((|| {
            service.watch.stop(&ctx.id, None)?;
            Ok(LabResponse::ok(start_stream(ctx)?))
        })()),
        ("GET", "/api/queue/review/next") => Some((|| {
            Ok(LabResponse::ok(stream_next(
                ctx,
                id,
                request.query("cursor"),
                request.number("limit", 10)?,
            )?))
        })()),
        ("GET", "/api/queue/review/stats") => Some((|| {
            Ok(LabResponse::ok(
                json!({"review_stats":stream_stats(ctx,id)?,"summary":summary(ctx)?}),
            ))
        })()),
        ("GET", "/api/queue/review/items") => Some((|| {
            Ok(LabResponse::ok(review_items(
                ctx,
                id,
                request.query("cursor"),
                request.number("limit", 60)?,
                request.query("search").unwrap_or(""),
                request.query("filter").unwrap_or("all"),
            )?))
        })()),
        ("POST", "/api/queue/review/metadata") => Some((|| {
            ensure(ctx)?;
            let keys = selectors(&request.body, "sample_keys", 100)?;
            if keys.iter().any(|key| key.chars().count() > 512) {
                return Err(bad("Expected at most 100 sample keys"));
            }
            let id = text(&request.body, "run_id");
            let conn = ctx.connection()?;
            ctx.ensure_active()?;
            let run = stream_conn(&conn, ctx, id, true)?;
            let mut items = Vec::new();
            for key in keys.into_iter().collect::<BTreeSet<_>>() {
                if let Some(row) = get_conn(&conn, Some(&key), None, false)? {
                    if row["queue_id"].as_i64().unwrap_or(i64::MAX)
                        <= run["ceiling"].as_i64().unwrap_or(0)
                    {
                        items.push(metadata(ctx, &row)?);
                    }
                }
            }
            Ok(LabResponse::ok(
                json!({"items":items,"summary":summary_conn(&conn)?,"review_stats":stream_stats_conn(&conn,ctx,id)?}),
            ))
        })()),
        ("POST", "/api/queue/review/commit") => Some((|| {
            idle(service, ctx)?;
            service.watch.stop(&ctx.id, None)?;
            let receipt = commit_stream(ctx, text(&request.body, "run_id"))?;
            Ok(LabResponse::ok(
                json!({"success":true,"commit_receipt":receipt,"summary":summary(ctx)?}),
            ))
        })()),
        ("POST", "/api/queue/commit") => Some((|| {
            idle(service, ctx)?;
            let keys = selectors(&request.body, "sample_keys", 100)?;
            let receipt = if let Some(receipt) = receipt(ctx, &keys)? {
                receipt
            } else {
                service.watch.stop(&ctx.id, None)?;
                commit(ctx, &keys)?
            };
            Ok(LabResponse::ok(
                json!({"success":true,"filenames":receipt["filenames"],"commit_receipt":receipt,"summary":summary(ctx)?}),
            ))
        })()),
        ("POST", "/api/queue/discard") => Some((|| {
            let clear = request
                .body
                .get("clear")
                .map(|v| v.as_bool().ok_or_else(|| bad("clear must be boolean")))
                .transpose()?
                .unwrap_or(false);
            if clear {
                service.watch.stop(&ctx.id, None)?;
            }
            let summary = discard(
                ctx,
                &selectors(&request.body, "sample_keys", 100)?,
                &selectors(&request.body, "frame_ids", 100)?,
                clear,
            )?;
            if clear {
                save_checkpoint(
                    ctx,
                    &json!({"queue_mode":"paged","review_batch":null,"currentReviewIdx":0,"maxReachedIdx":0,"labelingUnlocked":false,"reviewUnlocked":false,"currentView":"collection"}),
                    true,
                )?;
            }
            Ok(LabResponse::ok(json!({"success":true,"summary":summary})))
        })()),
        _ if request.method == "GET" && request.path.starts_with("/api/queue/image/") => {
            Some((|| {
                ensure(ctx)?;
                let id = request
                    .path
                    .trim_start_matches("/api/queue/image/")
                    .parse::<i64>()
                    .map_err(|_| bad("Invalid queue identity"))?;
                let conn = ctx.connection()?;
                ctx.ensure_active()?;
                let png: Option<Vec<u8>> = conn
                    .query_row(
                        "SELECT crop FROM queue_items WHERE queue_id=? AND active=1",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let png = png.ok_or_else(|| super::not_found("Queued crop no longer exists"))?;
                Ok(LabResponse::binary(&png, "image/png"))
            })())
        }
        _ => None,
    }
}

pub fn initialized(ctx: &DatasetContext) -> LabResult<bool> {
    Ok(ctx
        .state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?["_disk_queue"]
        == true)
}
fn mark_initialized(ctx: &DatasetContext) -> LabResult<()> {
    ctx.state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?["_disk_queue"] = json!(true);
    Ok(())
}
