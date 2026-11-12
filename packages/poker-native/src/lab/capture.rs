use super::{
    bad, conflict, now_ms, python_json, sha256, unavailable, uuid, LabRequest, LabResponse,
    LabResult, LabService,
};
use super::{
    datasets::{self, DatasetContext},
    gameplay::NativeCapture,
    queue, review,
};
use crate::{media, types::Rect};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::DynamicImage;
use rusqlite::{params, OptionalExtension};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::Arc,
};

#[derive(Clone)]
pub struct CaptureConfig {
    pub regions: Value,
    pub colors: Value,
    pub hash: String,
    pub order: Vec<(String, Value)>,
}
pub struct CaptureService {
    root: PathBuf,
    provider: NativeCapture,
    media_root: PathBuf,
}
#[derive(Debug)]
enum Ordered {
    Map(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Leaf(Value),
}
impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON config")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry()? {
                    fields.push(field);
                }
                Ok(Ordered::Map(fields))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Ordered, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Ordered::Array(values))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(json!(v)))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(json!(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Ordered, E> {
                Ok(Ordered::Leaf(Value::Null))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Ordered, E> {
                self.visit_unit()
            }
        }
        deserializer.deserialize_any(V)
    }
}
impl Ordered {
    fn value(&self) -> Value {
        match self {
            Self::Leaf(v) => v.clone(),
            Self::Array(a) => json!(a.iter().map(Self::value).collect::<Vec<_>>()),
            Self::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.value())).collect()),
        }
    }
}
fn ordered_regions(node: &Ordered, id: &str, out: &mut Vec<(String, Value)>) -> LabResult<()> {
    match node {
        Ordered::Map(fields) => {
            if fields.iter().any(|(key, _)| key == "x") {
                out.push((id.into(), node.value()));
            } else {
                for (key, value) in fields {
                    let next = if id.is_empty() {
                        key.clone()
                    } else {
                        format!("{id}.{key}")
                    };
                    ordered_regions(value, &next, out)?;
                }
            }
        }
        Ordered::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                ordered_regions(value, &format!("{id}[{index}]"), out)?;
            }
        }
        Ordered::Leaf(_) => {}
    }
    Ok(())
}
impl CaptureService {
    pub fn new(root: PathBuf) -> LabResult<Self> {
        Self::with_environment(root, std::env::vars().collect())
    }
    pub fn with_environment(
        root: PathBuf,
        environment: HashMap<String, String>,
    ) -> LabResult<Self> {
        let media = root.parent().unwrap_or(&root).join("screenshots");
        Self::with_paths(root, media, environment)
    }
    pub fn with_paths(
        root: PathBuf,
        media_root: PathBuf,
        environment: HashMap<String, String>,
    ) -> LabResult<Self> {
        fs::create_dir_all(&root)?;
        datasets::plain(&root)?;
        for (name, contents) in [
            (
                "regions.json",
                include_bytes!("../../assets/regions.json").as_slice(),
            ),
            (
                "colors.json",
                include_bytes!("../../assets/colors.json").as_slice(),
            ),
        ] {
            let path = root.join(name);
            if !path.exists() {
                fs::write(&path, contents)?;
            } else {
                datasets::plain(&path)?;
            }
        }
        let repo = environment
            .get("POKER_LAB_TOOLS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"));
        Ok(Self {
            root,
            media_root,
            provider: NativeCapture::new(repo, environment),
        })
    }
    pub fn config(&self) -> LabResult<CaptureConfig> {
        let regions = fs::read(self.root.join("regions.json"))?;
        let ordered: Ordered = serde_json::from_slice(&regions)?;
        let regions = ordered.value();
        let colors: Value = serde_json::from_slice(&fs::read(self.root.join("colors.json"))?)?;
        let hash = sha256(python_json(&json!([regions, colors]), false)?.as_bytes());
        let mut order = Vec::new();
        ordered_regions(&ordered, "", &mut order)?;
        Ok(CaptureConfig {
            regions,
            colors,
            hash,
            order,
        })
    }
    pub fn sources(&self) -> LabResult<Value> {
        Ok(json!(self.provider.sources().map_err(unavailable)?))
    }
    pub fn require_source(&self, name: &str) -> LabResult<()> {
        if name.is_empty() || name.chars().count() > 200 {
            return Err(bad("A capture source is required"));
        }
        if name.starts_with("window:") {
            let sources = self.provider.sources().map_err(unavailable)?;
            if !sources
                .iter()
                .any(|s| s["name"] == name && s["kind"] == "window")
            {
                return Err(conflict("Selected window is no longer available. Refresh capture sources and select it again."));
            }
        }
        Ok(())
    }
    pub fn image(
        &self,
        name: &str,
        config: &CaptureConfig,
        validate_dimensions: bool,
    ) -> LabResult<DynamicImage> {
        self.require_source(name)?;
        let png = self.provider.capture(name).map_err(unavailable)?;
        let image = media::decode_image(&png).map_err(unavailable)?;
        if name.starts_with("window:") {
            self.require_source(name)?;
            let width = config.regions["screen_width"].as_u64().unwrap_or(1920);
            let height = config.regions["screen_height"].as_u64().unwrap_or(1080);
            if validate_dimensions
                && (u64::from(image.width()) != width || u64::from(image.height()) != height)
            {
                return Err(bad(format!("Window capture is {}×{}; the current crop layout requires {width}×{height}. Keep the game window fullscreen at that resolution, or configure a matching crop layout.",image.width(),image.height())));
            }
        }
        Ok(image)
    }
}
pub fn regions_for_seats(config: &CaptureConfig, seats: &[usize]) -> Vec<(String, Value)> {
    config
        .order
        .iter()
        .filter(|(id, _)| {
            if ["nameplate", "screen_width", "screen_height", "note"]
                .iter()
                .any(|part| id.contains(part))
            {
                return false;
            }
            let seat = id
                .strip_prefix("seats[")
                .and_then(|s| s.split_once(']'))
                .and_then(|(n, _)| n.parse::<usize>().ok())
                .or_else(|| {
                    id.strip_prefix("seat.")
                        .and_then(|s| s.split('.').next())
                        .and_then(|n| n.parse().ok())
                });
            !seat.is_some_and(|n| !seats.contains(&n) && !id.ends_with(".bet"))
        })
        .cloned()
        .collect()
}
pub fn gate(
    service: &LabService,
    ctx: &DatasetContext,
    image: &DynamicImage,
    config: &CaptureConfig,
    source: &str,
) -> LabResult<(String, Value, Vec<usize>)> {
    let rect: Rect = serde_json::from_value(
        config
            .regions
            .get("round_id")
            .cloned()
            .ok_or_else(|| bad("Game ID region is not configured"))?,
    )?;
    rect.validate(image.width(), image.height())
        .map_err(|_| bad("Game ID region is outside the selected capture source"))?;
    let crop = image.crop_imm(rect.x, rect.y, rect.w, rect.h);
    let png = media::png(&crop).map_err(bad)?;
    let pixels = review::image_identity(&png)?.1;
    let binding = json!([source, [image.width(), image.height()], config.hash, pixels]);
    let cached = {
        let state = ctx
            .state
            .lock()
            .map_err(|_| conflict("Dataset state lock poisoned"))?;
        if state["last_gate_binding"] == binding {
            state.get("last_game_prediction").cloned()
        } else {
            None
        }
    };
    let prediction = if let Some(cached) = cached {
        cached
    } else {
        service.model.predict(&png, "round_id").map_err(|e| {
            unavailable(format!(
                "Model unavailable for Game ID verification: {}",
                e.message
            ))
        })?
    };
    let text = prediction["text"].as_str().unwrap_or("");
    if prediction["schema_valid"] != true || !crate::labels::validate_text("round_id", text, false)
    {
        return Err(bad(format!("Game ID not verified. Model saw: '{text}'")));
    }
    {
        let mut state = ctx
            .state
            .lock()
            .map_err(|_| conflict("Dataset state lock poisoned"))?;
        state["last_gate_binding"] = binding;
        state["last_game_hash"] = json!(pixels);
        state["last_game_text"] = json!(text);
        state["last_game_prediction"] = prediction.clone();
    }
    let colors = vec![
        config.colors["nameplate"].as_str().unwrap_or("").into(),
        config.colors["in_turn"].as_str().unwrap_or("").into(),
        config.colors["in_turn_urgent"]
            .as_str()
            .unwrap_or("")
            .into(),
    ];
    let mut seats = Vec::new();
    let count = config.regions["seats"].as_array().map_or(0, Vec::len).max(
        config
            .order
            .iter()
            .filter_map(|(id, _)| {
                id.strip_prefix("seat.")
                    .and_then(|s| s.split('.').next())
                    .and_then(|n| n.parse::<usize>().ok())
                    .and_then(|n| n.checked_add(1))
            })
            .max()
            .unwrap_or(0),
    );
    for n in 0..count {
        let value = config
            .regions
            .get("seats")
            .and_then(Value::as_array)
            .and_then(|a| a.get(n))
            .and_then(|s| s.get("nameplate"))
            .or_else(|| config.regions.get(format!("seat.{n}.nameplate")));
        if let Some(value) = value.filter(|v| !v.is_null()) {
            let rect: Rect = serde_json::from_value(value.clone())?;
            rect.validate(image.width(), image.height()).map_err(|_| {
                bad(format!(
                    "Nameplate region seats[{n}] is outside the selected capture source"
                ))
            })?;
            if crate::cv_utils::color_density(
                &image.crop_imm(rect.x, rect.y, rect.w, rect.h),
                &colors,
                5,
            ) >= 0.05
            {
                seats.push(n);
            }
        }
    }
    Ok((text.into(), prediction, seats))
}
pub fn region_hash(config: &CaptureConfig) -> LabResult<String> {
    use md5::{Digest, Md5};
    Ok(format!(
        "{:x}",
        Md5::digest(python_json(&config.regions, false)?.as_bytes())
    ))
}
pub fn saved_hashes(ctx: &DatasetContext) -> LabResult<BTreeMap<String, Vec<String>>> {
    let conn = ctx.connection()?;
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT COALESCE(region_id,''),COALESCE(phash,'') FROM images")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, hash) in rows {
        map.entry(id).or_default().push(hash);
    }
    Ok(map)
}
fn thumbnail(image: &DynamicImage) -> LabResult<String> {
    let small = image.thumbnail(400, 400).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 60)
        .encode_image(&small)
        .map_err(|e| bad(e.to_string()))?;
    Ok(STANDARD.encode(bytes))
}
pub fn capture_manual(
    service: &LabService,
    ctx: &Arc<DatasetContext>,
    body: &Value,
) -> LabResult<Value> {
    let monitor = body["monitor"].as_str().unwrap_or("Default");
    let paged = body["queue_mode"] == "paged";
    let remaining = if paged {
        5000 - queue::summary(ctx)?["total"].as_i64().unwrap_or(0)
    } else {
        i64::MAX
    };
    if remaining <= 0 {
        return Err(conflict(
            "Collection queue is full (5,000 crops). Save or remove crops before capturing more.",
        ));
    }
    let config = service.capture.config()?;
    let image = service.capture.image(monitor, &config, true)?;
    let (text, prediction, seats) = gate(service, ctx, &image, &config, monitor)?;
    let eligible:Vec<(String,Rect)>=regions_for_seats(&config,&seats).into_iter().map(|(id,value)|{let rect=serde_json::from_value::<Rect>(value).map_err(|_|bad(format!("Crop region {id} is outside the selected capture source. Configure a matching crop layout.")))?;Ok((id,rect))}).collect::<LabResult<_>>()?;
    for (id, rect) in &eligible {
        rect.validate(image.width(),image.height()).map_err(|_|bad(format!("Crop region {id} is outside the selected capture source. Configure a matching crop layout.")))?;
    }
    service.capture.require_source(monitor)?;
    let source = format!("cap_{}_{}.png", now_ms(), &uuid()[..8]);
    let hashes = saved_hashes(ctx)?;
    let pending = if paged {
        BTreeMap::new()
    } else {
        super::watch::pending_hashes(ctx)?
    };
    let mut selected = Vec::new();
    for (id, rect) in eligible {
        let crop = image.crop_imm(rect.x, rect.y, rect.w, rect.h);
        let phash = media::dhash(&crop);
        if hashes
            .get(&id)
            .into_iter()
            .chain(pending.get(&id))
            .flatten()
            .any(|previous| media::hamming(&phash, previous) <= 2)
        {
            continue;
        }
        if paged && super::watch::queue_duplicate(ctx, &id, &phash)? {
            continue;
        }
        let png = media::png(&crop).map_err(bad)?;
        let key = format!("{id}:{phash}:{source}");
        let mut item = json!({"id":id,"base64_image":STANDARD.encode(&png),"phash":phash,"label":"","source":source,"sample_key":key,"rect":rect});
        if id == "round_id" {
            let input = review::SampleInput {
                key,
                region_id: id,
                png,
                filename: None,
            };
            let prediction = review::prediction(ctx, &input, prediction.clone())?;
            item["prediction_id"] = prediction["id"].clone();
            item["prediction"] = prediction;
        }
        selected.push(item);
        if selected.len() as i64 >= remaining {
            break;
        }
    }
    let thumb = thumbnail(&image)?;
    let frame = json!({"id":format!("manual:{source}"),"game_id":text,"thumbnail":thumb,"regions":selected,"source":source,"frame_width":image.width(),"frame_height":image.height()});
    if paged && selected.is_empty() {
        let mut result = frame;
        result["summary"] = queue::summary(ctx)?;
        return Ok(result);
    }
    let bytes = media::png(&image).map_err(bad)?;
    let path = datasets::file(&ctx.captures(), &source)?;
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    service.registry.resolve(&ctx.id)?;
    let tx = conn.transaction()?;
    fs::write(&path, bytes)?;
    let outcome = (|| -> LabResult<()> {
        tx.execute(
            "INSERT INTO full_captures(filename,monitor,timestamp,regions_hash) VALUES(?,?,?,?)",
            params![source, monitor, now_ms(), region_hash(&config)?],
        )?;
        if paged {
            for item in &selected {
                queue::ingest_conn(&tx, ctx, item, &frame)?;
            }
            queue::bump(&tx)?;
        }
        tx.commit()?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(path);
    }
    outcome?;
    drop(conn);
    if !paged {
        let mut state = ctx
            .state
            .lock()
            .map_err(|_| conflict("Dataset state lock poisoned"))?;
        let mut cache: BTreeMap<String, Vec<String>> = state
            .get("session_phashes")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        for item in &selected {
            cache
                .entry(item["id"].as_str().unwrap_or("").into())
                .or_default()
                .push(item["phash"].as_str().unwrap_or("").into());
        }
        state["session_phashes"] = serde_json::to_value(cache)?;
    }
    if paged {
        let mut result = queue::frame_metadata(ctx, &frame)?;
        result["thumbnail"] = json!(thumb);
        result["summary"] = queue::summary(ctx)?;
        Ok(result)
    } else {
        Ok(frame)
    }
}
pub fn legacy_stats(ctx: &DatasetContext) -> LabResult<Value> {
    let conn = ctx.connection()?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
    let labeled: i64 = conn.query_row(
        "SELECT COUNT(*) FROM images WHERE COALESCE(label,'')!=''",
        [],
        |r| r.get(0),
    )?;
    let metrics = crate::statistics::dataset_metrics(&conn)?;
    let per_region:BTreeMap<_,_>=metrics.per_category.into_iter().map(|(category,value)|(category,json!({"unique_labels":value.unique_labels,"avg_len":value.mean_label_length,"avg_dist":value.mean_hamming_distance,"avg_ar":value.mean_aspect_ratio,"sampled_pairs":value.sampled_pairs}))).collect();
    Ok(
        json!({"overview":{"total":total,"text":labeled,"empty":total-labeled},"regions":metrics.categories,"top_labels":metrics.top_labels,"crops":{"min_w":metrics.crops.min_width,"max_w":metrics.crops.max_width,"avg_w":metrics.crops.mean_width,"min_h":metrics.crops.min_height,"max_h":metrics.crops.max_height,"avg_h":metrics.crops.mean_height},"lengths":{"min":metrics.label_lengths.min,"max":metrics.label_lengths.max,"avg":metrics.label_lengths.mean},"per_region":per_region,"poker":{"currency":metrics.currency,"actions":metrics.actions,"all_in_rate":metrics.all_in_rate}}),
    )
}
fn db_entries(ctx: &DatasetContext) -> LabResult<Value> {
    let conn = ctx.connection()?;
    let entries:Vec<Value>=conn.prepare("SELECT filename,COALESCE(label,'') label,COALESCE(region_id,'') id FROM images ORDER BY timestamp DESC,id DESC")?.query_map([],review::row_json)?.collect::<rusqlite::Result<_>>()?;
    Ok(json!(entries))
}
fn register_list_casefold(conn: &rusqlite::Connection) -> LabResult<()> {
    conn.create_scalar_function(
        "poker_list_lower",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(ctx.get::<String>(0)?.to_lowercase()),
    )?;
    Ok(())
}
pub fn db_entries_page(
    ctx: &DatasetContext,
    cursor: Option<&str>,
    limit: usize,
    search: &str,
    keys_only: Option<&str>,
) -> LabResult<Value> {
    if !matches!(keys_only, None | Some("0") | Some("1")) {
        return Err(bad("Invalid keys_only"));
    }
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    register_list_casefold(&conn)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS list_image_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO list_image_revision VALUES(1,0); CREATE TRIGGER IF NOT EXISTS list_image_insert AFTER INSERT ON images BEGIN UPDATE list_image_revision SET revision=revision+1 WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS list_image_update AFTER UPDATE ON images BEGIN UPDATE list_image_revision SET revision=revision+1 WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS list_image_delete AFTER DELETE ON images BEGIN UPDATE list_image_revision SET revision=revision+1 WHERE id=1; END;")?;
    let tx = conn.transaction()?;
    let revision: i64 = tx.query_row(
        "SELECT revision FROM list_image_revision WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let offset = if let Some(cursor) = cursor {
        let (generation, offset) = cursor
            .split_once(':')
            .ok_or_else(|| bad("Invalid database cursor"))?;
        let generation = generation
            .parse::<i64>()
            .map_err(|_| bad("Invalid database cursor"))?;
        let offset = offset
            .parse::<i64>()
            .map_err(|_| bad("Invalid database cursor"))?;
        if generation != revision {
            return Err(conflict("Database changed; reload the list"));
        }
        if offset < 0 {
            return Err(bad("Invalid database cursor"));
        }
        offset
    } else {
        0
    };
    let next_offset = offset
        .checked_add(limit as i64)
        .ok_or_else(|| bad("Invalid database cursor"))?;
    let search = search.trim();
    let predicate = "(instr(poker_list_lower(COALESCE(label,'')),poker_list_lower(?1))>0 OR instr(poker_list_lower(COALESCE(region_id,'')),poker_list_lower(?1))>0)";
    let total: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM images WHERE {predicate}"),
        [search],
        |row| row.get(0),
    )?;
    let columns = if keys_only == Some("1") {
        "filename"
    } else {
        "filename,COALESCE(label,'') label,COALESCE(region_id,'') id"
    };
    let sql = format!("SELECT {columns} FROM images WHERE {predicate} ORDER BY (COALESCE(label,'')='') ASC,timestamp DESC,images.id DESC LIMIT ?2 OFFSET ?3");
    let mut values: Vec<Value> = tx
        .prepare(&sql)?
        .query_map(
            params![search, (limit + 1) as i64, offset],
            review::row_json,
        )?
        .collect::<rusqlite::Result<_>>()?;
    let more = values.len() > limit;
    values.truncate(limit);
    Ok(
        json!({"items":values,"total":total,"next_cursor":if more { Some(format!("{revision}:{next_offset}")) } else { None }}),
    )
}
fn javascript_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let negative = value.is_sign_negative();
    let raw = value.abs().to_string();
    let (whole, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    let digits = format!("{whole}{fraction}");
    let leading = digits.bytes().take_while(|b| *b == b'0').count();
    let exponent = whole.len() as i32 - leading as i32 - 1;
    let significant = digits[leading..].trim_end_matches('0');
    let sign = if negative { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        let mut chars = significant.chars();
        let first = chars.next().unwrap_or('0');
        let tail: String = chars.collect();
        let mantissa = if tail.is_empty() {
            first.to_string()
        } else {
            format!("{first}.{tail}")
        };
        return format!(
            "{sign}{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        );
    }
    format!("{sign}{raw}")
}

fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(v)) => javascript_number(v.as_f64().unwrap_or(0.0)),
        Some(Value::String(v)) => v.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    javascript_string(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn register_history_signature(conn: &rusqlite::Connection) -> LabResult<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "history_signature",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let raw: String = ctx.get(0)?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
            Ok(format!(
                "{}-{}-{}",
                javascript_string(value.get("items")),
                javascript_string(value.get("rpm")),
                javascript_string(value.get("score"))
            ))
        },
    )?;
    conn.create_scalar_function(
        "history_score",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let raw: String = ctx.get(0)?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
            let score = match value.get("score") {
                Some(Value::Number(n)) => n.as_f64(),
                Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
                Some(Value::Null) => Some(0.0),
                Some(Value::String(s)) => javascript_numeric_text(s),
                Some(Value::Array(_)) => {
                    javascript_numeric_text(&javascript_string(value.get("score")))
                }
                _ => None,
            };
            Ok(score.filter(|n| !n.is_nan()))
        },
    )?;
    Ok(())
}

