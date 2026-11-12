//! Gameplay's desktop backend: capture, evidence admission and binary delivery
//! run in Rust on blocking workers, independently of GTK and the legacy WSGI pipe.
use super::{capture::Capture, store::Store};
use crate::lab::model::worker::Ocr;
use http;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Instant,
};

type Result<T> = std::result::Result<T, String>;

pub struct Gameplay {
    repo: PathBuf,
    root: PathBuf,
    config_root: PathBuf,
    capture: Capture,
    ocr: Mutex<Ocr>,
    store: OnceLock<Store>,
    capture_lock: Mutex<HashMap<String, Instant>>,
    cancelled: Arc<AtomicBool>,
    admission: Mutex<()>,
    contract: OnceLock<Contract>,
    color_cache: Mutex<super::colors::ColorCache>,
}

impl Gameplay {
    /// Keep source/runtime paths bound to this backend across in-place reloads.
    /// Storage and model startup stay lazy, so an idle app does no recording work.
    pub fn new(repo: PathBuf, environment: &HashMap<String, String>) -> Self {
        let root = environment
            .get("POKER_GAMEPLAY_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::lab::model::storage_paths::directory(environment, "data")
                    .join("gameplay_recordings")
            });
        let ocr = Ocr::new(&repo, environment);
        let cancelled = ocr.cancellation();
        Self {
            cancelled,
            admission: Mutex::new(()),
            contract: OnceLock::new(),
            color_cache: Mutex::new(super::colors::ColorCache::default()),
            root,
            config_root: crate::lab::model::storage_paths::directory(environment, "config"),
            capture: Capture::new(repo.clone(), environment.clone()),
            ocr: Mutex::new(ocr),
            repo,
            store: OnceLock::new(),
            capture_lock: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_config_root(
        repo: PathBuf,
        environment: &HashMap<String, String>,
        config_root: PathBuf,
    ) -> Self {
        let mut runtime = Self::new(repo, environment);
        runtime.config_root = config_root;
        runtime
    }

    /// All desktop gameplay routes are owned here; failures never fall back to
    /// Python and silently create a second recorder against the same session.
    pub fn handle(&self, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let result = self.route(request);
        match result {
            Ok(response) => response,
            Err(error) => {
                let (status, message) = error
                    .split_once(':')
                    .and_then(|(code, text)| {
                        code.parse::<u16>()
                            .ok()
                            .filter(|code| [400, 404, 409, 503].contains(code))
                            .map(|code| (code, text.trim()))
                    })
                    .unwrap_or((500, error.as_str()));
                json_response(status, json!({"error":message}))
            }
        }
    }

    /// Initialize one store without holding a recorder/model lock. Stop and
    /// image reads can therefore proceed while a capture is performing OCR.
    fn store(&self) -> Result<&Store> {
        if let Some(store) = self.store.get() {
            return Ok(store);
        }
        let store = Store::new(self.root.clone())?;
        let _ = self.store.set(store);
        Ok(self.store.get().expect("store initialized"))
    }

    /// Cancel model IO promptly and finish any short evidence commit before the
    /// old source backend is considered stopped. No model mutex is acquired.
    pub fn list_page(
        &self,
        kind: &str,
        session: Option<&str>,
        hand: Option<&str>,
        order: &str,
        archived: bool,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        self.store()?
            .list_page(kind, session, hand, order, archived, cursor, limit)
    }

    pub fn shutdown(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        drop(
            self.admission
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
    }

    fn route(&self, request: &http::Request<Vec<u8>>) -> Result<http::Response<Vec<u8>>> {
        let path = request
            .uri()
            .path()
            .strip_prefix("/api/gameplay")
            .unwrap_or("");
        let parts: Vec<_> = path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let method = request.method().as_str();
        let query: HashMap<String, String> = url::Url::parse(&format!(
            "http://localhost/?{}",
            request.uri().query().unwrap_or("")
        ))
        .map_err(|e| e.to_string())?
        .query_pairs()
        .into_owned()
        .collect();
        if method == "GET" && parts == ["sources"] {
            return Ok(json_response(
                200,
                json!({"sources":self.capture.sources()?,"backend":"rust"}),
            ));
        }
        let store = self.store()?;
        let value = match (method, parts.as_slice()) {
            ("GET", []) => {
                let archived = query.get("archived").map(String::as_str).unwrap_or("0");
                if !["0", "1"].contains(&archived) {
                    return Err("400:archived must be 0 or 1".into());
                }
                json!({"sessions":store.sessions(archived=="1")?})
            }
            ("POST", ["sessions"]) => {
                let body = body(request)?;
                let source = body["source"]
                    .as_str()
                    .ok_or("400:Select an available capture source")?;
                if !self
                    .capture
                    .sources()?
                    .iter()
                    .any(|item| item["name"] == source)
                {
                    return Err("400:Select an available capture source".into());
                }
                let interval = body
                    .get("interval_ms")
                    .unwrap_or(&json!(1000))
                    .as_u64()
                    .ok_or("400:Invalid capture interval")?;
                let name = body
                    .get("name")
                    .map(|v| v.as_str().ok_or("400:Invalid recording name"))
                    .transpose()?
                    .unwrap_or("");
                let (config, hash) = self.config()?;
                return Ok(json_response(
                    201,
                    json!({"session":store.create(source,interval,name.trim(),&config,&hash)?}),
                ));
            }
            ("GET", ["sessions", id]) => {
                json!({"session":store.session(id)?,"hands":store.hands(id)?})
            }
            ("POST", ["sessions", id, "rename"]) => {
                json!({"session":store.rename(id,body(request)?["name"].as_str().ok_or("400:Invalid recording name")?)?})
            }
            ("POST", ["sessions", id, "stop"]) => json!({"session":store.stop(id)?}),
            ("POST", ["sessions", id, "archive"]) => json!({"session":store.archive(id)?}),
            ("POST", ["sessions", id, "restore"]) => json!({"session":store.restore(id)?}),
            ("POST", ["sessions", id, "capture"]) => {
                let result = self.record_frame(id)?;
                if result["skipped"] == true {
                    result
                } else {
                    json!({"frame":self.color_frame(result),"session":store.session(id)?})
                }
            }
            ("GET", ["sessions", id, "frames"]) => {
                let offset = query
                    .get("offset")
                    .map(|s| s.parse::<u64>())
                    .transpose()
                    .map_err(|_| "400:Invalid frame page")?
                    .unwrap_or(0);
                let limit = query
                    .get("limit")
                    .map(|s| s.parse::<u64>())
                    .transpose()
                    .map_err(|_| "400:Invalid frame page")?
                    .unwrap_or(50);
                let hand =
                    query
                        .get("hand_id")
                        .map(|s| if s.is_empty() { None } else { Some(s.as_str()) });
                store.frames(
                    id,
                    hand,
                    offset,
                    limit,
                    query.get("order").map(String::as_str).unwrap_or("asc"),
                )?
            }
            ("GET", ["frames", id]) => json!({"frame":self.color_frame(store.frame(id,true)?)}),
            ("GET", ["frames", id, variant @ ("image" | "thumbnail" | "preview")]) => {
                return self.image(id, variant, request)
            }
            ("POST", ["frames", "prune-invalid"]) => {
                let body = body(request)?;
                let dry = body
                    .get("dry_run")
                    .map(|v| v.as_bool().ok_or("400:dry_run must be boolean"))
                    .transpose()?
                    .unwrap_or(true);
                let session = body
                    .get("session_id")
                    .map(|v| v.as_str().ok_or("400:Invalid session ID"))
                    .transpose()?;
                store.prune(dry, session)?
            }
            _ => return Err("404:Unknown gameplay endpoint".into()),
        };
        Ok(json_response(200, value))
    }

    /// Snapshot the same configuration assets used by collection, with a stable
    /// content hash for every admitted frame. Never reuse a prior frame's OCR.
    fn color_frame(&self, frame: Value) -> Value {
        self.color_cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .enrich(&self.root, frame)
    }

    fn config_path(&self, name: &str) -> PathBuf {
        // The Python worker seeds config on startup; fixtures can still use bundled defaults.
        let path = self.config_root.join(name);
        if path.is_file() {
            path
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("assets")
                .join(name)
        }
    }

    fn config(&self) -> Result<(Value, String)> {
        let regions: Value = serde_json::from_slice(
            &fs::read(self.config_path("regions.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let colors: Value = serde_json::from_slice(
            &fs::read(self.config_path("colors.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([regions, colors])).map_err(|e| e.to_string())?
            )
        );
        Ok((json!({"regions":regions,"colors":colors}), hash))
    }

    /// Capture and OCR are serialized separately from serving requests. Only
    /// immutable original PNG bytes enter evidence storage after the hand gate.
    fn record_frame(&self, id: &str) -> Result<Value> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("409:Poker Lab backend has stopped".into());
        }
        let mut captures = self
            .capture_lock
            .try_lock()
            .map_err(|_| "409:A gameplay capture is already running")?;
        let started = Instant::now();
        let store = self.store()?;
        let session = store.session(id)?;
        if session["status"] == "stopped" || session["archived"] == true {
            return Err("409:Recording session has stopped".into());
        }
        let interval = session["interval_ms"]
            .as_u64()
            .ok_or("Invalid saved capture interval")?;
        if captures
            .get(id)
            .is_some_and(|last| last.elapsed().as_millis() < interval as u128)
        {
            return Err("409:Wait for the capture interval".into());
        }
        captures.insert(id.into(), started);
        let (config, hash) = self.config()?;
        let captured_at = chrono::Utc::now().to_rfc3339();
        let png = self.capture.capture(
            session["source"]
                .as_str()
                .ok_or("Invalid saved capture source")?,
        )?;
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let capture_ms = started.elapsed().as_secs_f64() * 1000.;
        let regions = &config["regions"];
        if regions["screen_width"]
            .as_u64()
            .is_some_and(|v| v != image.width() as u64)
            || regions["screen_height"]
                .as_u64()
                .is_some_and(|v| v != image.height() as u64)
        {
            return Ok(
                json!({"skipped":true,"reason":"Capture dimensions do not match the configured table layout."}),
            );
        }
        let ocr_started = Instant::now();
        let evidence = self.read_frame(&image, regions);
        let (results, hand, crop_count) = match evidence {
            Ok(Some(value)) => value,
            Ok(None) => {
                return Ok(
                    json!({"skipped":true,"reason":"No readable poker hand ID in this frame."}),
                )
            }
            Err(error) => {
                return Ok(
                    json!({"skipped":true,"reason":format!("OCR failed; frame was not saved: {error}")}),
                )
            }
        };
        let ocr_ms = ocr_started.elapsed().as_secs_f64() * 1000.;
        let _admission = self
            .admission
            .lock()
            .map_err(|_| "Evidence admission lock poisoned")?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("409:Poker Lab backend has stopped".into());
        }
        store.admit(id,&png,image.width(),image.height(),&captured_at,&config,&hash,&results,&hand,
            &json!({"capture_ms":capture_ms,"ocr_ms":ocr_ms,"total_ms":started.elapsed().as_secs_f64()*1000.,"ocr_requests":if crop_count>1 {2} else {1},"crop_count":crop_count,"backend":"rust"}))
    }

    /// Use the checked-in OCR contract for both region selection and completed
    /// text validity. The trained inference sidecar receives crops, never frames.
    fn read_frame(
        &self,
        image: &DynamicImage,
        regions: &Value,
    ) -> Result<Option<(Value, String, usize)>> {
        if self.contract.get().is_none() {
            let raw = fs::read(self.repo.join("dev_tools/ocr_contract.json"))
                .map_err(|e| e.to_string())?;
            let _ = self.contract.set(Contract::parse(&raw)?);
        }
        let contract = self.contract.get().expect("contract initialized");
        let mut fields = Vec::new();
        walk(regions, "", &mut fields);
        fields.retain(|(id, _)| {
            !["nameplate", "screen_width", "screen_height", "note"]
                .iter()
                .any(|part| id.contains(part))
                && contract.category(id).is_some()
        });
        fields.sort_by_key(|(id, _)| id != "round_id");
        if fields.first().is_none_or(|(id, _)| id != "round_id") {
            return Err("No configured poker hand ID region".into());
        }
        // Reject non-table pixels after encoding only the hand-ID crop.
        let first_crop = (crop(image, &fields[0].1)?, fields[0].0.clone());
        let mut model = self.ocr.lock().map_err(|_| "OCR worker lock poisoned")?;
        let first = model
            .predict_many(vec![first_crop])?
            .into_iter()
            .next()
            .ok_or("Missing hand ID prediction")?;
        if !contract.valid("round_id", first["text"].as_str().unwrap_or("")) {
            return Ok(None);
        }
        let hand = first["text"]
            .as_str()
            .unwrap()
            .trim_start_matches('#')
            .trim()
            .to_string();
        let mut predictions = vec![first];
        if fields.len() > 1 {
            let crops = fields[1..]
                .iter()
                .map(|(id, rect)| Ok((crop(image, rect)?, id.clone())))
                .collect::<Result<_>>()?;
            predictions.extend(model.predict_many(crops)?);
        }
        if predictions.len() != fields.len() {
            return Err("Incomplete OCR crop batch".into());
        }
        let mut results = serde_json::Map::new();
        for ((id, rect), mut prediction) in fields.iter().zip(predictions) {
            let category = contract.category(id).ok_or("Unsupported OCR field")?;
            let schema_valid = contract.valid(category, prediction["text"].as_str().unwrap_or(""));
            let object = prediction.as_object_mut().ok_or("Invalid OCR prediction")?;
            object.insert("schema_valid".into(), json!(schema_valid));
            object.insert("validation_contract_sha256".into(), json!(contract.digest));
            results.insert(
                id.to_string(),
                json!({"prediction":prediction,"error":null,"rect":rect}),
            );
        }
        Ok(Some((Value::Object(results), hand, fields.len())))
    }

    /// Deliver raw binary directly to WebKit. Conditional requests skip image
    /// decoding and file reads once a preview has already been displayed.
    fn image(
        &self,
        id: &str,
        variant: &str,
        request: &http::Request<Vec<u8>>,
    ) -> Result<http::Response<Vec<u8>>> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("404:Gameplay frame not found".into());
        }
        let store = self.store()?;
        store.frame(id, false)?;
        let etag = format!("\"{id}-{variant}\"");
        if request
            .headers()
            .get("if-none-match")
            .is_some_and(|v| v.as_bytes() == etag.as_bytes())
        {
            return http::Response::builder()
                .status(304)
                .header("ETag", etag)
                .body(Vec::new())
                .map_err(|e| e.to_string());
        }
        let original = store.root().join("frames").join(format!("{id}.png"));
        let path = match variant {
            "image" => original.clone(),
            "preview" => original.with_extension("preview.jpg"),
            _ => original.with_extension("thumb.jpg"),
        };
        if variant != "image" && !path.is_file() {
            let image = image::open(&original).map_err(|e| e.to_string())?;
            let (w, h) = if variant == "preview" {
                (1280, 720)
            } else {
                (256, 144)
            };
            let resized = if image.width() > w || image.height() > h {
                image.thumbnail(w, h)
            } else {
                image
            };
            let mut bytes = Vec::new();
            JpegEncoder::new_with_quality(&mut bytes, 75)
                .encode_image(&resized.to_rgb8())
                .map_err(|e| e.to_string())?;
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
            fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::remove_file(temporary);
                return Err(error.to_string());
            }
        }
        let bytes = fs::read(&path).map_err(|_| "404:Gameplay frame image not found")?;
        http::Response::builder()
            .status(200)
            .header(
                "Content-Type",
                if variant == "image" {
                    "image/png"
                } else {
                    "image/jpeg"
                },
            )
            .header("Cache-Control", "private, max-age=31536000, immutable")
            .header("ETag", etag)
            .body(bytes)
            .map_err(|e| e.to_string())
    }
}

