use super::{bad, conflict, now_ms, uuid, LabRequest, LabResponse, LabResult, LabService};
use super::{
    capture,
    datasets::{self, DatasetContext},
    queue, review,
};
use crate::media;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct CoordinatorState {
    active: Option<(String, String)>,
    inflight: Option<String>,
}
#[derive(Default)]
pub struct WatchCoordinator {
    state: Mutex<CoordinatorState>,
}
impl WatchCoordinator {
    pub fn stop_all(&self) -> LabResult<()> {
        self.state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?
            .active = None;
        Ok(())
    }
    pub fn start(&self, dataset: &str, lease: &str) -> LabResult<()> {
        self.state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?
            .active = Some((dataset.into(), lease.into()));
        Ok(())
    }
    pub fn valid(&self, dataset: &str, lease: &str) -> LabResult<bool> {
        Ok(self
            .state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?
            .active
            .as_ref()
            .is_some_and(|(d, l)| d == dataset && l == lease))
    }
    pub fn stop(&self, dataset: &str, lease: Option<&str>) -> LabResult<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?;
        if state
            .active
            .as_ref()
            .is_some_and(|(d, l)| d == dataset && lease.is_none_or(|lease| lease == l))
        {
            state.active = None;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn reserve(&self, dataset: &str, lease: &str) -> LabResult<Option<String>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?;
        if !state
            .active
            .as_ref()
            .is_some_and(|(d, l)| d == dataset && l == lease)
        {
            return Err(conflict("Capture watch lease is no longer active"));
        }
        if state.inflight.is_some() {
            return Ok(None);
        }
        let id = uuid();
        state.inflight = Some(id.clone());
        Ok(Some(id))
    }
    pub fn reserve_manual(&self, _dataset: &str) -> LabResult<String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?;
        if state.inflight.is_some() {
            return Err(conflict("Wait for the active capture scan to finish"));
        }
        let id = uuid();
        state.inflight = Some(id.clone());
        Ok(id)
    }
    pub fn release(&self, id: &str) -> LabResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| conflict("Capture coordinator lock poisoned"))?;
        if state.inflight.as_deref() == Some(id) {
            state.inflight = None;
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Config {
    monitor: String,
    interval_seconds: f64,
    queue_limit: usize,
    paged: bool,
}
impl Config {
    fn parse(data: &Value) -> LabResult<Self> {
        let monitor = data["monitor"]
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= 200)
            .ok_or_else(|| bad("A capture source is required"))?;
        let interval = data
            .get("interval_seconds")
            .map(|n| {
                n.as_f64()
                    .ok_or_else(|| bad("interval_seconds must be between 1 and 60"))
            })
            .transpose()?
            .unwrap_or(2.0);
        if !interval.is_finite() || !(1.0..=60.0).contains(&interval) {
            return Err(bad("interval_seconds must be between 1 and 60"));
        }
        let paged = data["queue_mode"] == "paged";
        let queue = if paged {
            5000
        } else {
            data.get("queue_limit")
                .map(|n| {
                    n.as_u64()
                        .ok_or_else(|| bad("queue_limit must be between 1 and 1000"))
                })
                .transpose()?
                .unwrap_or(200) as usize
        };
        if !paged && !(1..=1000).contains(&queue) {
            return Err(bad("queue_limit must be between 1 and 1000"));
        }
        Ok(Self {
            monitor: monitor.into(),
            interval_seconds: interval,
            queue_limit: queue,
            paged,
        })
    }
    fn json(&self) -> Value {
        let mut value = json!({"monitor":self.monitor,"interval_seconds":self.interval_seconds,"queue_limit":self.queue_limit,"per_frame_limit":5});
        if self.paged {
            value["queue_mode"] = json!("paged");
        }
        value
    }
}
#[derive(Default, Clone, Serialize, Deserialize)]
struct Runtime {
    lease_id: Option<String>,
    config: Option<Config>,
    config_hash: Option<String>,
    last_scan_at: Option<f64>,
    cursor: usize,
    reserved: usize,
}
fn load_runtime(ctx: &DatasetContext) -> LabResult<Runtime> {
    if let Some(value) = ctx
        .state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?
        .get("watch_runtime")
        .cloned()
    {
        return Ok(serde_json::from_value(value)?);
    }
    let conn = ctx.connection()?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='watch_state'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .or(conn
            .query_row(
                "SELECT value FROM settings WHERE key='watch_budget'",
                [],
                |r| r.get(0),
            )
            .optional()?);
    let value = raw
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .unwrap_or(Value::Null);
    let time = value["last_scan_at"].as_f64().filter(|n| n.is_finite());
    let state = Runtime {
        last_scan_at: time,
        cursor: value["cursor"].as_u64().unwrap_or(0) as usize % 100000,
        ..Default::default()
    };
    Ok(state)
}
fn put_runtime(ctx: &DatasetContext, runtime: &Runtime) -> LabResult<()> {
    ctx.state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?["watch_runtime"] =
        serde_json::to_value(runtime)?;
    Ok(())
}
fn persist(conn: &rusqlite::Connection, runtime: &Runtime) -> LabResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('watch_state',?)",
        [json!({"last_scan_at":runtime.last_scan_at,"cursor":runtime.cursor}).to_string()],
    )?;
    conn.execute("DELETE FROM settings WHERE key='watch_budget'", [])?;
    Ok(())
}
fn lease(service: &LabService, ctx: &DatasetContext, id: &str) -> LabResult<Runtime> {
    let runtime = load_runtime(ctx)?;
    if runtime.lease_id.as_deref() != Some(id) || !service.watch.valid(&ctx.id, id)? {
        return Err(conflict("Capture watch lease is no longer active"));
    }
    Ok(runtime)
}
pub fn frames(ctx: &DatasetContext) -> LabResult<Vec<Value>> {
    let conn = ctx.connection()?;
    if conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name='watch_inbox'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_none()
    {
        return Ok(vec![]);
    }
    let raw: Vec<String> = conn
        .prepare("SELECT payload FROM watch_inbox ORDER BY created_at,frame_id")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(raw
        .iter()
        .map(|s| serde_json::from_str(s))
        .collect::<Result<_, _>>()?)
}
fn raw_session(ctx: &DatasetContext) -> LabResult<Value> {
    let conn = ctx.connection()?;
    let raw: Option<String> = conn
        .query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(json!({})))
}
pub fn merge(ctx: &DatasetContext, session: &Value) -> LabResult<Value> {
    if !session.is_object() {
        return Err(bad("Session must be an object"));
    }
    for field in ["frames", "pool"] {
        if let Some(values) = session.get(field) {
            if !values
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_object))
            {
                return Err(bad("Session frames and pool must contain objects"));
            }
        }
    }
    let inbox = frames(ctx)?;
    let mut result = session.clone();
    let client_frames = session["frames"].as_array().cloned().unwrap_or_default();
    let client_pool = session["pool"].as_array().cloned().unwrap_or_default();
    let is_watch_frame =
        |f: &Value| f["watch"] == true || f["id"].as_str().unwrap_or("").starts_with("watch:");
    let is_watch_sample =
        |s: &Value| s["watch"] == true || s["source"].as_str().unwrap_or("").starts_with("watch_");
    if inbox.is_empty()
        && !client_frames.iter().any(is_watch_frame)
        && !client_pool.iter().any(is_watch_sample)
    {
        return Ok(result);
    }
    let live: HashSet<String> = inbox
        .iter()
        .flat_map(|frame| {
            frame["regions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| queue::sample_key(item, frame["source"].as_str().unwrap_or("")))
        })
        .collect();
    let mut retained: Vec<_> = client_frames
        .into_iter()
        .filter(|frame| !is_watch_frame(frame))
        .collect();
    retained.extend(inbox);
    result["frames"] = json!(retained);
    result["pool"] = json!(client_pool
        .into_iter()
        .filter(|item| !is_watch_sample(item) || live.contains(&queue::sample_key(item, "")))
        .collect::<Vec<_>>());
    Ok(result)
}
pub fn merged_session(ctx: &DatasetContext) -> LabResult<Value> {
    merge(ctx, &raw_session(ctx)?)
}
pub fn save_session(ctx: &DatasetContext, session: &Value) -> LabResult<Value> {
    let merged = merge(ctx, session)?;
    let conn = ctx.connection()?;
    ctx.ensure_active()?;
    conn.execute(
        "INSERT OR REPLACE INTO session_progress(id,data) VALUES(1,?)",
        [merged.to_string()],
    )?;
    Ok(merged)
}
fn items(session: &Value) -> Vec<Value> {
    let mut items = session["pool"].as_array().cloned().unwrap_or_default();
    if let Some(frames) = session["frames"].as_array() {
        for frame in frames {
            if let Some(samples) = frame["regions"].as_array() {
                for sample in samples {
                    let mut sample = sample.clone();
                    if sample["source"].as_str().unwrap_or("").is_empty() {
                        sample["source"] = frame["source"].clone();
                    }
                    items.push(sample);
                }
            }
        }
    }
    items
}
pub fn queued(ctx: &DatasetContext) -> LabResult<usize> {
    Ok(items(&merged_session(ctx)?)
        .iter()
        .map(|item| queue::sample_key(item, ""))
        .collect::<HashSet<_>>()
        .len())
}
pub fn pending_hashes(ctx: &DatasetContext) -> LabResult<BTreeMap<String, Vec<String>>> {
    let mut hashes: BTreeMap<String, Vec<String>> = ctx
        .state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?
        .get("session_phashes")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    for item in items(&merged_session(ctx)?) {
        if let (Some(id), Some(hash)) = (item["id"].as_str(), item["phash"].as_str()) {
            if (16..=64).contains(&hash.len())
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                hashes.entry(id.into()).or_default().push(hash.into());
            }
        }
    }
    Ok(hashes)
}
pub fn queue_duplicate(ctx: &DatasetContext, id: &str, hash: &str) -> LabResult<bool> {
    queue::ensure(ctx)?;
    let conn = ctx.connection()?;
    let hashes: Vec<String> = conn
        .prepare(
            "SELECT phash FROM queue_items WHERE active=1 AND region_id=? AND phash IS NOT NULL",
        )?
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(hashes.iter().any(|old| media::hamming(hash, old) <= 2))
}
pub fn remove(
    ctx: &DatasetContext,
    frame_ids: &[String],
    sample_keys: &[String],
    clear: bool,
) -> LabResult<()> {
    let frames = frames(ctx)?;
    if frames.is_empty() {
        return Ok(());
    }
    let mut sources = Vec::new();
    {
        let mut conn = ctx.connection()?;
        ctx.ensure_active()?;
        let tx = conn.transaction()?;
        for mut frame in frames {
            let source = frame["source"].as_str().unwrap_or("").to_owned();
            let remaining: Vec<Value> = if clear || frame_ids.iter().any(|id| frame["id"] == *id) {
                vec![]
            } else {
                frame["regions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| !sample_keys.contains(&queue::sample_key(item, &source)))
                    .cloned()
                    .collect()
            };
            if remaining.is_empty() {
                tx.execute(
                    "DELETE FROM watch_inbox WHERE frame_id=?",
                    [frame["id"].as_str()],
                )?;
                let capture: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM full_captures WHERE filename=?",
                        [&source],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(id) = capture {
                    if tx
                        .query_row(
                            "SELECT 1 FROM images WHERE source_id=? LIMIT 1",
                            [id],
                            |r| r.get::<_, i64>(0),
                        )
                        .optional()?
                        .is_none()
                    {
                        datasets::safe_filename(&source)?;
                        tx.execute("DELETE FROM full_captures WHERE id=?", [id])?;
                        sources.push(source);
                    }
                }
            } else if frame["regions"].as_array().map_or(0, Vec::len) != remaining.len() {
                frame["regions"] = json!(remaining);
                tx.execute(
                    "UPDATE watch_inbox SET payload=? WHERE frame_id=?",
                    params![frame.to_string(), frame["id"].as_str()],
                )?;
            }
        }
        tx.commit()?;
    }
    for source in sources {
        let path = datasets::file(&ctx.captures(), &source)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    save_session(ctx, &raw_session(ctx)?)?;
    Ok(())
}
fn reply(
    ctx: &DatasetContext,
    paged: bool,
    status: &str,
    retry: f64,
    frames: Vec<Value>,
) -> LabResult<Value> {
    let count: usize = frames
        .iter()
        .map(|frame| frame["regions"].as_array().map_or(0, Vec::len))
        .sum();
    let summary = if paged {
        Some(queue::summary(ctx)?)
    } else {
        None
    };
    let queued = if let Some(summary) = &summary {
        summary["total"].as_u64().unwrap_or(0) as usize
    } else {
        queued(ctx)?
    };
    let mut result = json!({"status":status,"frames":frames,"added_count":count,"queued_count":queued,"retry_after_seconds":retry});
    if let Some(summary) = summary {
        result["summary"] = summary;
    }
    Ok(result)
}
fn tick(service: &LabService, ctx: &Arc<DatasetContext>, id: &str) -> LabResult<Value> {
    let phase1 = ctx.lock_operation()?;
    service.registry.resolve(&ctx.id)?;
    let mut runtime = lease(service, ctx, id)?;
    let config = runtime
        .config
        .clone()
        .ok_or_else(|| conflict("Capture watch lease is no longer active"))?;
    service.capture.require_source(&config.monitor)?;
    let layout = service.capture.config()?;
    if runtime.config_hash.as_deref() != Some(&layout.hash) {
        service.watch.stop(&ctx.id, None)?;
        return Err(conflict("Capture configuration changed; start watch again"));
    }
    let count = if config.paged {
        queue::summary(ctx)?["total"].as_u64().unwrap_or(0) as usize
    } else {
        queued(ctx)?
    };
    let now = now_ms() as f64 / 1000.0;
    if runtime.reserved > 0 {
        return reply(ctx, config.paged, "waiting", 1.0, vec![]);
    }
    if let Some(last) = runtime.last_scan_at {
        if now - last < config.interval_seconds {
            return reply(
                ctx,
                config.paged,
                "waiting",
                config.interval_seconds - (now - last),
                vec![],
            );
        }
    }
    if count >= config.queue_limit {
        return reply(
            ctx,
            config.paged,
            "queue_full",
            config.interval_seconds,
            vec![],
        );
    }
    let Some(scan) = service.watch.reserve(&ctx.id, id)? else {
        return reply(ctx, config.paged, "waiting", 1.0, vec![]);
    };
    runtime.reserved = 5.min(config.queue_limit.saturating_sub(count));
    runtime.last_scan_at = Some(now);
    let setup = (|| -> LabResult<()> {
        put_runtime(ctx, &runtime)?;
        let conn = ctx.connection()?;
        ctx.ensure_active()?;
        persist(&conn, &runtime)?;
        Ok(())
    })();
    if let Err(error) = setup {
        runtime.reserved = 0;
        let _ = put_runtime(ctx, &runtime);
        service.watch.release(&scan)?;
        return Err(error);
    }
    drop(phase1);
    let outcome = (|| -> LabResult<Value> {
        let image = match service.capture.image(&config.monitor, &layout, true) {
            Ok(image) => image,
            Err(error) => {
                if config.monitor.starts_with("window:") {
                    service.watch.stop(&ctx.id, None)?;
                }
                return Err(error);
            }
        };
        let (game_id, _, seats) = capture::gate(service, ctx, &image, &layout, &config.monitor)?;
        let eligible = capture::regions_for_seats(&layout, &seats);
        if eligible.is_empty() {
            lease(service, ctx, id)?;
            return reply(
                ctx,
                config.paged,
                "duplicate",
                config.interval_seconds,
                vec![],
            );
        }
        let _phase2 = ctx.lock_operation()?;
        lease(service, ctx, id)?;
        service.registry.resolve(&ctx.id)?;
        if service.capture.config()?.hash != layout.hash {
            service.watch.stop(&ctx.id, None)?;
            return Err(conflict("Capture configuration changed during scan"));
        }
        service.capture.require_source(&config.monitor)?;
        let count = if config.paged {
            queue::summary(ctx)?["total"].as_u64().unwrap_or(0) as usize
        } else {
            queued(ctx)?
        };
        let allowance = 5.min(config.queue_limit.saturating_sub(count));
        if allowance == 0 {
            return reply(
                ctx,
                config.paged,
                "queue_full",
                config.interval_seconds,
                vec![],
            );
        }
        let pending = if config.paged {
            BTreeMap::new()
        } else {
            pending_hashes(ctx)?
        };
        let saved = capture::saved_hashes(ctx)?;
        let start = runtime.cursor % eligible.len();
        let mut selected = Vec::new();
        for offset in 0..eligible.len() {
            let index = (start + offset) % eligible.len();
            let (rid, raw) = &eligible[index];
            let Ok(rect) = serde_json::from_value::<crate::types::Rect>(raw.clone()) else {
                continue;
            };
            if rect.validate(image.width(), image.height()).is_err() {
                continue;
            }
            let crop = image.crop_imm(rect.x, rect.y, rect.w, rect.h);
            let hash = media::dhash(&crop);
            if saved
                .get(rid)
                .into_iter()
                .chain(pending.get(rid))
                .flatten()
                .any(|previous| media::hamming(&hash, previous) <= 2)
            {
                continue;
            }
            if config.paged && queue_duplicate(ctx, rid, &hash)? {
                continue;
            }
            selected.push(json!({"id":rid,"phash":hash,"base64_image":STANDARD.encode(media::png(&crop).map_err(bad)?),"label":"","rect":rect,"watch":true}));
            runtime.cursor = (index + 1) % eligible.len();
            if selected.len() == allowance {
                break;
            }
        }
        if selected.is_empty() {
            runtime.cursor = (start + 1) % eligible.len();
            runtime.reserved = 0;
            put_runtime(ctx, &runtime)?;
            let conn = ctx.connection()?;
            ctx.ensure_active()?;
            persist(&conn, &runtime)?;
            drop(conn);
            return reply(
                ctx,
                config.paged,
                "duplicate",
                config.interval_seconds,
                vec![],
            );
        }
        let suffix = uuid();
        let frame_id = format!("watch:{suffix}");
        let source = format!("watch_{suffix}.png");
        for item in &mut selected {
            item["source"] = json!(source);
            item["sample_key"] = json!(format!(
                "{}:{}:{source}",
                item["id"].as_str().unwrap_or(""),
                item["phash"].as_str().unwrap_or("")
            ));
            item["game_id"] = json!(game_id);
            item["watch_frame_id"] = json!(frame_id);
        }
        let small = image.thumbnail(400, 400).to_rgb8();
        let mut thumbnail = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut thumbnail, 60)
            .encode_image(&small)
            .map_err(|e| bad(e.to_string()))?;
        let frame = json!({"id":frame_id,"source":source,"regions":selected,"game_id":game_id,"thumb":STANDARD.encode(thumbnail),"watch":true,"frame_width":image.width(),"frame_height":image.height()});
        let path = datasets::file(&ctx.captures(), &source)?;
        let bytes = media::png(&image).map_err(bad)?;
        {
            let mut conn = ctx.connection()?;
            ctx.ensure_active()?;
            lease_current(service, ctx, id)?;
            service.registry.resolve(&ctx.id)?;
            if service.capture.config()?.hash != layout.hash {
                service.watch.stop(&ctx.id, None)?;
                return Err(conflict("Capture configuration changed during scan"));
            }
            let tx = conn.transaction()?;
            fs::write(&path, bytes)?;
            let saved = (|| -> LabResult<()> {
                tx.execute("INSERT INTO full_captures(filename,monitor,timestamp,regions_hash) VALUES(?,?,?,?)",params![source,config.monitor,now_ms(),capture::region_hash(&layout)?])?;
                if config.paged {
                    for item in &selected {
                        queue::ingest_conn(&tx, ctx, item, &frame)?;
                    }
                    queue::bump(&tx)?;
                } else {
                    tx.execute("INSERT INTO watch_inbox(frame_id,source,created_at,payload) VALUES(?,?,?,?)",params![frame_id,source,now_ms(),frame.to_string()])?;
                }
                persist(&tx, &runtime)?;
                tx.commit()?;
                Ok(())
            })();
            if saved.is_err() {
                let _ = fs::remove_file(path);
            }
            saved?;
        }
        runtime.reserved = 0;
        put_runtime(ctx, &runtime)?;
        let frame = if config.paged {
            queue::frame_metadata(ctx, &frame)?
        } else {
            frame
        };
        reply(
            ctx,
            config.paged,
            "added",
            config.interval_seconds,
            vec![frame],
        )
    })();
    let reset = (|| -> LabResult<()> {
        let mut current = load_runtime(ctx)?;
        current.reserved = 0;
        put_runtime(ctx, &current)?;
        service.watch.release(&scan)?;
        Ok(())
    })();
    if let Err(error) = reset {
        if outcome.is_ok() {
            return Err(error);
        }
    }
    outcome
}
fn lease_current(service: &LabService, ctx: &DatasetContext, id: &str) -> LabResult<()> {
    let state = ctx
        .state
        .lock()
        .map_err(|_| conflict("Dataset state lock poisoned"))?;
    if state["watch_runtime"]["lease_id"] != id || !service.watch.valid(&ctx.id, id)? {
        return Err(conflict("Capture watch lease is no longer active"));
    }
    Ok(())
}
pub fn handle(
    service: &LabService,
    ctx: &Arc<DatasetContext>,
    request: &LabRequest,
) -> Option<LabResult<LabResponse>> {
    let paged =
        request.body["queue_mode"] == "paged" || request.query("queue_mode") == Some("paged");
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/watch/start") => Some((|| {
            let config = Config::parse(&request.body)?;
            service.capture.require_source(&config.monitor)?;
            let hash = service.capture.config()?.hash;
            review::ensure(ctx)?;
            if config.paged {
                queue::ensure(ctx)?;
            } else {
                ctx.connection()?.execute_batch("CREATE TABLE IF NOT EXISTS watch_inbox(frame_id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL)")?;
            }
            let mut runtime = load_runtime(ctx)?;
            let id = uuid();
            runtime.lease_id = Some(id.clone());
            runtime.config = Some(config.clone());
            runtime.config_hash = Some(hash);
            runtime.reserved = 0;
            put_runtime(ctx, &runtime)?;
            service.watch.start(&ctx.id, &id)?;
            let mut response = json!({"lease_id":id,"config":config.json(),"status":"ready","queued_count":if config.paged{queue::summary(ctx)?["total"].as_u64().unwrap_or(0)as usize}else{queued(ctx)?}});
            if config.paged {
                response["summary"] = queue::summary(ctx)?;
            }
            Ok(LabResponse::ok(response))
        })()),
        ("POST", "/api/watch/stop") => Some((|| {
            let id = request.body["lease_id"].as_str();
            let stopped = if let Some(id) = id {
                service.watch.stop(&ctx.id, Some(id))?
            } else {
                false
            };
            if let Some(id) = id {
                let mut runtime = load_runtime(ctx)?;
                if runtime.lease_id.as_deref() == Some(id) {
                    runtime.lease_id = None;
                    put_runtime(ctx, &runtime)?;
                }
            }
            Ok(LabResponse::ok(json!({"success":true,"stopped":stopped})))
        })()),
        ("POST", "/api/watch/tick") => Some(
            tick(
                service,
                ctx,
                request.body["lease_id"].as_str().unwrap_or(""),
            )
            .map(LabResponse::ok),
        ),
        ("GET", "/api/watch/inbox") => Some((|| {
            if paged {
                let page = queue::page(ctx, None, 60, "newest")?;
                Ok(LabResponse::ok(
                    json!({"frames":[],"items":page["items"],"next_cursor":page["next_cursor"],"summary":page["summary"],"queued_count":page["summary"]["total"]}),
                ))
            } else {
                Ok(LabResponse::ok(
                    json!({"frames":frames(ctx)?,"queued_count":queued(ctx)?}),
                ))
            }
        })()),
        ("POST", "/api/watch/claim") => Some((|| {
            if paged {
                let page = queue::page(ctx, None, 60, "newest")?;
                Ok(LabResponse::ok(
                    json!({"session":queue::session(ctx)?,"frames":[],"collection_page":page,"summary":page["summary"],"queued_count":page["summary"]["total"]}),
                ))
            } else {
                let session = request
                    .body
                    .get("session")
                    .cloned()
                    .unwrap_or(raw_session(ctx)?);
                let session = save_session(ctx, &session)?;
                Ok(LabResponse::ok(
                    json!({"session":session,"frames":frames(ctx)?,"queued_count":queued(ctx)?}),
                ))
            }
        })()),
        ("POST", "/api/watch/discard") => Some((|| {
            let frames_selector = queue::selectors(&request.body, "frame_ids", 1000)?;
            let keys = queue::selectors(&request.body, "sample_keys", 1000)?;
            if frames_selector
                .iter()
                .chain(&keys)
                .any(|id| id.chars().count() > 512)
            {
                return Err(bad("Watch selectors must be a bounded list of identifiers"));
            }
            remove(ctx, &frames_selector, &keys, false)?;
            Ok(LabResponse::ok(
                json!({"success":true,"frames":frames(ctx)?,"queued_count":queued(ctx)?}),
            ))
        })()),
        ("POST", "/api/save_session_progress") => Some((|| {
            if paged {
                queue::save_checkpoint(ctx, &request.body, false)?;
            } else {
                save_session(ctx, &request.body)?;
            }
            Ok(LabResponse::ok(json!({"success":true})))
        })()),
        ("GET", "/api/get_session_progress") => Some(
            (if paged {
                queue::session(ctx)
            } else {
                merged_session(ctx)
            })
            .map(LabResponse::ok),
        ),
        ("POST", "/api/clear_session") => Some((|| {
            service.watch.stop(&ctx.id, None)?;
            if paged {
                queue::discard(ctx, &[], &[], true)?;
                queue::save_checkpoint(
                    ctx,
                    &json!({"queue_mode":"paged","review_batch":null,"currentReviewIdx":0,"maxReachedIdx":0,"labelingUnlocked":false,"reviewUnlocked":false,"currentView":"collection"}),
                    true,
                )?;
                return Ok(LabResponse::ok(
                    json!({"success":true,"summary":queue::summary(ctx)?}),
                ));
            }
            remove(ctx, &[], &[], true)?;
            {
                let mut state = ctx
                    .state
                    .lock()
                    .map_err(|_| conflict("Dataset state lock poisoned"))?;
                state["session_phashes"] = json!({});
                state["session_game_ids"] = json!([]);
            }
            save_session(ctx, &json!({"frames":[],"pool":[]}))?;
            Ok(LabResponse::ok(json!({"success":true})))
        })()),
        _ => None,
    }
}