fn javascript_numeric_text(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    value.parse::<f64>().ok()
}

pub fn auxiliary_page(
    ctx: &DatasetContext,
    kind: &str,
    cursor: Option<&str>,
    limit: usize,
    search: &str,
) -> LabResult<Value> {
    if kind == "names" {
        let _ = db_entries_page(ctx, None, 1, "", None)?;
    }
    let mut conn = ctx.connection()?;
    ctx.ensure_active()?;
    if kind == "history" && search == "score" {
        register_history_signature(&conn)?;
    }
    let tx = conn.transaction()?;
    let revision: i64 = if kind == "names" {
        tx.query_row(
            "SELECT revision FROM list_image_revision WHERE id=1",
            [],
            |r| r.get(0),
        )?
    } else {
        tx.query_row("SELECT COALESCE(MAX(id),0) FROM session_history", [], |r| {
            r.get(0)
        })?
    };
    let (ceiling, offset) = if let Some(raw) = cursor {
        let (rev, off) = raw
            .split_once(':')
            .ok_or_else(|| bad("Invalid page cursor"))?;
        let rev: i64 = rev.parse().map_err(|_| bad("Invalid page cursor"))?;
        let off: i64 = off.parse().map_err(|_| bad("Invalid page cursor"))?;
        if off < 0 {
            return Err(bad("Invalid page cursor"));
        }
        if kind == "names" && rev != revision {
            return Err(conflict("Names changed; reload the list"));
        }
        (rev, off)
    } else {
        (revision, 0)
    };
    let next_offset = offset
        .checked_add(limit as i64)
        .ok_or_else(|| bad("Invalid page cursor"))?;
    let (mut items, total): (Vec<Value>, i64) = if kind == "names" {
        let where_sql = "region_id LIKE '%.name' AND COALESCE(label,'')!='' AND instr(poker_list_lower(label),poker_list_lower(?1))>0";
        let total = tx.query_row(
            &format!("SELECT COUNT(DISTINCT label) FROM images WHERE {where_sql}"),
            [search],
            |r| r.get(0),
        )?;
        let mut q=tx.prepare(&format!("SELECT DISTINCT label AS name FROM images WHERE {where_sql} ORDER BY label COLLATE NOCASE,label LIMIT ?2 OFFSET ?3"))?;
        let rows = q
            .query_map(
                params![search, (limit + 1) as i64, offset],
                review::row_json,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (rows, total)
    } else if search == "score" {
        let ranked = "SELECT data,timestamp,id,history_score(data) AS score,ROW_NUMBER() OVER (PARTITION BY history_signature(data) ORDER BY timestamp DESC,id DESC) AS duplicate_rank FROM session_history WHERE id<=?1 AND json_valid(data) AND history_score(data)>0";
        let total = tx.query_row(
            &format!("SELECT COUNT(*) FROM ({ranked}) WHERE duplicate_rank=1"),
            [ceiling],
            |r| r.get(0),
        )?;
        let mut q = tx.prepare(&format!("SELECT data FROM ({ranked}) WHERE duplicate_rank=1 ORDER BY score DESC,timestamp DESC,id DESC LIMIT ?2 OFFSET ?3"))?;
        let raw = q
            .query_map(params![ceiling, (limit + 1) as i64, offset], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let rows = raw
            .iter()
            .map(|s| serde_json::from_str(s))
            .collect::<Result<Vec<Value>, _>>()?;
        (rows, total)
    } else {
        let total = tx.query_row(
            "SELECT COUNT(*) FROM session_history WHERE id<=?1",
            [ceiling],
            |r| r.get(0),
        )?;
        let mut q=tx.prepare("SELECT data FROM session_history WHERE id<=?1 ORDER BY timestamp DESC,id DESC LIMIT ?2 OFFSET ?3")?;
        let raw = q
            .query_map(params![ceiling, (limit + 1) as i64, offset], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let rows = raw
            .iter()
            .map(|s| serde_json::from_str(s))
            .collect::<Result<Vec<Value>, _>>()?;
        (rows, total)
    };
    let more = items.len() > limit;
    items.truncate(limit);
    Ok(
        json!({"items":items,"total":total,"next_cursor":if more {Some(format!("{ceiling}:{next_offset}"))} else {None},"meta":{}}),
    )
}

fn settings(ctx: &DatasetContext, default: Value) -> LabResult<Value> {
    let conn = ctx.connection()?;
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='config'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(default))
}
fn history(ctx: &DatasetContext) -> LabResult<Value> {
    let conn = ctx.connection()?;
    let values: Vec<String> = conn
        .prepare("SELECT data FROM session_history ORDER BY timestamp DESC,id DESC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!(values
        .iter()
        .map(|v| serde_json::from_str::<Value>(v))
        .collect::<Result<Vec<_>, _>>()?))
}
fn sync_status(ctx: &DatasetContext) -> LabResult<Value> {
    let state = ctx
        .state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?;
    Ok(state
        .get("sync_status")
        .cloned()
        .unwrap_or(json!({"is_syncing":false,"current_action":"Idle","progress":0,"total":0})))
}
fn set_sync(
    ctx: &DatasetContext,
    action: &str,
    progress: usize,
    total: usize,
    active: bool,
    error: Option<String>,
) -> LabResult<()> {
    ctx.state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?["sync_status"] = json!({"is_syncing":active,"current_action":action,"progress":progress,"total":total,"error":error});
    Ok(())
}
fn start_sync(service: &LabService, ctx: &Arc<DatasetContext>) -> LabResult<()> {
    {
        let mut state = ctx
            .state
            .lock()
            .map_err(|_| conflict("Dataset state lock poisoned"))?;
        if state["sync_status"]["is_syncing"] == true {
            return Ok(());
        }
        state["sync_status"] =
            json!({"is_syncing":true,"current_action":"Analyzing Changes","progress":0,"total":1});
    }
    let config = service.capture.config()?;
    let registry = service.registry.clone();
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> LabResult<()> {
            let _operation = ctx.lock_operation()?;
            registry.resolve(&ctx.id)?;
            review::ensure(&ctx)?;
            let mut conn = ctx.connection()?;
            ctx.ensure_active()?;
            let by_id: BTreeMap<_, _> = config
                .order
                .iter()
                .map(|(id, rect)| (id.clone(), rect.clone()))
                .collect();
            let rows:Vec<Value>=conn.prepare("SELECT i.*,c.filename AS capture_filename FROM images i LEFT JOIN full_captures c ON i.source_id=c.id ORDER BY i.source_id,i.id")?.query_map([],review::row_json)?.collect::<rusqlite::Result<_>>()?;
            let mut pending = Vec::new();
            for row in rows {
                let id = row["region_id"].as_str().unwrap_or("");
                let rect = by_id.get(id).or_else(|| {
                    by_id
                        .iter()
                        .find(|(key, _)| {
                            crate::types::canonical_id(key) == crate::types::canonical_id(id)
                        })
                        .map(|(_, r)| r)
                });
                if let Some(rect) = rect {
                    let Ok(rect) = serde_json::from_value::<Rect>(rect.clone()) else {
                        continue;
                    };
                    if row["source_id"].is_null() {
                        continue;
                    }
                    if row["x"].as_u64() == Some(u64::from(rect.x))
                        && row["y"].as_u64() == Some(u64::from(rect.y))
                        && row["w"].as_u64() == Some(u64::from(rect.w))
                        && row["h"].as_u64() == Some(u64::from(rect.h))
                    {
                        continue;
                    }
                    pending.push((row, rect));
                }
            }
            let total = pending.len();
            let mut cached: (String, Option<DynamicImage>) = (String::new(), None);
            let mut skipped = 0;
            for (index, (row, rect)) in pending.into_iter().enumerate() {
                let source = row["capture_filename"].as_str().unwrap_or("");
                if source != cached.0 {
                    cached = (
                        source.into(),
                        datasets::file(&ctx.captures(), source)
                            .ok()
                            .and_then(|p| fs::read(p).ok())
                            .and_then(|v| media::decode_image(&v).ok()),
                    );
                }
                let Some(image) = &cached.1 else {
                    skipped += 1;
                    continue;
                };
                if rect.validate(image.width(), image.height()).is_err() {
                    skipped += 1;
                    continue;
                }
                let crop = image.crop_imm(rect.x, rect.y, rect.w, rect.h);
                let phash = media::dhash(&crop);
                let rid = row["region_id"].as_str().unwrap_or("");
                let filename = format!("{}_{}.png", rid.replace(['.', '[', ']'], "_"), phash);
                let old = row["filename"].as_str().unwrap_or("");
                let old_path = datasets::file(&ctx.images(), old)?;
                let new_path = datasets::file(&ctx.images(), &filename)?;
                let prior_new = if new_path.exists() {
                    Some(fs::read(&new_path)?)
                } else {
                    None
                };
                let tx = conn.transaction()?;
                fs::write(&new_path, media::png(&crop).map_err(bad)?)?;
                let result = (|| -> LabResult<()> {
                    tx.execute("UPDATE images SET filename=?,phash=?,x=?,y=?,w=?,h=?,label=label WHERE id=?",params![filename,phash,rect.x,rect.y,rect.w,rect.h,row["id"].as_i64()])?;
                    tx.execute(
                        "UPDATE review_samples SET filename=? WHERE filename=?",
                        params![filename, old],
                    )?;
                    tx.commit()?;
                    Ok(())
                })();
                if result.is_err() {
                    if let Some(prior) = prior_new {
                        fs::write(&new_path, prior)?;
                    } else {
                        let _ = fs::remove_file(&new_path);
                    }
                    result?;
                }
                if old != filename && old_path.exists() {
                    fs::remove_file(old_path)?;
                }
                set_sync(
                    &ctx,
                    &format!("Updating {rid} ({}/{total})", index + 1),
                    index + 1,
                    total,
                    true,
                    None,
                )?;
            }
            conn.execute(
                "UPDATE full_captures SET regions_hash=?",
                [region_hash(&config)?],
            )?;
            set_sync(
                &ctx,
                "Idle",
                total,
                total,
                false,
                if skipped > 0 {
                    Some(format!(
                        "Skipped {skipped} records with missing or invalid master captures"
                    ))
                } else {
                    None
                },
            )?;
            Ok(())
        })();
        if let Err(error) = outcome {
            let _ = set_sync(&ctx, "Idle", 0, 0, false, Some(error.message));
        }
    });
    Ok(())
}
pub fn handle(
    service: &LabService,
    ctx: &Arc<DatasetContext>,
    request: &LabRequest,
) -> Option<LabResult<LabResponse>> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/initial_data") => Some((|| {
            let background = request.query("background_lists") == Some("1");
            let paged = background || request.query("queue_mode") == Some("paged");
            let session = if paged {
                queue::session(ctx)?
            } else {
                super::watch::merged_session(ctx)?
            };
            let (sources, warnings) = match service.capture.sources() {
                Ok(s) => (s, vec![]),
                Err(e) => (json!([]), vec![e.message]),
            };
            let monitors: Vec<_> = sources
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| s["kind"] == "monitor")
                .cloned()
                .collect();
            let default = json!({"last_monitor":monitors.first().and_then(|m|m["name"].as_str()).unwrap_or("")});
            Ok(LabResponse::ok(
                json!({"session":session,"collection_page":if paged{queue::page(ctx,None,60,"newest")?}else{Value::Null},"db":if background { json!([]) } else { db_entries(ctx)? },"monitors":monitors,"sources":sources,"settings":settings(ctx,default)?,"history":if background { json!([]) } else { history(ctx)? },"warnings":warnings}),
            ))
        })()),
        ("GET", "/api/monitors") => Some((|| {
            let sources = service.capture.sources()?;
            Ok(LabResponse::ok(json!(sources
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| s["kind"] == "monitor")
                .cloned()
                .collect::<Vec<_>>())))
        })()),
        ("GET", "/api/sources") => Some(service.capture.sources().map(LabResponse::ok)),
        ("GET", "/api/stats") => Some(legacy_stats(ctx).map(LabResponse::ok)),
        ("GET", "/api/db_entries") => Some(db_entries(ctx).map(LabResponse::ok)),
        ("GET", "/api/get_settings") => {
            Some(settings(ctx, json!({"last_monitor":"DP-2"})).map(LabResponse::ok))
        }
        ("POST", "/api/save_settings") => Some((|| {
            super::object(&request.body)?;
            let selected = request.body["last_monitor"].as_str();
            if let Some(selected) = selected {
                let configured = ctx
                    .state
                    .lock()
                    .map_err(|_| conflict("Dataset state lock poisoned"))?["watch_runtime"]
                    ["config"]["monitor"]
                    .as_str()
                    .map(str::to_owned);
                if configured
                    .as_deref()
                    .is_some_and(|current| current != selected)
                {
                    service.watch.stop(&ctx.id, None)?;
                }
            }
            let conn = ctx.connection()?;
            ctx.ensure_active()?;
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('config',?)",
                [request.body.to_string()],
            )?;
            Ok(LabResponse::ok(json!({"success":true})))
        })()),
        ("GET", "/api/get_session_history") => Some(history(ctx).map(LabResponse::ok)),
        ("POST", "/api/save_session_history") => Some((|| {
            let mut body = json!({"timestamp":now_ms(),"date":chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()});
            body.as_object_mut()
                .expect("object")
                .extend(super::object(&request.body)?.clone());
            let conn = ctx.connection()?;
            ctx.ensure_active()?;
            conn.execute(
                "INSERT INTO session_history(timestamp,data) VALUES(?,?)",
                params![now_ms(), body.to_string()],
            )?;
            Ok(LabResponse::ok(json!({"success":true})))
        })()),
        ("POST", "/api/capture") => Some((|| {
            let scan = service.watch.reserve_manual(&ctx.id)?;
            let result = capture_manual(service, ctx, &request.body);
            service.watch.release(&scan)?;
            result.map(LabResponse::ok)
        })()),
        ("POST", "/api/add_to_db") => Some((|| {
            if service.ai_review.is_busy(ctx)? {
                return Err(conflict("Pause AI review before saving this collection"));
            }
            let entries = request.body["entries"]
                .as_array()
                .ok_or_else(|| bad("entries must be a list"))?;
            let mut prepared = Vec::new();
            for entry in entries {
                if !entry.is_object() {
                    return Err(bad("Each entry must be an object"));
                }
                let encoded = entry["base64_image"]
                    .as_str()
                    .filter(|v| v.len() <= 12_000_000)
                    .ok_or_else(|| bad("A base64 PNG crop is required (maximum 9 MB)"))?;
                let png = STANDARD.decode(encoded).map_err(|e| bad(e.to_string()))?;
                review::image_identity(&png)?;
                let image = media::decode_image(&png).map_err(bad)?;
                let hash = media::dhash(&image);
                if entry["phash"] != hash {
                    return Err(bad("Crop perceptual hash mismatch"));
                }
                if let Some(source) = entry["source"].as_str() {
                    datasets::safe_filename(source)?;
                }
                prepared.push((entry.clone(), png, hash));
            }
            service.watch.stop(&ctx.id, None)?;
            let filenames = review::commit(ctx, &prepared)?;
            let keys: Vec<_> = prepared
                .iter()
                .map(|(entry, _, _)| queue::sample_key(entry, ""))
                .collect();
            super::watch::remove(ctx, &[], &keys, false)?;
            {
                let mut state = ctx
                    .state
                    .lock()
                    .map_err(|_| conflict("Dataset state lock poisoned"))?;
                state["session_phashes"] = json!({});
                state["session_game_ids"] = json!([]);
            }
            Ok(LabResponse::ok(
                json!({"success":true,"filenames":filenames,"message":format!("Added {} entries to database.",entries.len())}),
            ))
        })()),
        ("POST", "/api/db_update") => Some((|| {
            let filename = request.body["filename"]
                .as_str()
                .ok_or_else(|| bad("Invalid filename"))?;
            let mut input = request.body.clone();
            input["sample_key"] = json!(filename);
            let sample = review::sample_input(ctx, &input)?;
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
            let event = review::review(
                ctx,
                &sample,
                label,
                if request.body["prediction_id"].is_null() {
                    "manual"
                } else {
                    "corrected"
                },
                review::prediction_id(&request.body)?,
                outside,
            )?;
            Ok(LabResponse::ok(json!({"success":true,"event":event})))
        })()),
        ("POST", "/api/db_delete") => Some((|| {
            let mut names = queue::selectors(&request.body, "filenames", 20000)?;
            if names.is_empty() {
                if let Some(name) = request.body["filename"].as_str() {
                    names.push(name.into());
                }
            }
            let mut protected = HashSet::new();
            let mut uncertain = false;
            let mut conn = ctx.connection()?;
            ctx.ensure_active()?;
            let tx = conn.transaction()?;
            let has_watch: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='watch_inbox')", [], |r| r.get(0))?;
            if has_watch {
                let mut stmt = tx.prepare("SELECT source, payload FROM watch_inbox")?;
                let rows = stmt.query_map([], |r| {
                    Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (source, payload) = row?;
                    match source.filter(|s| !s.is_empty()) {
                        Some(source) => {
                            protected.insert(source);
                        }
                        None => uncertain = true,
                    }
                    match serde_json::from_str::<Value>(&payload) {
                        Ok(Value::Object(object)) => match object
                            .get("source")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            Some(source) => {
                                protected.insert(source.to_owned());
                            }
                            None => uncertain = true,
                        },
                        _ => uncertain = true,
                    }
                }
            }
            let has_queue: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='queue_items')", [], |r| r.get(0))?;
            if has_queue {
                let mut stmt =
                    tx.prepare("SELECT source, frame_id, payload FROM queue_items WHERE active=1")?;
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?;
                for row in rows {
                    let (source, frame, payload) = row?;
                    match source.filter(|s| !s.is_empty()) {
                        Some(source) => {
                            protected.insert(source);
                        }
                        None => uncertain = true,
                    }
                    if let Some(frame) = frame.filter(|s| !s.is_empty()) {
                        protected.insert(frame);
                    }
                    match serde_json::from_str::<Value>(&payload) {
                        Ok(Value::Object(object)) => {
                            for key in ["source", "frame_id", "watch_frame_id"] {
                                if let Some(value) = object.get(key) {
                                    match value {
                                        Value::String(s) if !s.is_empty() => {
                                            protected.insert(s.clone());
                                        }
                                        Value::Null => {}
                                        _ => uncertain = true,
                                    }
                                }
                            }
                        }
                        _ => uncertain = true,
                    }
                }
            }
            let mut paths = Vec::new();
            for name in &names {
                paths.push(datasets::file(&ctx.images(), name)?);
                tx.execute("DELETE FROM images WHERE filename=?", [name])?;
            }
            let unused:Vec<(i64,String)>=tx.prepare("SELECT id,filename FROM full_captures c WHERE NOT EXISTS(SELECT 1 FROM images i WHERE i.source_id=c.id)")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
            let mut deleted = 0;
            for (id, name) in unused {
                if !uncertain && !protected.contains(&name) {
                    paths.push(datasets::file(&ctx.captures(), &name)?);
                    tx.execute("DELETE FROM full_captures WHERE id=?", [id])?;
                    deleted += 1;
                }
            }
            tx.commit()?;
            for path in paths {
                if path.exists() {
                    fs::remove_file(path)?;
                }
            }
            Ok(LabResponse::ok(
                json!({"success":true,"message":format!("Deleted {} entries and {deleted} unused master captures.",names.len())}),
            ))
        })()),
        ("POST", "/api/db_clear") => Some((|| {
            service.watch.stop(&ctx.id, None)?;
            super::watch::remove(ctx, &[], &[], true)?;
            let mut paths = Vec::new();
            for folder in [ctx.images(), ctx.captures()] {
                datasets::plain(&folder)?;
                for entry in fs::read_dir(folder)? {
                    let entry = entry?;
                    datasets::plain(&entry.path())?;
                    if entry.file_type()?.is_file() && entry.file_name() != ".gitkeep" {
                        paths.push(entry.path());
                    }
                }
            }
            let mut conn = ctx.connection()?;
            ctx.ensure_active()?;
            let tx = conn.transaction()?;
            tx.execute_batch("DELETE FROM images;DELETE FROM full_captures;DELETE FROM session_progress;DELETE FROM session_history;")?;
            tx.commit()?;
            for path in paths {
                fs::remove_file(path)?;
            }
            Ok(LabResponse::ok(
                json!({"success":true,"message":"Database cleared."}),
            ))
        })()),
        ("POST", "/api/sync") => Some((|| {
            service.watch.stop(&ctx.id, None)?;
            start_sync(service, ctx)?;
            Ok(LabResponse::ok(json!({"success":true})))
        })()),
        ("GET", "/api/sync_status") => Some(sync_status(ctx).map(LabResponse::ok)),
        _ if request.method == "GET"
            && (request.path.starts_with("/api/db_image/")
                || request.path.starts_with("/api/cap_image/")) =>
        {
            Some((|| {
                let (capture, name) =
                    if let Some(name) = request.path.strip_prefix("/api/cap_image/") {
                        (true, name)
                    } else {
                        (false, request.path.trim_start_matches("/api/db_image/"))
                    };
                let path = datasets::file(
                    &if capture {
                        ctx.captures()
                    } else {
                        ctx.images()
                    },
                    name,
                )?;
                let bytes = fs::read(path).map_err(|_| super::not_found("Image not found"))?;
                Ok(LabResponse::binary(&bytes, "image/png"))
            })())
        }
        _ => None,
    }
}
pub fn editor(service: &LabService, request: &LabRequest) -> LabResult<LabResponse> {
    let capture = &service.capture;
    if request.path == "/api/editor/regions" {
        let draft = capture.root.join("region-definer.json");
        if request.method == "GET" {
            let regions: Value = if draft.exists() {
                datasets::plain(&draft)?;
                serde_json::from_slice(&fs::read(draft)?)?
            } else {
                serde_json::from_str(include_str!("../../assets/regions-flat.json"))?
            };
            let config: Value =
                serde_json::from_slice(&fs::read(capture.root.join("regions.json"))?)?;
            let dimensions = capture.root.join("region-definer-dimensions.json");
            let dimensions: Value = if dimensions.exists() {
                datasets::plain(&dimensions)?;
                serde_json::from_slice(&fs::read(dimensions)?)?
            } else {
                json!({"screenWidth":config["screen_width"],"screenHeight":config["screen_height"]})
            };
            return Ok(LabResponse::ok(
                json!({"regions":regions,"screenWidth":dimensions["screenWidth"].as_u64().unwrap_or(1920),"screenHeight":dimensions["screenHeight"].as_u64().unwrap_or(1080)}),
            ));
        }
        if request.method == "POST" {
            let export = request
                .body
                .get("export")
                .map(|v| v.as_bool().ok_or_else(|| bad("export must be boolean")))
                .transpose()?
                .unwrap_or(false);
            let mut body = request.body.clone();
            super::object(&body)?;
            body.as_object_mut().expect("object").remove("export");
            let config: EditorConfig = super::parse(&body)?;
            if !(1..=16384).contains(&config.screen_width)
                || !(1..=16384).contains(&config.screen_height)
                || config.regions.len() > 512
            {
                return Err(bad("Invalid region configuration dimensions or count"));
            }
            for rect in config.regions.values() {
                if rect.w == 0 || rect.h == 0 || rect.w > 16384 || rect.h > 16384 {
                    return Err(bad("Invalid editor rectangle dimensions"));
                }
            }
            datasets::atomic_json(&draft, &serde_json::to_value(&config.regions)?)?;
            datasets::atomic_json(
                &capture.root.join("region-definer-dimensions.json"),
                &json!({"screenWidth":config.screen_width,"screenHeight":config.screen_height}),
            )?;
            let mut response = json!({"saved":true});
            if export {
                let native = editor_native(&config)?;
                datasets::atomic_json(&capture.root.join("regions.json"), &native)?;
                service.watch.stop_all()?;
                response["exportPath"] = json!(capture.root.join("regions.json"));
                response["native"] = native;
            }
            return Ok(LabResponse::ok(response));
        }
        return Err(super::not_found("Unknown editor route"));
    }
    if request.method == "GET" && request.path == "/api/editor/media" {
        let mut names = Vec::new();
        if capture.media_root.exists() {
            datasets::plain(&capture.media_root)?;
            for entry in fs::read_dir(&capture.media_root)? {
                let entry = entry?;
                datasets::plain(&entry.path())?;
                if entry.file_type()?.is_file() {
                    let name = entry
                        .file_name()
                        .to_str()
                        .ok_or_else(|| bad("Invalid media filename"))?
                        .to_owned();
                    if media_type(&name).is_some() {
                        names.push(name);
                    }
                }
            }
        }
        names.sort();
        return Ok(LabResponse::ok(json!(names)));
    }
    if request.method == "GET" && request.path.starts_with("/api/editor/media/") {
        use std::io::{Read, Seek, SeekFrom};
        let name = request.path.trim_start_matches("/api/editor/media/");
        let mime = media_type(name).ok_or_else(|| bad("Unsupported editor media type"))?;
        let path = datasets::file(&capture.media_root, name)?;
        let mut file =
            std::fs::File::open(path).map_err(|_| super::not_found("Media not found"))?;
        let size = file.metadata()?.len();
        let range = request.header("Range");
        let (mut start, mut end) = (0, size.saturating_sub(1));
        let mut partial = false;
        if let Some(range) = range {
            let range = range
                .strip_prefix("bytes=")
                .ok_or_else(|| bad("Invalid media range"))?;
            let (a, b) = range
                .split_once('-')
                .filter(|(_, b)| !b.contains(','))
                .ok_or_else(|| bad("Invalid media range"))?;
            if a.is_empty() {
                let suffix = b.parse::<u64>().map_err(|_| bad("Invalid media range"))?;
                start = size.saturating_sub(suffix);
            } else {
                start = a.parse().map_err(|_| bad("Invalid media range"))?;
                if !b.is_empty() {
                    end = b
                        .parse::<u64>()
                        .map_err(|_| bad("Invalid media range"))?
                        .min(end);
                }
            }
            partial = true;
        }
        if size == 0 || start >= size || start > end {
            let mut response = LabResponse::json(416, Value::Null);
            response
                .headers
                .insert("Content-Range".into(), format!("bytes */{size}"));
            return Ok(response);
        }
        let video = mime.starts_with("video/");
        let requested = end - start + 1;
        if requested > 64 * 1024 * 1024 && !video {
            return Err(bad("Editor image exceeds media limit"));
        }
        if video && requested > 8 * 1024 * 1024 {
            end = start + 8 * 1024 * 1024 - 1;
            partial = true;
        }
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity((end - start + 1) as usize);
        file.take(end - start + 1).read_to_end(&mut bytes)?;
        let mut response = LabResponse::binary(&bytes, mime);
        response.status = if partial { 206 } else { 200 };
        response
            .headers
            .insert("Accept-Ranges".into(), "bytes".into());
        response
            .headers
            .insert("Content-Length".into(), bytes.len().to_string());
        if partial {
            response.headers.insert(
                "Content-Range".into(),
                format!("bytes {start}-{end}/{size}"),
            );
        }
        return Ok(response);
    }
    Err(super::not_found("Unknown editor route"))
}
fn media_type(name: &str) -> Option<&'static str> {
    match std::path::Path::new(name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "mp4" => Some("video/mp4"),
        "mkv" => Some("video/x-matroska"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct EditorRect {
    x: i64,
    y: i64,
    w: u32,
    h: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditorConfig {
    regions: BTreeMap<String, EditorRect>,
    screen_width: u32,
    screen_height: u32,
}
fn editor_native(config: &EditorConfig) -> LabResult<Value> {
    let coord = |key: &str| serde_json::to_value(config.regions.get(key)).map_err(Into::into);
    let mut seats = Vec::new();
    for n in 0..9 {
        seats.push(json!({"name":coord(&format!("seat.{n}.name"))?,"nameplate":coord(&format!("seat.{n}.nameplate"))?,"bank":coord(&format!("seat.{n}.bank"))?,"bet":coord(&format!("seat.{n}.bet"))?,"cards":[coord(&format!("seat.{n}.hand_0"))?,coord(&format!("seat.{n}.hand_1"))?],"status":coord(&format!("seat.{n}.status"))?,"dealer":coord(&format!("seat.{n}.dealer"))?}));
    }
    Ok(
        json!({"screen_width":config.screen_width,"screen_height":config.screen_height,"note":"Pixel coordinates at the resolution above.","round_id":coord("round_id")?,"community_cards":(1..=5).map(|n|coord(&format!("community.card_{n}"))).collect::<LabResult<Vec<Value>>>()?,"pot":coord("pot.main")?,"split_pot":coord("pot.split")?,"seats":seats}),
    )
}
