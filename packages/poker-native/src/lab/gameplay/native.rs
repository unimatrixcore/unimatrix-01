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
    pub(super) fn store(&self) -> Result<&Store> {
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

    pub fn list_page_collection(
        &self,
        kind: &str,
        session: Option<&str>,
        hand: Option<&str>,
        order: &str,
        archived: bool,
        cursor: Option<&str>,
        limit: usize,
        collection: Option<&str>,
    ) -> Result<Value> {
        self.store()?.list_page_collection(
            kind, session, hand, order, archived, cursor, limit, collection,
        )
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
            ("GET", ["collections"]) => {
                store.collections(query.get("archived").is_some_and(|v| v == "1"))?
            }
            ("POST", ["collections"]) => {
                json!({"collection":store.create_collection(body(request)?["name"].as_str().ok_or("400:Collection name required")?)?})
            }
            ("PATCH", ["collections", id]) => {
                json!({"collection":store.update_collection(id,&body(request)?)?})
            }
            ("GET", []) => {
                let archived = query.get("archived").map(String::as_str).unwrap_or("0");
                if !["0", "1"].contains(&archived) {
                    return Err("400:archived must be 0 or 1".into());
                }
                let mut sessions = store.sessions(archived == "1")?;
                if let Some(collection) = query.get("collection_id") {
                    sessions.as_array_mut().unwrap().retain(|s| {
                        store
                            .session_collection(s["id"].as_str().unwrap())
                            .is_ok_and(|id| id == *collection)
                    });
                }
                json!({"sessions":sessions})
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
                let session = store.create(source, interval, name.trim(), &config, &hash)?;
                let session = if let Some(collection) = body["collection_id"].as_str() {
                    store.move_session(session["id"].as_str().unwrap(), collection)?
                } else {
                    session
                };
                return Ok(json_response(201, json!({"session":session})));
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
        let current = self.config_root.join("gameplay-regions.json");
        if !current.is_file() {
            return Err("Current Gameplay region profile is missing; synchronize the source-derived profile".into());
        }
        let regions: Value = serde_json::from_slice(&fs::read(current).map_err(|e| e.to_string())?)
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
        if regions["viewport"]["width"]
            .as_u64()
            .is_some_and(|v| v != image.width() as u64)
            || regions["viewport"]["height"]
                .as_u64()
                .is_some_and(|v| v != image.height() as u64)
        {
            return Ok(
                json!({"skipped":true,"reason":"Capture dimensions do not match the verified current region profile"}),
            );
        }
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
        if regions["regions"].is_array() {
            return self.read_profile_frame(image, regions, contract);
        }
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
        let mut first = model
            .predict_many(vec![first_crop])?
            .into_iter()
            .next()
            .ok_or("Missing hand ID prediction")?;
        normalize_model_prediction(regions, "round_id", "round_id", &mut first, contract)?;
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
            normalize_model_prediction(regions, id, category, &mut prediction, contract)?;
            let schema_valid = prediction["schema_valid"].as_bool().unwrap_or(false);
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

    fn read_profile_frame(
        &self,
        image: &DynamicImage,
        profile: &Value,
        contract: &Contract,
    ) -> Result<Option<(Value, String, usize)>> {
        let resolved_profile =
            super::panels::resolve_profile(image, profile).map_err(|error| error.message)?;
        let profile = &resolved_profile;
        let mut results = serde_json::Map::new();
        let mut crops = Vec::new();
        let mut crop_targets = Vec::new();
        for region in profile["regions"]
            .as_array()
            .ok_or("Invalid current region profile")?
        {
            if region["ocr"] == false {
                continue;
            }
            let id = region["id"].as_str().ok_or("Region identity missing")?;
            let Some(category) = contract.category(id) else {
                continue;
            };
            let b = &region["bounds"];
            let rect = json!({"x":b["x"],"y":b["y"],"w":b["width"],"h":b["height"]});
            if super::regions::seat_is_empty(region) {
                results.insert(id.to_string(), json!({"prediction":null,"error":null,"rect":rect,"presence":region["presence"],"seat_occupancy":region["seat_occupancy"]}));
                continue;
            }
            let card_field = ["card", "suit"].contains(&category);
            if !card_field && region["presence"]["state"] == "absent" {
                results.insert(id.to_string(), json!({"prediction":null,"error":null,"rect":rect,"presence":region["presence"]}));
                continue;
            }
            let isolated_partial_bet = category == "bet"
                && region["localization"]["state"] == "partially_occluded"
                && region["guide"]["occlusion"]["partial"] == true
                && region["crop_mask_source"] == "chip_columns_value"
                && region["crop_mask"].is_object()
                && region["localization_error"].is_null();
            if isolated_partial_bet {
                let extracted = (|| -> crate::lab::LabResult<_> {
                    let runs = super::visible_runs::extract_region(image, region)?;
                    runs.into_iter()
                        .map(|run| {
                            let png = run.png()?;
                            Ok((png, serde_json::to_value(run)?))
                        })
                        .collect::<crate::lab::LabResult<Vec<_>>>()
                })();
                let mut observed = Vec::new();
                let mut error = None;
                match extracted {
                    Ok(runs) => {
                        for (index, (png, metadata)) in runs.into_iter().enumerate() {
                            observed.push(metadata);
                            crops.push((png, id.to_string()));
                            crop_targets.push((id.to_string(), false, Some(index)));
                        }
                    }
                    Err(e) => error = Some(e.message),
                }
                results.insert(id.to_string(), json!({
                    "prediction":null,"error":error,"rect":rect,"presence":region["presence"],
                    "occlusion":region["guide"]["occlusion"],"recognition_task":"visible_run",
                    "visible_run_policy":super::visible_runs::POLICY,"coordinate_space":"parent_local",
                    "visible_runs":observed
                }));
                continue;
            }
            let error = if !card_field && region["presence"]["state"] == "ambiguous" {
                Some(format!(
                    "Target presence is ambiguous: {}",
                    region["presence"]["reason"]
                        .as_str()
                        .unwrap_or("unresolved")
                ))
            } else {
                match super::regions::crop(image, region) {
                    Ok(png) => match split_component_crops(&png, region) {
                        Ok(Some(parts)) => {
                            for part in parts {
                                crops.push((part, "bet".to_string()));
                                crop_targets.push((id.to_string(), true, None));
                            }
                            None
                        }
                        Ok(None) => {
                            crops.push((png, id.to_string()));
                            crop_targets.push((id.to_string(), false, None));
                            None
                        }
                        Err(error) => Some(error),
                    },
                    Err(error) => Some(error.message),
                }
            };
            results.insert(
                id.to_string(),
                json!({"prediction":null,"error":error,"rect":rect}),
            );
        }
        let Some(first) = crops
            .iter()
            .position(|(_, id)| id == "round_id" || id == "game.id")
        else {
            return Ok(None);
        };
        let first_crop = crops.remove(first);
        crop_targets.remove(first);
        let first_id = first_crop.1.clone();
        let mut first_prediction = self
            .ocr
            .lock()
            .map_err(|_| "OCR worker lock poisoned")?
            .predict_many(vec![first_crop])?
            .into_iter()
            .next()
            .ok_or("Missing hand ID prediction")?;
        normalize_model_prediction(
            profile,
            &first_id,
            "round_id",
            &mut first_prediction,
            contract,
        )?;
        if !contract.valid("round_id", first_prediction["text"].as_str().unwrap_or("")) {
            return Ok(None);
        }
        first_prediction["schema_valid"] = json!(true);
        first_prediction["validation_contract_sha256"] = json!(contract.digest);
        results.get_mut(&first_id).ok_or("Missing hand ID output")?["prediction"] =
            first_prediction;
        let count = crops.len() + 1;
        let ids = crop_targets;
        if !crops.is_empty() {
            let predictions = self
                .ocr
                .lock()
                .map_err(|_| "OCR worker lock poisoned")?
                .predict_many(crops);
            match predictions {
                Ok(predictions) => {
                    if predictions.len() != ids.len() {
                        return Err("Incomplete OCR crop batch".into());
                    }
                    let mut split_parts = Vec::new();
                    for ((id, component, run_index), mut prediction) in ids.iter().zip(predictions)
                    {
                        if let Some(index) = run_index {
                            prediction["schema_valid"] = json!(false);
                            results.get_mut(id).unwrap()["visible_runs"][*index]["prediction"] =
                                prediction;
                            continue;
                        }
                        let category = if *component {
                            "bet"
                        } else {
                            contract.category(id).ok_or("Unknown OCR field")?
                        };
                        normalize_model_prediction(
                            profile,
                            if *component { "bet" } else { id },
                            category,
                            &mut prediction,
                            contract,
                        )?;
                        if *component {
                            split_parts.push(prediction);
                        } else {
                            results.get_mut(id).unwrap()["prediction"] = prediction;
                        }
                    }
                    if !split_parts.is_empty() {
                        results
                            .get_mut("split_pot")
                            .ok_or("Missing split pot output")?["prediction"] =
                            compose_split_prediction(profile, split_parts, contract)?;
                    }
                }
                Err(error) => {
                    for (id, _, _) in ids {
                        results.get_mut(&id).unwrap()["error"] = json!(error);
                    }
                }
            }
        }
        let hand = results
            .get("round_id")
            .or_else(|| results.get("game.id"))
            .and_then(|r| r["prediction"]["text"].as_str())
            .filter(|text| contract.valid("round_id", text))
            .unwrap_or("")
            .trim_start_matches('#')
            .trim()
            .to_string();
        Ok(Some((Value::Object(results), hand, count)))
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
// Component coordinates are relative to the canonical masked parent crop.
fn split_component_crops(png: &[u8], region: &Value) -> Result<Option<Vec<Vec<u8>>>> {
    if region["id"] != "split_pot" {
        return Ok(None);
    }
    let Some(panels) = region["crop_mask"]["panels"].as_array() else {
        return Ok(None);
    };
    if panels.len() <= 1 {
        return Ok(None);
    }
    if panels.len() > 10 {
        return Err("Too many split pot panels".into());
    }
    let image = image::load_from_memory(png).map_err(|e| e.to_string())?;
    let mut parts = Vec::with_capacity(panels.len());
    for panel in panels {
        let b = &panel["bounds"];
        let number = |key: &str| {
            b[key]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| "Invalid split pot panel bounds".to_string())
        };
        let (x, y, w, h) = (
            number("x")?,
            number("y")?,
            number("width")?,
            number("height")?,
        );
        let (left, top, right, bottom) = (x.floor(), y.floor(), (x + w).ceil(), (y + h).ceil());
        if left < 0.
            || top < 0.
            || right > f64::from(image.width())
            || bottom > f64::from(image.height())
            || right <= left
            || bottom <= top
        {
            return Err("Split pot panel outside its crop".into());
        }
        let rect =
            json!({"x":left as u32,"y":top as u32,"w":(right-left) as u32,"h":(bottom-top) as u32});
        parts.push(crop(&image, &rect)?);
    }
    Ok(Some(parts))
}

fn compose_split_prediction(
    profile: &Value,
    parts: Vec<Value>,
    contract: &Contract,
) -> Result<Value> {
    let text = parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let raw = parts
        .iter()
        .filter_map(|p| p["raw_text"].as_str().or_else(|| p["text"].as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    let confidence = parts
        .iter()
        .map(|p| p["confidence"].as_f64())
        .collect::<Option<Vec<_>>>()
        .and_then(|values| values.into_iter().reduce(f64::min));
    let complete = parts.iter().all(|p| {
        p["schema_valid"] == true && p["text"].as_str().is_some_and(|t| !t.trim().is_empty())
    });
    let mut result = json!({"text":text,"raw_text":raw,"confidence":confidence,"components":parts});
    normalize_model_prediction(profile, "split_pot", "split_pot", &mut result, contract)?;
    if !complete {
        result["schema_valid"] = json!(false);
    }
    Ok(result)
}

fn normalize_model_prediction(
    profile: &Value,
    id: &str,
    category: &str,
    prediction: &mut Value,
    contract: &Contract,
) -> Result<()> {
    let original = prediction["text"].as_str().unwrap_or("").to_owned();
    let raw = prediction["raw_text"].as_str().unwrap_or(&original);
    let context = profile["style_profile"]["currency_format"].as_str();
    let text = if contract.digest == crate::lab::sha256(crate::labels::CONTRACT_BYTES) {
        crate::labels::normalize_region_text_with_currency_format(id, category, raw, context)
    } else {
        original.clone()
    };
    let valid = if contract.digest == crate::lab::sha256(crate::labels::CONTRACT_BYTES) {
        crate::labels::validate_text_with_currency_format(
            category,
            &text,
            category == "dealer",
            context,
        )
    } else {
        contract.valid(category, &text)
    };
    let object = prediction.as_object_mut().ok_or("Invalid OCR prediction")?;
    if !object.contains_key("worker_text") {
        object.insert("worker_text".into(), json!(original));
    }
    if !object.contains_key("worker_validation_contract") {
        if let Some(previous) = object.get("validation_contract").cloned() {
            object.insert("worker_validation_contract".into(), previous);
        }
    }
    object.insert("text".into(), json!(text));
    object.insert("schema_valid".into(), json!(valid));
    object.insert(
        "validation_contract".into(),
        json!({"version":crate::labels::contract_version(),"sha256":contract.digest}),
    );
    object.insert("validation_contract_sha256".into(), json!(contract.digest));
    object.insert("normalization_context".into(),json!({"currency_format":context,"source":if context.is_some(){"explicit_profile"}else{"default_bb_contract"}}));
    Ok(())
}

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
        if self.digest == crate::lab::sha256(crate::labels::CONTRACT_BYTES) {
            return crate::labels::validate_text(category, text, category == "dealer");
        }
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
    fn split_components_keep_visual_order_and_incomplete_results_unverified() {
        let contract = Contract::parse(crate::labels::CONTRACT_BYTES).unwrap();
        let mut parts = vec![
            json!({"text":"S 40 BB","raw_text":"S 40 BB","confidence":0.9,"model_sha256":"model-a"}),
            json!({"text":"G 80 BB","raw_text":"G 80 BB","confidence":0.7,"model_sha256":"model-b"}),
        ];
        for part in &mut parts {
            normalize_model_prediction(&json!({}), "bet", "bet", part, &contract).unwrap();
        }
        let composed = compose_split_prediction(&json!({}), parts.clone(), &contract).unwrap();
        assert_eq!(composed["text"], "S 40 BB G 80 BB");
        assert_eq!(composed["schema_valid"], true);
        assert_eq!(composed["confidence"], 0.7);
        assert_eq!(composed["components"][1]["model_sha256"], "model-b");
        parts[1] = json!({"text":"", "raw_text":"", "schema_valid":false});
        let partial = compose_split_prediction(&json!({}), parts, &contract).unwrap();
        assert_eq!(partial["schema_valid"], false);
        assert!(partial["confidence"].is_null());
        assert_eq!(partial["components"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn split_component_crop_obeys_mask_order_and_rejects_bad_bounds() {
        let mut image = image::RgbImage::new(12, 8);
        image.put_pixel(1, 1, image::Rgb([255, 0, 0]));
        image.put_pixel(7, 5, image::Rgb([0, 255, 0]));
        let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
        let mut region = json!({"id":"split_pot","crop_mask":{"panels":[{"bounds":{"x":0,"y":0,"width":3,"height":3}},{"bounds":{"x":6,"y":4,"width":3,"height":3}}]}});
        let parts = split_component_crops(&png, &region).unwrap().unwrap();
        assert_eq!(
            image::load_from_memory(&parts[0])
                .unwrap()
                .to_rgb8()
                .get_pixel(1, 1)
                .0,
            [255, 0, 0]
        );
        assert_eq!(
            image::load_from_memory(&parts[1])
                .unwrap()
                .to_rgb8()
                .get_pixel(1, 1)
                .0,
            [0, 255, 0]
        );
        region["crop_mask"]["panels"][1]["bounds"]["x"] = json!(20);
        assert!(split_component_crops(&png, &region).is_err());
        region["crop_mask"]["panels"] = json!([{"bounds":{"x":0,"y":0,"width":3,"height":3}}]);
        assert!(split_component_crops(&png, &region).unwrap().is_none());
    }

    #[test]
    fn current_prediction_boundary_preserves_raw_display_text_and_explicit_money_context() {
        let contract = Contract::parse(crate::labels::CONTRACT_BYTES).unwrap();
        let mut name = json!({"text":"JohnSmith","raw_text":"John Smith","confidence":0.9,"model_sha256":"original-model","validation_contract":{"version":1}});
        normalize_model_prediction(&json!({}), "seats[0].name", "name", &mut name, &contract)
            .unwrap();
        assert_eq!(name["text"], "John Smith");
        assert_eq!(name["raw_text"], "John Smith");
        assert_eq!(name["worker_text"], "JohnSmith");
        assert_eq!(name["model_sha256"], "original-model");
        assert_eq!(name["schema_valid"], true);
        normalize_model_prediction(&json!({}), "seats[0].name", "name", &mut name, &contract)
            .unwrap();
        assert_eq!(name["worker_text"], "JohnSmith");
        assert_eq!(name["worker_validation_contract"]["version"], 1);
        let mut amount = json!({"text":"S2.34B","raw_text":"S 2.34 B"});
        normalize_model_prediction(&json!({}), "seats[0].bet", "bet", &mut amount, &contract)
            .unwrap();
        assert_eq!(amount["schema_valid"], false);
        let mut cash = json!({"text":"G2.34K","raw_text":"G 2.34K"});
        normalize_model_prediction(
            &json!({"style_profile":{"currency_format":"{0}"}}),
            "seats[0].bet",
            "bet",
            &mut cash,
            &contract,
        )
        .unwrap();
        assert_eq!(cash["schema_valid"], true);
        assert_eq!(cash["normalization_context"]["source"], "explicit_profile");
        let mut table = json!({"text":"Tigard #17, NLHE - S 0.01/0.02", "raw_text":"Tigard #17, NLHE - S 0.01/0.02"});
        normalize_model_prediction(
            &json!({}),
            "table.info",
            "table_info",
            &mut table,
            &contract,
        )
        .unwrap();
        assert_eq!(table["text"], "Tigard #17, NLHE - S 0.01/0.02");
        assert_eq!(table["schema_valid"], true);
        let mut bad_table = json!({"text":"Tigard #17. NLHE -S 0.010.02", "raw_text":"Tigard #17. NLHE -S 0.010.02"});
        normalize_model_prediction(
            &json!({}),
            "table.info",
            "table_info",
            &mut bad_table,
            &contract,
        )
        .unwrap();
        assert_eq!(bad_table["text"], "Tigard #17. NLHE -S 0.010.02");
        assert_eq!(bad_table["schema_valid"], false);
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
        assert!(contract.valid("bank", "G 2.34 BB"));
        assert!(!contract.valid("bank", "G 2.34 B"));
        let image = DynamicImage::new_rgb8(10, 10);
        assert!(crop(&image, &json!({"x":9,"y":0,"w":2,"h":2})).is_err());
        assert!(crop(&image, &json!({"x":true,"y":0,"w":2,"h":2})).is_err());
        assert!(crop(&image, &json!({"x":0,"y":0,"w":2,"h":2})).is_ok());
    }
    #[test]
    fn profile_reader_batches_split_components_as_one_logical_result() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.repo.join("dev_tools/training")).unwrap();
        fs::write(
            fixture.repo.join("dev_tools/ocr_contract.json"),
            crate::labels::CONTRACT_BYTES,
        )
        .unwrap();
        fs::write(fixture.repo.join("dev_tools/training/collector_inference.py"), r#"
import json,sys
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    items=json.loads(line)['items']
    def predict(i,item):
        text = '# 123456' if item['region_id']=='game.id' else (['S 40 BB','G 80 BB'][i] if item['region_id']=='bet' and i < 2 else ('bad table text' if item['region_id']=='table.info' else ('s' if item['region_id'].endswith('.suit') else 'A')))
        return {'text':text,'raw_text':text,'confidence':0.8,'model_sha256':'fake','region_seen':item['region_id']}
    print(json.dumps({'ok':True,'predictions':[predict(i,item) for i,item in enumerate(items)]}),flush=True)
"#).unwrap();
        *fixture.gameplay.ocr.lock().unwrap() = Ocr::new(
            &fixture.repo,
            &HashMap::from([("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into())]),
        );
        let mask = super::super::crop_mask::from_resolved_panels(
            super::super::crop_mask::SourcePanel::UpperPot,
            [0., 0.],
            &[
                super::super::crop_mask::Rect {
                    x: 0.,
                    y: 0.,
                    width: 4.,
                    height: 4.,
                },
                super::super::crop_mask::Rect {
                    x: 5.,
                    y: 5.,
                    width: 4.,
                    height: 4.,
                },
            ],
        )
        .unwrap();
        let mut fields = vec![
            json!({"id":"game.id","bounds":{"x":0,"y":0,"width":4,"height":4}}),
            json!({"id":"split_pot","bounds":{"x":0,"y":0,"width":10,"height":10},"crop_mask":mask}),
        ];
        let mut card_ids = Vec::new();
        for base in (0..5)
            .map(|i| format!("board.{i}"))
            .chain((0..9).flat_map(|i| (0..2).map(move |j| format!("seat.{i}.card.{j}"))))
        {
            for suffix in ["rank", "suit"] {
                let id = format!("{base}.{suffix}");
                fields.push(json!({"id":id,"bounds":{"x":0,"y":0,"width":4,"height":4},"presence":{"state":if suffix == "rank" {"absent"} else {"ambiguous"}}}));
                card_ids.push(id);
            }
        }
        let mut other_ids = Vec::new();
        for seat in 0..9 {
            for field in ["name", "bank", "bet", "dealer", "status"] {
                let id = format!("seat.{seat}.{field}");
                fields.push(json!({"id":id,"bounds":{"x":0,"y":0,"width":4,"height":4}}));
                other_ids.push(id);
            }
            fields.push(json!({"id":format!("seat.{seat}.nameplate"),"ocr":false,"bounds":{"x":0,"y":0,"width":4,"height":4}}));
        }
        for id in ["pot.total", "table.info"] {
            fields.push(json!({"id":id,"bounds":{"x":0,"y":0,"width":4,"height":4}}));
            other_ids.push(id.to_string());
        }
        let profile = json!({"regions":fields});
        let (results, hand, count) = fixture
            .gameplay
            .read_frame(&DynamicImage::new_rgb8(10, 10), &profile)
            .unwrap()
            .unwrap();
        assert_eq!(hand, "123456");
        assert_eq!(card_ids.len(), 46);
        assert_eq!(count, 96);
        assert_eq!(results.as_object().unwrap().len(), 95);
        for id in &other_ids {
            assert_eq!(results[id]["prediction"]["region_seen"], *id);
        }
        assert_eq!(
            results["table.info"]["prediction"]["raw_text"],
            "bad table text"
        );
        assert_eq!(results["table.info"]["prediction"]["schema_valid"], false);
        assert!(results.get("seat.0.nameplate").is_none());
        for id in &card_ids {
            assert_eq!(results[id]["prediction"]["region_seen"], *id);
        }
        assert_eq!(
            results["split_pot"]["prediction"]["text"],
            "S 40 BB G 80 BB"
        );
        assert_eq!(results["split_pot"]["prediction"]["schema_valid"], true);
        assert_eq!(
            results["split_pot"]["prediction"]["components"][0]["region_seen"],
            "bet"
        );
    }

    #[test]
    fn isolated_partial_bet_reaches_local_worker_with_occlusion_and_clean_pixels() {
        let fixture = Fixture::new();
        let training = fixture.repo.join("dev_tools/training");
        fs::create_dir_all(&training).unwrap();
        fs::write(
            fixture.repo.join("dev_tools/ocr_contract.json"),
            crate::labels::CONTRACT_BYTES,
        )
        .unwrap();
        fs::write(
            training.join("collector_inference.py"),
            r#"
import base64,json,sys
from pathlib import Path
root=Path(__file__).parent/'received'
root.mkdir()
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    items=json.loads(line)['items']
    out=[]
    for item in items:
        region=item['region_id']
        (root/(region+'.png')).write_bytes(base64.b64decode(item['png_base64']))
        text='# 123456' if region=='game.id' else '42'
        out.append({'text':text,'raw_text':text,'region_seen':region})
    print(json.dumps({'ok':True,'predictions':out}),flush=True)
"#,
        )
        .unwrap();
        *fixture.gameplay.ocr.lock().unwrap() = Ocr::new(
            &fixture.repo,
            &HashMap::from([("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into())]),
        );
        let corners = vec![json!({"x":0.0,"y":0.0}); 4];
        let mut partial = json!({
            "id":"seats[0].bet","category":"bet",
            "bounds":{"x":0.0,"y":0.0,"width":20.0,"height":20.0},
            "crop_mask_source":"chip_columns_value",
            "presence":{"state":"ambiguous","reason":"Target is partly occluded"},
            "guide":{"source":"pixel_panel","family":"bet","slot":{"x":0.0,"y":0.0,"width":20.0,"height":20.0},"occlusion":{"partial":true,"occluder_region_ids":["seats[1].bet"]}},
            "localization":{"state":"partially_occluded","panels":[{"x":0.0,"y":0.0,"width":20.0,"height":20.0}],"visible_panels":[{"bounds":{"x":0.0,"y":0.0,"width":10.0,"height":20.0},"corners":corners}]}
        });
        let mut ordinary_ambiguous = partial.clone();
        ordinary_ambiguous["id"] = json!("seats[1].bet");
        ordinary_ambiguous["localization"]["state"] = json!("unresolved");
        let mut wrong_category = partial.clone();
        wrong_category["id"] = json!("seats[0].name");
        wrong_category["category"] = json!("name");
        let mut invalid_mask = partial.clone();
        invalid_mask["id"] = json!("seats[2].bet");
        invalid_mask["localization"]["visible_panels"][0]["bounds"]["width"] = json!(-1.0);
        partial["crop_mask"] = json!({});
        let profile = json!({"regions":[
            {"id":"game.id","bounds":{"x":0,"y":0,"width":4,"height":4}},
            partial,ordinary_ambiguous,wrong_category,invalid_mask
        ]});
        let mut image = image::RgbImage::from_pixel(20, 20, image::Rgb([15, 33, 46]));
        for y in 0..20 {
            for x in 10..20 {
                image.put_pixel(x, y, image::Rgb([250, 205, 0]));
            }
        }
        for y in 4..14 {
            for x in 3..7 {
                image.put_pixel(x, y, image::Rgb([240, 240, 240]));
            }
        }
        // A different glyph continues underneath the occluder. Its visible
        // fragment must be absent even though the surviving prefix parses.
        for y in 4..14 {
            image.put_pixel(9, y, image::Rgb([244, 244, 244]));
        }
        let (results, hand, count) = fixture
            .gameplay
            .read_frame(&DynamicImage::ImageRgb8(image), &profile)
            .unwrap()
            .unwrap();
        assert_eq!(hand, "123456");
        assert_eq!(count, 2);
        let result = &results["seats[0].bet"];
        assert!(result["prediction"].is_null());
        let run = &result["visible_runs"][0];
        assert_eq!(run["prediction"]["region_seen"], "seats[0].bet");
        assert_eq!(run["prediction"]["raw_text"], "42");
        assert_eq!(run["prediction"]["schema_valid"], false);
        assert_eq!(result["presence"]["state"], "ambiguous");
        assert_eq!(result["occlusion"]["partial"], true);
        for id in ["seats[1].bet", "seats[0].name", "seats[2].bet"] {
            assert!(results[id]["error"].is_string(), "{id}");
            assert!(!training.join("received").join(format!("{id}.png")).exists());
        }
        let input = image::open(training.join("received/seats[0].bet.png"))
            .unwrap()
            .to_rgb8();
        assert_eq!(input.dimensions(), (6, 20));
        assert_eq!(input.get_pixel(1, 8).0, [240, 240, 240]);
        assert_eq!(run["rect"]["x"], 2);
        assert_eq!(run["right_boundary"], "open");
    }

    #[test]
    #[ignore = "requires external source-derived occupancy controls"]
    fn source_empty_seats_skip_all_fields_before_crop_or_worker() {
        let root = PathBuf::from(std::env::var("POKER_OCCUPANCY_FIXTURE").unwrap());
        let image = image::open(root.join("frames/empty.png")).unwrap();
        let mut profile: Value = serde_json::from_slice(
            &fs::read(std::env::var("POKER_SOURCE_PROFILE").unwrap()).unwrap(),
        )
        .unwrap();
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.repo.join("dev_tools/training")).unwrap();
        fs::write(
            fixture.repo.join("dev_tools/ocr_contract.json"),
            crate::labels::CONTRACT_BYTES,
        )
        .unwrap();
        fs::write(fixture.repo.join("dev_tools/training/collector_inference.py"), r#"
import json,sys
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    items=json.loads(line)['items']
    assert all(not item['region_id'].startswith(('seats[','seat.')) for item in items)
    print(json.dumps({'ok':True,'predictions':[{'text':'# 123456' if i['region_id']=='game.id' else 'A','region_seen':i['region_id']} for i in items]}),flush=True)
"#).unwrap();
        *fixture.gameplay.ocr.lock().unwrap() = Ocr::new(
            &fixture.repo,
            &HashMap::from([("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into())]),
        );
        profile["cv_regions"] = Value::Null;
        let fields = profile["regions"].as_array_mut().unwrap();
        fields.retain(|r| r["id"].as_str().unwrap().starts_with("seats["));
        let mut seat_ids = Vec::new();
        for region in fields.iter_mut().filter(|r| r["ocr"] != false) {
            seat_ids.push(region["id"].as_str().unwrap().to_string());
            region["bounds"] = json!({"x":100000,"y":100000,"width":4,"height":4});
            region["localizer"] = json!({"kind":"unsupported_empty_must_not_localize"});
        }
        assert_eq!(seat_ids.len(), 81);
        fields.push(json!({"id":"game.id","bounds":{"x":0,"y":0,"width":4,"height":4}}));
        fields.push(json!({"id":"board.0.rank","category":"card","bounds":{"x":0,"y":0,"width":4,"height":4}}));
        let (results, hand, count) = fixture
            .gameplay
            .read_frame(&image, &profile)
            .unwrap()
            .unwrap();
        assert_eq!(hand, "123456");
        assert_eq!(count, 2);
        assert_eq!(results.as_object().unwrap().len(), 83);
        for id in seat_ids {
            assert_eq!(results[&id]["seat_occupancy"]["state"], "empty", "{id}");
            assert_eq!(results[&id]["presence"]["state"], "absent", "{id}");
            assert!(results[&id]["prediction"].is_null(), "{id}");
            assert!(results[&id]["error"].is_null(), "{id}");
        }
        assert_eq!(
            results["board.0.rank"]["prediction"]["region_seen"],
            "board.0.rank"
        );
    }

    #[test]
    #[ignore = "requires the external source-derived screenshot and finalized profile"]
    fn source_split_and_all_cards_reach_fake_worker() {
        let root =
            PathBuf::from(std::env::var("POKER_SOURCE_FIXTURE").expect("set POKER_SOURCE_FIXTURE"));
        let image = image::open(root.join("0000000000000000000000000000abcd.png")).unwrap();
        let source_profile: Value = serde_json::from_slice(
            &fs::read(std::env::var("POKER_SOURCE_PROFILE").expect("set POKER_SOURCE_PROFILE"))
                .unwrap(),
        )
        .unwrap();
        let split = source_profile["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "split_pot")
            .unwrap()
            .clone();
        let resolved =
            super::super::panels::resolve_profile(&image, &json!({"regions":[split.clone()]}))
                .unwrap();
        let resolved_split = &resolved["regions"][0];
        assert_eq!(
            resolved_split["crop_mask"]["panels"]
                .as_array()
                .unwrap()
                .len(),
            10
        );
        let canonical = super::super::regions::crop(&image, resolved_split).unwrap();
        let parts = split_component_crops(&canonical, resolved_split)
            .unwrap()
            .unwrap();
        // Cache admission crops the already-masked RGB parent using these same
        // floor/ceil panel coordinates, then hashes width/height and RGB bytes.
        let parent = image::load_from_memory(&canonical).unwrap().to_rgb8();
        for (part, panel) in parts
            .iter()
            .zip(resolved_split["crop_mask"]["panels"].as_array().unwrap())
        {
            let b = &panel["bounds"];
            let (x, y) = (
                b["x"].as_f64().unwrap().floor() as u32,
                b["y"].as_f64().unwrap().floor() as u32,
            );
            let (right, bottom) = (
                (b["x"].as_f64().unwrap() + b["width"].as_f64().unwrap()).ceil() as u32,
                (b["y"].as_f64().unwrap() + b["height"].as_f64().unwrap()).ceil() as u32,
            );
            let expected =
                image::imageops::crop_imm(&parent, x, y, right - x, bottom - y).to_image();
            assert_eq!(image::load_from_memory(part).unwrap().to_rgb8(), expected);
        }
        for mode in ["valid", "blank", "error"] {
            let fixture = Fixture::new();
            fs::create_dir_all(fixture.repo.join("dev_tools/training")).unwrap();
            fs::write(
                fixture.repo.join("dev_tools/ocr_contract.json"),
                crate::labels::CONTRACT_BYTES,
            )
            .unwrap();
            fs::write(fixture.repo.join("dev_tools/training/collector_inference.py"), r#"
import base64,hashlib,json,os,sys
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    items=json.loads(line)['items']
    if len(items)>1 and os.environ['POKER_TEST_MODE']=='error':
        print(json.dumps({'ok':False,'error':'fake batch error'}),flush=True); continue
    n=0; out=[]
    for item in items:
        region=item['region_id']
        if region=='game.id': text='# 123456'
        elif region=='bet':
            n+=1; text=f'S {n*40} BB'
            if n==5 and os.environ['POKER_TEST_MODE']=='blank': text=''
        else: text='s' if region.endswith('.suit') else 'A'
        out.append({'text':text,'raw_text':text,'confidence':0.8,'model_sha256':'fake','region_seen':region,'png_sha256':hashlib.sha256(base64.b64decode(item['png_base64'])).hexdigest()})
    print(json.dumps({'ok':True,'predictions':out}),flush=True)
"#).unwrap();
            let env = HashMap::from([
                ("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into()),
                ("POKER_TEST_MODE".into(), mode.into()),
            ]);
            *fixture.gameplay.ocr.lock().unwrap() = Ocr::new(&fixture.repo, &env);
            let mut fields = vec![
                json!({"id":"game.id","bounds":{"x":0,"y":0,"width":4,"height":4}}),
                split.clone(),
            ];
            let mut card_ids = Vec::new();
            for base in (0..5)
                .map(|i| format!("board.{i}"))
                .chain((0..9).flat_map(|i| (0..2).map(move |j| format!("seat.{i}.card.{j}"))))
            {
                for suffix in ["rank", "suit"] {
                    let id = format!("{base}.{suffix}");
                    fields.push(json!({"id":id,"bounds":{"x":10,"y":10,"width":4,"height":4},"presence":{"state":if suffix=="rank" {"absent"} else {"ambiguous"}}}));
                    card_ids.push(id);
                }
            }
            assert_eq!(card_ids.len(), 46);
            let (results, _, count) = fixture
                .gameplay
                .read_frame(&image, &json!({"regions":fields}))
                .unwrap()
                .unwrap();
            assert_eq!(count, 57);
            assert_eq!(results.as_object().unwrap().len(), 48);
            if mode == "error" {
                assert!(results["split_pot"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("fake batch error"));
                assert!(results["split_pot"]["prediction"].is_null());
            } else {
                let prediction = &results["split_pot"]["prediction"];
                assert_eq!(prediction["components"].as_array().unwrap().len(), 10);
                assert_eq!(prediction["schema_valid"], mode == "valid");
                if mode == "valid" {
                    assert_eq!(
                        prediction["text"],
                        (1..=10)
                            .map(|n| format!("S {} BB", n * 40))
                            .collect::<Vec<_>>()
                            .join(" ")
                    );
                }
                for (i, part) in parts.iter().enumerate() {
                    assert_eq!(prediction["components"][i]["region_seen"], "bet");
                    assert_eq!(
                        prediction["components"][i]["png_sha256"],
                        crate::lab::sha256(part)
                    );
                }
                for id in &card_ids {
                    assert_eq!(results[id]["prediction"]["region_seen"], *id);
                }
            }
        }
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