/// Require JSON objects so malformed requests cannot become accidental defaults.
fn body(request: &http::Request<Vec<u8>>) -> Result<Value> {
    let body: Value =
        serde_json::from_slice(request.body()).map_err(|_| "400:Expected a JSON object")?;
    if !body.is_object() {
        return Err("400:Expected a JSON object".into());
    }
    Ok(body)
}
fn json_response(status: u16, value: Value) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&value).unwrap())
        .unwrap()
}
/// Walk original region identities without inferring or renaming fields.
fn walk(value: &Value, key: &str, fields: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(object) if object.contains_key("x") => {
            fields.push((key.into(), value.clone()))
        }
        Value::Object(object) => {
            for (name, value) in object {
                walk(
                    value,
                    &if key.is_empty() {
                        name.clone()
                    } else {
                        format!("{key}.{name}")
                    },
                    fields,
                );
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter().enumerate() {
                walk(value, &format!("{key}[{index}]"), fields);
            }
        }
        _ => {}
    }
}
/// Compile schema patterns once per backend. Recording never rebuilds hundreds
/// of regex automata for the same configuration on each captured frame.
struct Contract {
    digest: String,
    regions: Vec<(Regex, String)>,
    patterns: HashMap<String, Regex>,
    values: HashMap<String, Vec<String>>,
}
impl Contract {
    fn parse(raw: &[u8]) -> Result<Self> {
        let value: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
        let compile =
            |pattern: &str| Regex::new(&format!(r"\A(?:{pattern})\z")).map_err(|e| e.to_string());
        let mut regions = Vec::new();
        for rule in value["region_rules"]
            .as_array()
            .ok_or("Invalid OCR region contract")?
        {
            regions.push((
                compile(rule["pattern"].as_str().ok_or("Missing region pattern")?)?,
                rule["category"]
                    .as_str()
                    .ok_or("Missing category")?
                    .to_string(),
            ));
        }
        let mut patterns = HashMap::new();
        let mut values = HashMap::new();
        for (category, rule) in value["categories"]
            .as_object()
            .ok_or("Invalid OCR category contract")?
        {
            if let Some(pattern) = rule["pattern"].as_str() {
                patterns.insert(category.clone(), compile(pattern)?);
            }
            if let Some(choices) = rule["values"].as_array() {
                values.insert(
                    category.clone(),
                    choices
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .map(String::from)
                                .ok_or("Invalid schema value".into())
                        })
                        .collect::<Result<_>>()?,
                );
            }
        }
        Ok(Self {
            digest: format!("{:x}", Sha256::digest(raw)),
            regions,
            patterns,
            values,
        })
    }
    fn category(&self, id: &str) -> Option<&str> {
        self.regions
            .iter()
            .find(|(re, _)| re.is_match(id))
            .map(|(_, category)| category.as_str())
    }
    fn valid(&self, category: &str, text: &str) -> bool {
        self.values
            .get(category)
            .is_some_and(|choices| choices.iter().any(|v| v == text))
            || self
                .patterns
                .get(category)
                .is_some_and(|re| re.is_match(text))
    }
}
/// Reject invalid or out-of-bounds rectangles rather than clipping evidence.
fn crop(image: &DynamicImage, rect: &Value) -> Result<Vec<u8>> {
    let get = |key| {
        rect[key]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("Invalid capture rectangle".to_string())
    };
    let (x, y, w, h) = (get("x")?, get("y")?, get("w")?, get("h")?);
    if w == 0
        || h == 0
        || x.checked_add(w).is_none_or(|v| v > image.width())
        || y.checked_add(h).is_none_or(|v| v > image.height())
    {
        return Err("Configured region is outside the captured frame".into());
    }
    let mut buffer = Cursor::new(Vec::new());
    image
        .crop_imm(x, y, w, h)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buffer.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        repo: PathBuf,
        gameplay: Gameplay,
    }
    impl Fixture {
        fn new() -> Self {
            let repo = std::env::temp_dir().join(format!(
                "poker-gameplay-routes-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&repo).unwrap();
            let environment = HashMap::from([
                (
                    "POKER_GAMEPLAY_ROOT".into(),
                    repo.join("recordings").to_string_lossy().into_owned(),
                ),
                (
                    "XDG_CONFIG_HOME".into(),
                    repo.join("config").to_string_lossy().into_owned(),
                ),
            ]);
            let gameplay = Gameplay::new(repo.clone(), &environment);
            Self { repo, gameplay }
        }
        fn request(&self, method: &str, path: &str, data: Value) -> http::Response<Vec<u8>> {
            self.gameplay.handle(
                &http::Request::builder()
                    .method(method)
                    .uri(format!("pokerlab://localhost/api/gameplay{path}"))
                    .body(serde_json::to_vec(&data).unwrap())
                    .unwrap(),
            )
        }
        fn seed(&self) -> (String, String, Vec<u8>) {
            let store = self.gameplay.store().unwrap();
            let session = store
                .create("monitor", 1000, "Saved evidence", &json!({}), "hash")
                .unwrap();
            let id = session["id"].as_str().unwrap().to_owned();
            let mut png = Cursor::new(Vec::new());
            DynamicImage::new_rgb8(100, 50)
                .write_to(&mut png, ImageFormat::Png)
                .unwrap();
            let png = png.into_inner();
            let frame = store
                .admit(
                    &id,
                    &png,
                    100,
                    50,
                    "2026-11-12T01:00:00Z",
                    &json!({}),
                    "hash",
                    &json!({}),
                    "123456",
                    &json!({}),
                )
                .unwrap();
            (id, frame["id"].as_str().unwrap().to_owned(), png)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.repo);
        }
    }

    #[test]
    fn native_routes_read_existing_evidence_and_deliver_binary() {
        let fixture = Fixture::new();
        let (session, frame, png) = fixture.seed();
        let page = fixture.request(
            "GET",
            &format!("/sessions/{session}/frames?limit=12&order=desc"),
            json!({}),
        );
        assert_eq!(page.status(), 200);
        let page: Value = serde_json::from_slice(page.body()).unwrap();
        assert_eq!(page["total"], 1);
        assert!(page["frames"][0].get("results").is_none());
        let response = fixture.request("GET", &format!("/frames/{frame}/image"), json!({}));
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.body(), &png);
        let preview = fixture.request("GET", &format!("/frames/{frame}/preview"), json!({}));
        assert_eq!(preview.headers()["content-type"], "image/jpeg");
        let decoded = image::load_from_memory(preview.body()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (100, 50));
        let cached = fixture.gameplay.handle(
            &http::Request::builder()
                .uri(format!(
                    "pokerlab://localhost/api/gameplay/frames/{frame}/preview"
                ))
                .header("If-None-Match", preview.headers()["etag"].clone())
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(cached.status(), 304);
        assert!(cached.body().is_empty());
        assert_eq!(
            fixture
                .request("POST", &format!("/sessions/{session}/stop"), json!({}))
                .status(),
            200
        );
        assert_eq!(
            fixture
                .request("POST", &format!("/sessions/{session}/capture"), json!({}))
                .status(),
            409
        );
    }

    #[test]
    fn invalid_requests_fail_in_native_backend() {
        let fixture = Fixture::new();
        let (session, _, _) = fixture.seed();
        assert_eq!(
            fixture
                .request("GET", "?archived=banana", json!({}))
                .status(),
            400
        );
        assert_eq!(
            fixture
                .request(
                    "GET",
                    &format!("/sessions/{session}/frames?offset=-1"),
                    json!({})
                )
                .status(),
            400
        );
        assert_eq!(
            fixture
                .request(
                    "GET",
                    &format!("/sessions/{session}/frames?limit=101"),
                    json!({})
                )
                .status(),
            400
        );
        assert_eq!(
            fixture
                .request("POST", "/frames/prune-invalid", json!({"dry_run":"no"}))
                .status(),
            400
        );
        assert_eq!(
            fixture
                .request("GET", "/frames/not-a-frame/image", json!({}))
                .status(),
            404
        );
        assert_eq!(
            fixture
                .request("GET", "/sessions/missing", json!({}))
                .status(),
            404
        );
    }

    #[test]
    fn contract_and_crop_checks_preserve_exact_fields() {
        let contract = Contract::parse(crate::labels::CONTRACT_BYTES).unwrap();
        assert_eq!(contract.category("seats[0].bank"), Some("bank"));
        assert!(contract.category("nameplate").is_none());
        assert!(contract.valid("round_id", "#123456"));
        assert!(!contract.valid("round_id", "123456"));
        assert!(contract.valid("dealer", ""));
        assert!(!contract.valid("bank", "G 2.34 BB"));
        let image = DynamicImage::new_rgb8(10, 10);
        assert!(crop(&image, &json!({"x":9,"y":0,"w":2,"h":2})).is_err());
        assert!(crop(&image, &json!({"x":true,"y":0,"w":2,"h":2})).is_err());
        assert!(crop(&image, &json!({"x":0,"y":0,"w":2,"h":2})).is_ok());
    }
    #[test]
    fn invalid_hand_gate_skips_other_crops_and_shutdown_cancels_work() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.repo.join("dev_tools/training")).unwrap();
        fs::write(
            fixture.repo.join("dev_tools/ocr_contract.json"),
            crate::labels::CONTRACT_BYTES,
        )
        .unwrap();
        fs::write(
            fixture
                .repo
                .join("dev_tools/training/collector_inference.py"),
            r#"
import json,sys
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    items=json.loads(line)['items']
    print(json.dumps({'ok':True,'predictions':[{'text':''} for item in items]}),flush=True)
"#,
        )
        .unwrap();
        let env = HashMap::from([("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into())]);
        let model = Ocr::new(&fixture.repo, &env);
        let token = model.cancellation();
        *fixture.gameplay.ocr.lock().unwrap() = model;
        let result = fixture.gameplay.read_frame(
            &DynamicImage::new_rgb8(10, 10),
            &json!({
                "round_id":{"x":0,"y":0,"w":2,"h":2},
                "pot":{"x":1000,"y":1000,"w":2,"h":2}
            }),
        );
        assert!(
            matches!(result, Ok(None)),
            "invalid table skips unrelated crop encoding: {result:?}"
        );
        // Reset to a manager sharing the backend's lifetime token before shutdown.
        token.store(true, Ordering::SeqCst);
        let (session, _, _) = fixture.seed();
        fixture.gameplay.shutdown();
        assert!(fixture.gameplay.cancelled.load(Ordering::SeqCst));
        assert_eq!(
            fixture
                .request("POST", &format!("/sessions/{session}/capture"), json!({}))
                .status(),
            409
        );
    }
}
