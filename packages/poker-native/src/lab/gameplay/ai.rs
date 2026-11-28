use super::regions as crops;
#[path = "evidence_cache.rs"]
pub mod evidence_cache;
#[path = "quarantine.rs"]
pub mod quarantine;
use crate::lab::datasets::DatasetContext;
use crate::lab::{
    bad, conflict, now_ms, sha256, uuid, LabRequest, LabResponse, LabResult, LabService,
};
use evidence_cache as cache;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

struct PixelMaterial {
    image: image::DynamicImage,
    pixels: String,
    phash: OnceLock<String>,
    png: OnceLock<Arc<Vec<u8>>>,
    uniform_padding: bool,
}
impl PixelMaterial {
    fn new(image: image::DynamicImage) -> LabResult<Self> {
        let rgb = image
            .as_rgb8()
            .ok_or_else(|| bad("Crop must use canonical RGB pixels"))?;
        let mut identity = format!("{}x{}:RGB:", rgb.width(), rgb.height()).into_bytes();
        identity.extend_from_slice(rgb.as_raw());
        let pixels = sha256(&identity);
        let uniform_padding = crops::uniform_padding(&image);
        Ok(Self {
            image,
            pixels,
            phash: OnceLock::new(),
            png: OnceLock::new(),
            uniform_padding,
        })
    }
}
#[derive(serde::Serialize)]
pub struct PixelEvidence {
    pub region_id: String,
    pub category: String,
    pub pixel_sha256: String,
    pub bounds: Value,
    pub guide: Value,
    pub crop_mask: Value,
    pub presence: Value,
    pub seat_occupancy: Value,
    pub card_sampling: Value,
    pub card_plane: Value,
    #[serde(skip)]
    pub png: Vec<u8>,
    #[serde(skip)]
    pub presentation_png: Vec<u8>,
}
pub struct GameplayAi {
    pub(crate) context: Arc<DatasetContext>,
    config: PathBuf,
    projection: Mutex<EffectiveSync>,
    workflow_transition: Mutex<()>,
    read_snapshot: Mutex<Option<ReadSnapshot>>,
    frame_summaries: Mutex<Option<FrameSummaries>>,
    #[cfg(test)]
    projection_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    summary_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    summary_full_reference: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    summary_projection_count: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    summary_cache_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    summary_end_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    manual_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    preparation_hook: Mutex<Option<Arc<dyn Fn(usize) + Send + Sync>>>,
    #[cfg(test)]
    handoff_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
#[cfg(unix)]
fn effective_file_identity(path: &Path) -> LabResult<Option<(u64, u64)>> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok(Some((metadata.dev(), metadata.ino())))
}
#[cfg(not(unix))]
fn effective_file_identity(path: &Path) -> LabResult<Option<(u64, u64)>> {
    fs::metadata(path)?;
    Ok(None)
}
#[derive(Default)]
struct EffectiveSync {
    identity: Option<(u64, u64)>,
    observer: Option<Connection>,
    completed: Option<(ReadSource, String, i64, i64)>,
}
// Bounds the resident summary set; uncached frames retain the normal read path.
const MAX_CACHED_FRAME_SUMMARIES: usize = 4096;
#[derive(Clone, PartialEq, Eq)]
struct RecordingEpoch {
    path: PathBuf,
    identity: (u64, u64),
    data_version: i64,
    schema_version: i64,
}
struct FrameSummaries {
    source: ReadSource,
    profile: String,
    recording: RecordingEpoch,
    frames: std::collections::HashMap<String, Value>,
}
#[derive(Clone)]
struct ReadSnapshot {
    run: String,
    source: ReadSource,
    items: ReadRows,
    grouped: ReadRows,
}
type ReadRows = Arc<Vec<Arc<Value>>>;

fn share_read_rows(rows: Vec<Value>) -> ReadRows {
    Arc::new(rows.into_iter().map(Arc::new).collect())
}
#[derive(Clone, PartialEq, Eq)]
struct ReadSource {
    path: PathBuf,
    data_version: i64,
    schema_version: i64,
    changes: u64,
}
impl ReadSource {
    fn read(conn: &Connection) -> LabResult<Self> {
        Ok(Self {
            path: conn
                .path()
                .ok_or_else(|| bad("Read source has no database path"))?
                .into(),
            data_version: conn.query_row("PRAGMA data_version", [], |r| r.get(0))?,
            schema_version: conn.query_row("PRAGMA schema_version", [], |r| r.get(0))?,
            changes: conn.total_changes(),
        })
    }
}
struct PreparationActivity<'a>(&'a DatasetContext);
impl Drop for PreparationActivity<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state["preparation_inflight"] = json!(false);
            state["preparation_run_id"] = Value::Null;
            state["preparation_session_id"] = Value::Null;
            state["cancel_preparation"] = json!(false);
        }
    }
}
impl GameplayAi {
    fn preparation_cancelled(&self) -> bool {
        self.context
            .state
            .lock()
            .map(|state| state["cancel_preparation"] == true)
            .unwrap_or(true)
    }
    pub fn export_pixel_evidence(
        profile_raw: &[u8],
        frame_raw: &[u8],
        ids: &[String],
    ) -> LabResult<Vec<PixelEvidence>> {
        Self::export_pixel_evidence_partial(profile_raw, frame_raw, ids)?
            .into_iter()
            .map(|(_, result)| result.map_err(bad))
            .collect()
    }
    pub fn export_pixel_evidence_partial(
        profile_raw: &[u8],
        frame_raw: &[u8],
        ids: &[String],
    ) -> LabResult<Vec<(String, Result<PixelEvidence, String>)>> {
        let profile: Value = serde_json::from_slice(profile_raw)?;
        let image = image::DynamicImage::ImageRgb8(
            crate::media::decode_image(frame_raw)
                .map_err(bad)?
                .to_rgb8(),
        );
        if profile["viewport"]["width"].as_u64() != Some(image.width() as u64)
            || profile["viewport"]["height"].as_u64() != Some(image.height() as u64)
        {
            return Err(bad("Proof viewport differs from the native source profile"));
        }
        let resolved_profile = super::panels::resolve_profile(&image, &profile)?;
        let regions = resolved_profile["regions"]
            .as_array()
            .ok_or_else(|| bad("Missing source regions"))?;
        let mut exported = Vec::new();
        for id in ids {
            let result = (|| -> LabResult<PixelEvidence> {
                let region = regions
                    .iter()
                    .find(|r| r["id"] == *id)
                    .ok_or_else(|| bad("Unknown source region"))?;
                if region["ocr"] == false {
                    return Err(bad("This is a visual indicator, not rendered OCR text"));
                }
                if cache::proven_empty_seat(id, region) {
                    return Err(bad("Seat is proven empty; no OCR crop is admitted"));
                }
                let region = super::panels::resolve(&image, region)?;
                let region = &region;
                let material = PixelMaterial::new(crops::crop_pixels(&image, region)?)?;
                let png = crate::media::png(&material.image).map_err(bad)?;
                let presentation_png = crops::presentation_png(&png, &region["crop_mask"])?;
                Ok(PixelEvidence {
                    region_id: id.clone(),
                    category: crate::labels::category_for_region(id)
                        .ok_or_else(|| bad("Unknown OCR category"))?
                        .into(),
                    pixel_sha256: material.pixels,
                    crop_mask: region["crop_mask"].clone(),
                    presence: region["presence"].clone(),
                    seat_occupancy: region["seat_occupancy"].clone(),
                    card_sampling: region["card_sampling"].clone(),
                    card_plane: region["card_plane"].clone(),
                    bounds: region["bounds"].clone(),
                    guide: crops::recording_guide(
                        region,
                        &material.image,
                        image.width(),
                        image.height(),
                    ),
                    png,
                    presentation_png,
                })
            })();
            exported.push((id.clone(), result.map_err(|error| error.message)));
        }
        Ok(exported)
    }
    pub fn open(root: &Path, config: PathBuf) -> LabResult<Self> {
        super::profile::bootstrap(&config)?;
        let directory = root.join("ocr-evidence");
        crate::storage_paths::ensure_directory(&directory)?;
        let path = root.join("ocr-evidence.sqlite3");
        if path.exists() {
            crate::lab::datasets::plain(&path)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        crate::lab::pixel_assets::install(&conn)?;
        crate::lab::datasets::init_database(&conn)?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_runs(run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,profile_id TEXT NOT NULL,scope TEXT NOT NULL,job_id TEXT,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS gameplay_ai_occurrences(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,session_id TEXT NOT NULL,frame_id TEXT NOT NULL,region_id TEXT NOT NULL,category TEXT NOT NULL,sample_key TEXT NOT NULL,original_label TEXT NOT NULL,original_prediction TEXT NOT NULL,profile_id TEXT NOT NULL,rect TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',cache_kind TEXT NOT NULL DEFAULT 'miss',revision INTEGER NOT NULL DEFAULT 0,UNIQUE(frame_id,profile_id,region_id));
        CREATE INDEX IF NOT EXISTS gameplay_ai_occurrence_scope ON gameplay_ai_occurrences(session_id,run_id);
        CREATE INDEX IF NOT EXISTS gameplay_ai_occurrence_asset ON gameplay_ai_occurrences(sample_key);
        CREATE INDEX IF NOT EXISTS gameplay_ai_profile_asset ON gameplay_ai_occurrences(profile_id,region_id,sample_key);
        CREATE TABLE IF NOT EXISTS gameplay_ai_run_items(run_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,PRIMARY KEY(run_id,occurrence_id));
        CREATE TABLE IF NOT EXISTS gameplay_ai_legacy(occurrence_id TEXT PRIMARY KEY,label TEXT NOT NULL,provenance TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gameplay_ai_manual(sample_key TEXT PRIMARY KEY,label TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,event_id INTEGER);
        CREATE TABLE IF NOT EXISTS gameplay_ai_decisions(id INTEGER PRIMARY KEY,occurrence_id TEXT NOT NULL,sample_key TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL,event_id INTEGER,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS gameplay_ai_decision_occurrence ON gameplay_ai_decisions(occurrence_id,id);")?;
        let columns = conn
            .prepare("PRAGMA table_info(gameplay_ai_occurrences)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns.iter().any(|name| name == "cache_kind") {
            conn.execute_batch("ALTER TABLE gameplay_ai_occurrences ADD COLUMN cache_kind TEXT NOT NULL DEFAULT 'miss'")?;
        }
        let decision_columns = conn
            .prepare("PRAGMA table_info(gameplay_ai_decisions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !decision_columns.iter().any(|name| name == "provenance") {
            conn.execute_batch("ALTER TABLE gameplay_ai_decisions ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}'")?;
        }
        let global = Self {
            context: Arc::new(DatasetContext {
                id: "gameplay-ai".into(),
                directory,
                db: Mutex::new(conn),
                operation: Mutex::new(()),
                state: Mutex::new(json!({"_internal_gameplay":true})),
                _archive_snapshot: None,
            }),
            config,
            projection: Mutex::new(EffectiveSync::default()),
            workflow_transition: Mutex::new(()),
            read_snapshot: Mutex::new(None),
            frame_summaries: Mutex::new(None),
            #[cfg(test)]
            projection_hook: Mutex::new(None),
            #[cfg(test)]
            summary_hook: Mutex::new(None),
            #[cfg(test)]
            summary_full_reference: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            summary_projection_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            summary_cache_hook: Mutex::new(None),
            #[cfg(test)]
            summary_end_hook: Mutex::new(None),
            #[cfg(test)]
            manual_hook: Mutex::new(None),
            #[cfg(test)]
            preparation_hook: Mutex::new(None),
            #[cfg(test)]
            handoff_hook: Mutex::new(None),
        };
        crate::lab::queue::ensure(&global.context)?;
        {
            let conn = global.context.connection()?;
            conn.execute_batch("PRAGMA foreign_keys=ON")?;
            crate::lab::pixel_assets::migrate(&conn)?;
            cache::ensure(&conn)?;
        }
        Ok(global)
    }
    fn profile(&self) -> LabResult<(Value, String)> {
        let path = self.config.join("gameplay-regions.json");
        let raw = fs::read(&path).map_err(|_| {
            bad("Sync the current private mock region profile before preparing Gameplay AI")
        })?;
        let profile: Value = serde_json::from_slice(&raw)?;
        if profile["regions"].as_array().is_none()
            || profile["viewport"]["width"].as_u64().is_none()
            || profile["viewport"]["height"].as_u64().is_none()
        {
            return Err(bad("Invalid current Gameplay region profile"));
        }
        let hash = sha256(&raw);
        Ok((profile, hash))
    }
    pub(crate) fn sync_effective_hands(&self, service: &LabService) -> LabResult<()> {
        #[cfg(test)]
        let perf_start = std::time::Instant::now();
        let mut projection = self
            .projection
            .lock()
            .map_err(|_| conflict("Effective hand projection unavailable"))?;
        let root = service.gameplay.evidence_root()?;
        let path = root.join("gameplay.sqlite3");
        let identity = effective_file_identity(&path)?;
        if identity.is_none()
            || projection.identity != identity
            || projection
                .observer
                .as_ref()
                .and_then(Connection::path)
                .map(Path::new)
                != Some(path.as_path())
        {
            projection.observer = Some(Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?);
            projection.identity = identity;
            projection.completed = None;
        }
        let source = ReadSource::read(&*self.context.connection()?)?;
        let (_, profile_id) = self.profile()?;
        let observer = projection.observer.as_ref().unwrap();
        let version: i64 = observer.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let schema: i64 = observer.query_row("PRAGMA schema_version", [], |r| r.get(0))?;
        if projection
            .completed
            .as_ref()
            .is_some_and(|(saved, profile, v, s)| {
                *saved == source && *profile == profile_id && *v == version && *s == schema
            })
        {
            #[cfg(test)]
            if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
                eprintln!("hand sync reused: {:?}", perf_start.elapsed());
            }
            return Ok(());
        }
        projection.completed = None;
        let (profile, mut entries) = self.effective_hand_readings()?;
        let observer = projection.observer.as_ref().unwrap();
        let mut q = observer.prepare("SELECT id FROM frames")?;
        let frames = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
        drop(q);
        entries.retain(|entry| frames.contains(&entry.0));
        service
            .gameplay
            .evidence_store()?
            .replace_effective_hands(&profile, &entries)
            .map_err(bad)?;
        let observer = projection.observer.as_ref().unwrap();
        let after: i64 = observer.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let after_schema: i64 = observer.query_row("PRAGMA schema_version", [], |r| r.get(0))?;
        let after_source = ReadSource::read(&*self.context.connection()?)?;
        let (_, after_profile) = self.profile()?;
        if identity.is_some()
            && identity == effective_file_identity(&path)?
            && source == after_source
            && profile == profile_id
            && profile == after_profile
            && version == after
            && schema == after_schema
        {
            projection.completed = Some((source, profile, after, after_schema));
        }
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!("hand sync rebuilt: {:?}", perf_start.elapsed());
        }
        Ok(())
    }
    fn recording_epoch(&self, root: &Path) -> LabResult<Option<RecordingEpoch>> {
        let path = root.join("gameplay.sqlite3");
        if !path.is_file() {
            return Ok(None);
        }
        let Some(identity) = effective_file_identity(&path)? else {
            return Ok(None);
        };
        let mut projection = self
            .projection
            .lock()
            .map_err(|_| conflict("Effective hand projection unavailable"))?;
        if projection.identity != Some(identity)
            || projection
                .observer
                .as_ref()
                .and_then(Connection::path)
                .map(Path::new)
                != Some(path.as_path())
        {
            projection.observer = Some(Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?);
            projection.identity = Some(identity);
            projection.completed = None;
        }
        let conn = projection.observer.as_ref().unwrap();
        let data_version = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        let schema_version = conn.query_row("PRAGMA schema_version", [], |r| r.get(0))?;
        Ok(Some(RecordingEpoch {
            path,
            identity,
            data_version,
            schema_version,
        }))
    }
    pub(crate) fn effective_hand_readings(
        &self,
    ) -> LabResult<(String, Vec<(String, Option<String>, String, i64)>)> {
        let (_, profile) = self.profile()?;
        let conn = self.context.connection()?;
        let mut q=conn.prepare("SELECT DISTINCT run_id FROM gameplay_ai_occurrences WHERE profile_id=? AND region_id IN ('game.id','round_id')")?;
        let runs = q
            .query_map([&profile], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut accepted = std::collections::BTreeMap::new();
        for run in runs {
            let values = [rusqlite::types::Value::Text(run)];
            for item in read_items_where(&conn,"o.id IN (SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=?1) AND o.region_id IN ('game.id','round_id')",&values)? {
                if !["unchanged", "corrected", "manual", "legacy_verified"]
                    .contains(&item["state"].as_str().unwrap_or(""))
                {
                    continue;
                }
                let Some(raw) = item["label"].as_str() else {
                    continue;
                };
                if !crate::labels::validate_text("round_id", raw, true) {
                    continue;
                }
                let hand = raw.strip_prefix('#').unwrap_or(raw).trim();
                let frame = item["frame_id"]
                    .as_str()
                    .ok_or_else(|| bad("Frame identity missing"))?
                    .to_owned();
                accepted.insert(
                    frame.clone(),
                    (
                        frame,
                        (!hand.is_empty()).then(|| hand.to_owned()),
                        item["id"].as_str().unwrap_or("").to_owned(),
                        item["revision"].as_i64().unwrap_or(0),
                    ),
                );
            }
        }
        Ok((profile, accepted.into_values().collect()))
    }
    pub(crate) fn enrich_summaries(
        &self,
        frames: &mut [Value],
        recording_root: &Path,
    ) -> LabResult<()> {
        if frames.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        let metadata_start = std::time::Instant::now();
        let (profile, hash) = self.profile()?;
        let baseline = profile["regions"]
            .as_array()
            .ok_or_else(|| bad("Invalid current profile"))?
            .iter()
            .filter(|r| r["ocr"] != false)
            .filter_map(|r| {
                Some((
                    r["id"].as_str()?.to_owned(),
                    if profile["source"].is_string() && r["guide"].is_null() {
                        "unsupported".to_owned()
                    } else {
                        "unprepared".to_owned()
                    },
                ))
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let ids = frames
            .iter()
            .filter_map(|frame| frame["id"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!(
                "summary metadata: {:?} frames={}",
                metadata_start.elapsed(),
                ids.len()
            );
        }
        let mut initial_source = ReadSource::read(&*self.context.connection()?)?;
        let mut recording = self.recording_epoch(recording_root)?;
        #[cfg(test)]
        let use_summary_cache = !self
            .summary_full_reference
            .load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let use_summary_cache = true;
        if use_summary_cache {
            let hits = {
                let cache = self
                    .frame_summaries
                    .lock()
                    .map_err(|_| conflict("Frame summary lock poisoned"))?;
                cache
                    .as_ref()
                    .filter(|entry| {
                        entry.source == initial_source
                            && entry.profile == hash
                            && Some(&entry.recording) == recording.as_ref()
                            && ids.iter().all(|id| entry.frames.contains_key(id))
                    })
                    .map(|entry| entry.frames.clone())
            };
            if let Some(hits) = hits {
                #[cfg(test)]
                if let Some(hook) = self.summary_cache_hook.lock().unwrap().as_ref() {
                    hook();
                }
                let current = ReadSource::read(&*self.context.connection()?)?;
                let current_recording = self.recording_epoch(recording_root)?;
                let (_, current_profile) = self.profile()?;
                if current == initial_source
                    && current_recording == recording
                    && current_profile == hash
                {
                    apply_frame_summaries(frames, &hits, &baseline, &profile, &hash);
                    return Ok(());
                }
                if current_profile != hash {
                    return Err(conflict("Frame profile changed during summary read; retry"));
                }
                initial_source = current;
                recording = current_recording;
            }
        }
        let mut states =
            std::collections::BTreeMap::<String, std::collections::BTreeMap<String, String>>::new();
        #[cfg(test)]
        let legacy_start = std::time::Instant::now();
        let legacy = legacy_connection(recording_root)?;
        let legacy_transaction = legacy
            .as_ref()
            .map(Connection::unchecked_transaction)
            .transpose()?;
        if let Some(legacy) = &legacy_transaction {
            for frame in &ids {
                for (region, label) in super::store::import::labels(legacy, frame).map_err(bad)? {
                    if label["provenance"]["target_profile_sha256"] != hash {
                        continue;
                    }
                    states
                        .entry(frame.clone())
                        .or_insert_with(|| baseline.clone())
                        .insert(region, "legacy_verified".into());
                }
            }
        }
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!("summary legacy labels: {:?}", legacy_start.elapsed());
        }
        #[cfg(test)]
        let projection_start = std::time::Instant::now();
        drop(legacy_transaction);
        drop(legacy);
        // Reuse a verified AI snapshot only when it contains every occurrence
        // needed by this chunk. Partial runs must retain the full-profile read.
        let snapshot = self
            .read_snapshot
            .lock()
            .map_err(|_| conflict("Read snapshot lock poisoned"))?
            .clone();
        let writer = self.context.connection()?;
        let source = ReadSource::read(&writer)?;
        #[cfg(test)]
        if let Some(hook) = self.summary_hook.lock().unwrap().as_ref() {
            hook();
        }
        let transaction = writer.unchecked_transaction()?;
        // Anchor the SQLite read view before trusting rows captured at an epoch.
        transaction.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })?;
        let anchored = ReadSource::read(&transaction)?;
        let conn = &*transaction;
        let cached = snapshot
            .filter(|snapshot| snapshot.source == source && source == anchored)
            .map(|snapshot| {
                snapshot
                    .items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(|id| (id.to_owned(), item.clone())))
                    .collect::<std::collections::HashMap<_, _>>()
            });
        let mut truth_memo = std::collections::HashMap::new();
        #[cfg(test)]
        self.summary_projection_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        for chunk in ids.chunks(256) {
            let mut values = vec![rusqlite::types::Value::Text(hash.clone())];
            values.extend(chunk.iter().cloned().map(rusqlite::types::Value::Text));
            let filter = format!(
                "o.profile_id=?1 AND o.frame_id IN ({})",
                (2..chunk.len() + 2)
                    .map(|n| format!("?{n}"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let reused = if let Some(cached) = &cached {
                let sql = format!("SELECT o.id,o.frame_id,o.region_id FROM gameplay_ai_occurrences o WHERE {filter} ORDER BY o.frame_id,o.region_id");
                let rows = conn
                    .prepare(&sql)?
                    .query_map(rusqlite::params_from_iter(values.iter()), |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut seen = std::collections::BTreeSet::new();
                if rows.iter().all(|(id, frame, region)| {
                    cached.contains_key(id) && seen.insert((frame.clone(), region.clone()))
                }) {
                    Some(
                        rows.into_iter()
                            .map(|(id, _, _)| cached[&id].clone())
                            .collect::<Vec<_>>(),
                    )
                } else {
                    None
                }
            } else {
                None
            };
            let projected = match reused {
                Some(rows) => rows,
                None => {
                    #[cfg(test)]
                    let rows = if self
                        .summary_full_reference
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        read_items_where(&conn, &filter, &values)?
                    } else {
                        read_summary_items_where(&conn, &filter, &values, &mut truth_memo)?
                    };
                    #[cfg(not(test))]
                    let rows = read_summary_items_where(&conn, &filter, &values, &mut truth_memo)?;
                    rows.into_iter().map(Arc::new).collect()
                }
            };
            for item in projected {
                let Some(frame) = item["frame_id"].as_str() else {
                    continue;
                };
                let Some(region) = item["region_id"].as_str() else {
                    continue;
                };
                if card_region(region)
                    && item["state"] == "absent"
                    && !cache::proven_empty_seat(region, &item)
                {
                    continue;
                }
                if states
                    .get(frame)
                    .and_then(|f| f.get(region))
                    .is_some_and(|v| v == "legacy_verified")
                    && item["has_manual_decision"] != true
                {
                    continue;
                }
                let fields = states
                    .entry(frame.into())
                    .or_insert_with(|| baseline.clone());
                let accepted = ["unchanged", "corrected", "manual", "legacy_verified"]
                    .contains(&item["state"].as_str().unwrap_or(""));
                if fields.get(region).map(String::as_str) != Some("unsupported")
                    || accepted
                    || item["state"] == "absent"
                {
                    fields.insert(
                        region.into(),
                        item["state"].as_str().unwrap_or("pending").to_owned(),
                    );
                }
            }
        }
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!(
                "summary input+truth+state aggregation: {:?}",
                projection_start.elapsed()
            );
        }
        #[cfg(test)]
        let aggregation_start = std::time::Instant::now();
        let summaries: std::collections::HashMap<String, Value> = ids
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    verification_summary(
                        &hash,
                        states
                            .get(id)
                            .unwrap_or(&baseline)
                            .values()
                            .map(String::as_str),
                    ),
                )
            })
            .collect();
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!(
                "summary final aggregation: {:?}",
                aggregation_start.elapsed()
            );
        }
        drop(transaction);
        drop(writer);
        #[cfg(test)]
        if let Some(hook) = self.summary_end_hook.lock().unwrap().as_ref() {
            hook();
        }
        let current = ReadSource::read(&*self.context.connection()?)?;
        let current_recording = self.recording_epoch(recording_root)?;
        let (_, current_profile) = self.profile()?;
        if current != anchored || current_recording != recording || current_profile != hash {
            return Err(conflict(
                "Frame evidence changed during summary read; retry",
            ));
        }
        if use_summary_cache && source == initial_source && anchored == source {
            if let Some(recording) = recording {
                let mut cache = self
                    .frame_summaries
                    .lock()
                    .map_err(|_| conflict("Frame summary lock poisoned"))?;
                let entry = cache.get_or_insert_with(|| FrameSummaries {
                    source: source.clone(),
                    profile: hash.clone(),
                    recording: recording.clone(),
                    frames: Default::default(),
                });
                if entry.source != source || entry.profile != hash || entry.recording != recording {
                    *entry = FrameSummaries {
                        source,
                        profile: hash.clone(),
                        recording,
                        frames: Default::default(),
                    };
                }
                let new_frames = summaries
                    .keys()
                    .filter(|id| !entry.frames.contains_key(*id))
                    .count();
                if summaries.len() <= MAX_CACHED_FRAME_SUMMARIES
                    && entry.frames.len() + new_frames > MAX_CACHED_FRAME_SUMMARIES
                {
                    entry.frames.clear();
                }
                for (id, summary) in &summaries {
                    if entry.frames.len() >= MAX_CACHED_FRAME_SUMMARIES
                        && !entry.frames.contains_key(id)
                    {
                        break;
                    }
                    entry.frames.insert(id.clone(), summary.clone());
                }
            }
        }
        apply_frame_summaries(frames, &summaries, &baseline, &profile, &hash);
        Ok(())
    }
    pub(crate) fn enrich_hands(
        &self,
        hands: &mut [Value],
        session: &str,
        root: &Path,
    ) -> LabResult<()> {
        if hands.is_empty() {
            return Ok(());
        }
        #[cfg(test)]
        let metadata_start = std::time::Instant::now();
        let conn = Connection::open_with_flags(
            root.join("gameplay.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let selected = hands
            .iter()
            .map(|h| h["hand_id"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>();
        let mut query = conn
            .prepare("SELECT id,width,height,hand_id FROM effective_frames WHERE session_id=?")?;
        let mut frames=query.query_map([session],|r|Ok(json!({"id":r.get::<_,String>(0)?,"width":r.get::<_,u32>(1)?,"height":r.get::<_,u32>(2)?,"hand_id":r.get::<_,Option<String>>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
        frames.retain(|f| selected.contains(&f["hand_id"].as_str().map(str::to_owned)));
        #[cfg(test)]
        if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
            eprintln!(
                "hands frame metadata: {:?} frames={}",
                metadata_start.elapsed(),
                frames.len()
            );
        }
        self.enrich_summaries(&mut frames, root)?;
        for hand in hands {
            let mut summary = verification_summary(&self.profile()?.1, std::iter::empty());
            for frame in frames
                .iter()
                .filter(|frame| frame["hand_id"] == hand["hand_id"])
            {
                for key in [
                    "total",
                    "verified",
                    "unverified",
                    "needs_review",
                    "unsupported",
                    "absent_count",
                ] {
                    summary[key] = json!(
                        summary[key].as_u64().unwrap_or(0)
                            + frame["verification"][key].as_u64().unwrap_or(0)
                    );
                }
            }
            verification_status(&mut summary);
            hand["verification"] = summary;
        }
        Ok(())
    }
    pub fn enrich_frame(&self, frame: &mut Value) -> LabResult<()> {
        let root = self
            .context
            .directory
            .parent()
            .ok_or_else(|| bad("Missing Gameplay root"))?
            .join("gameplay_recordings");
        self.enrich_frame_at(frame, &root)
    }
    pub(crate) fn enrich_frame_at(
        &self,
        frame: &mut Value,
        recording_root: &Path,
    ) -> LabResult<()> {
        let (mut profile, hash) = match self.profile() {
            Ok(value) => value,
            Err(error) => {
                frame["effective_region_error"] = json!(error.message);
                frame["effective_config_snapshot"] = json!({"region_profile_id":"missing","regions":{"viewport":{"width":frame["width"],"height":frame["height"]},"regions":[]}});
                frame["effective_results"] = json!({});
                frame["verification"] = json!({"region_profile_id":"missing","status":"unavailable","total":0,"verified":0,"unverified":0,"needs_review":0,"unsupported":0});
                return Ok(());
            }
        };
        if frame["width"] != profile["viewport"]["width"]
            || frame["height"] != profile["viewport"]["height"]
        {
            frame["effective_region_error"] =
                json!("Recorded viewport does not match the current region profile");
            frame["effective_config_snapshot"] =
                json!({"region_profile_id":hash,"regions":profile});
            frame["effective_results"] = json!({});
            frame["verification"] = json!({"region_profile_id":hash,"status":"unavailable","total":0,"verified":0,"unverified":0,"needs_review":0,"unsupported":0});
            return Ok(());
        }
        {
            let id = frame["id"]
                .as_str()
                .ok_or_else(|| bad("Missing frame identity"))?;
            if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(bad("Invalid frame identity"));
            }
            let raw = fs::read(recording_root.join("frames").join(format!("{id}.png")))?;
            if frame["image_sha256"]
                .as_str()
                .is_some_and(|hash| sha256(&raw) != hash)
            {
                return Err(conflict("Recorded frame pixels changed"));
            }
            let image = crate::media::decode_image(&raw).map_err(bad)?;
            profile = super::panels::resolve_profile(&image, &profile)?;
            if profile["cv_regions"].is_object() {
                frame["color_state"] = super::colors::derive(
                    Some(&image),
                    &json!({"regions":profile["cv_regions"],"colors":frame["config_snapshot"]["colors"]}),
                );
            }
        }
        let original = frame["results"].clone();
        let mut effective = serde_json::Map::new();
        for region in profile["regions"]
            .as_array()
            .ok_or_else(|| bad("Invalid current region profile"))?
        {
            let Some(id) = region["id"].as_str() else {
                continue;
            };
            let b = &region["bounds"];
            let state = if region["ocr"] == false {
                "visual_indicator"
            } else if cache::source_absent(id, region) {
                "absent"
            } else if !card_region(id) && region["presence"]["state"] == "ambiguous" {
                "ambiguous"
            } else if !region["localization_error"].is_null()
                || (profile["source"].is_string() && region["guide"].is_null())
            {
                "unsupported"
            } else {
                "unprepared"
            };
            effective.insert(id.into(),json!({"prediction":if state=="absent"{Value::Null}else{legacy_prediction(&original,id)},"error":null,"rect":{"x":b["x"],"y":b["y"],"w":b["width"],"h":b["height"]},"original_region_id":prediction_key(&original,id),"verification":{"state":state,"source":if state=="visual_indicator"{"none"}else{"capture"},"reason":if cache::proven_empty_seat(id,region){region["seat_occupancy"]["reason"].as_str().unwrap_or("Source proves seat empty; OCR skipped")}else{region["guideUnsupportedReason"].as_str().unwrap_or("")},"seat_occupancy":region["seat_occupancy"],"skip_reason":if cache::proven_empty_seat(id,region){json!("empty_seat")}else{Value::Null}}}));
        }
        if let Some(legacy) = legacy_connection(recording_root)? {
            for (id, label) in
                super::store::import::labels(&legacy, frame["id"].as_str().unwrap_or(""))
                    .map_err(bad)?
            {
                if label["provenance"]["target_profile_sha256"] != hash {
                    continue;
                }
                if let Some(reading) = effective.get_mut(&id) {
                    reading["prediction"] = legacy_label_prediction(&id, &label);
                    reading["verification"] = json!({"state":"legacy_verified","source":"legacy","legacy_provenance":label["provenance"],"reason":"Imported source annotation"});
                }
            }
        }
        let conn = self.context.connection()?;
        let mut q=conn.prepare("SELECT DISTINCT run_id FROM gameplay_ai_occurrences WHERE frame_id=? AND profile_id=? ORDER BY run_id")?;
        let runs = q
            .query_map(params![frame["id"].as_str(), hash], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for run in runs {
            for item in read_items_filtered(&conn, &run, None, frame["id"].as_str())? {
                let Some(id) = item["region_id"].as_str() else {
                    continue;
                };
                if card_region(id)
                    && item["state"] == "absent"
                    && !cache::proven_empty_seat(id, &item)
                {
                    continue;
                }
                if effective
                    .get(id)
                    .is_some_and(|r| r["verification"]["source"] == "legacy")
                    && item["has_manual_decision"] != true
                {
                    continue;
                }
                if let Some(reading) = effective.get_mut(id) {
                    if item["state"] == "absent" {
                        reading["prediction"] = Value::Null;
                    }
                    let accepted = ["unchanged", "corrected", "manual", "legacy_verified"]
                        .contains(&item["state"].as_str().unwrap_or(""));
                    let state = if item["state"] == "absent" {
                        "absent"
                    } else if reading["verification"]["state"] == "unsupported" && !accepted {
                        "unsupported"
                    } else {
                        item["state"].as_str().unwrap_or("pending")
                    };
                    reading["verification"] = json!({"state":state,"source":if item["state"]=="legacy_verified"{"legacy"}else if item["state"]=="manual"{"human"}else if accepted{"ai"}else{"capture"},"reason":item["reason"],"cache_kind":item["cache_kind"],"legacy_provenance":item["legacy_provenance"],"seat_occupancy":item["seat_occupancy"],"skip_reason":if cache::proven_empty_seat(id,&item){json!("empty_seat")}else{Value::Null}});
                }
                if ["unchanged", "corrected", "manual", "legacy_verified"]
                    .contains(&item["state"].as_str().unwrap_or(""))
                {
                    if let Some(reading) = effective.get_mut(id) {
                        reading["error"] = Value::Null;
                        reading["prediction"] = json!({"text":item["label"],"schema_valid":item["schema_valid"],"outside_contract":item["outside_contract"],"review_state":item["state"],"occurrence_id":item["id"],"visually_verified":false});
                    }
                }
            }
        }
        frame["verification"] = verification_summary(
            &hash,
            effective
                .values()
                .filter_map(|reading| reading["verification"]["state"].as_str()),
        );

        if let Some(regions) = profile["regions"].as_array_mut() {
            regions.retain(|r| {
                r["overlay"] != false
                    && r["ocr"] != false
                    && r["localization_error"].is_null()
                    && !cache::source_absent(r["id"].as_str().unwrap_or(""), r)
            });
        }
        frame["effective_config_snapshot"] = json!({"region_profile_id":hash,"regions":profile});
        frame["effective_results"] = Value::Object(effective);
        Ok(())
    }
    pub fn handle(&self, service: &LabService, request: &LabRequest) -> LabResult<LabResponse> {
        service.ai_review.ensure(&self.context)?;
        let part = request.path.trim_start_matches("/api/gameplay/ai/");
        let value = match (request.method.as_str(), part) {
            ("GET", "profile") => {
                let (profile, id) = self.profile()?;
                json!({"profile":profile,"id":id})
            }
            ("POST", "prepare") => self.prepare_workflow(
                service,
                request.body["session_id"]
                    .as_str()
                    .ok_or_else(|| bad("Select a recording"))?,
                request.body.get("selection"),
                &request.body,
            )?,
            ("POST", "start") => self.start(service, &request.body)?,
            ("GET", "status") => {
                json!({"job":self.status(service,request.query("session_id").ok_or_else(||bad("Select a recording"))?)?})
            }
            ("POST", "stop") | ("POST", "resume") => {
                let id = request.body["job_id"]
                    .as_str()
                    .ok_or_else(|| bad("Job identity required"))?;
                let transition = self
                    .workflow_transition
                    .lock()
                    .map_err(|_| conflict("Workflow transition unavailable"))?;
                let active_session = {
                    let mut state = self
                        .context
                        .state
                        .lock()
                        .map_err(|_| bad("Preparation state unavailable"))?;
                    if part == "stop"
                        && state["preparation_inflight"] == true
                        && state["preparation_run_id"] == id
                    {
                        state["cancel_preparation"] = json!(true);
                        state["preparation_session_id"].as_str().map(str::to_owned)
                    } else {
                        None
                    }
                };
                let mapped: Option<(String, Option<String>, Option<String>)> = self.context.connection()?.query_row(
                    "SELECT session_id,job_id,json_extract(scope,'$.phase') FROM gameplay_ai_runs WHERE run_id=?", [id],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                if let Some((session, None, phase)) = &mapped {
                    if part == "stop"
                        || active_session.as_deref() == Some(session)
                        || matches!(phase.as_deref(), Some("preparing" | "paused"))
                    {
                        if part != "stop" {
                            return Err(conflict(
                                "Use Prepare review to resume interrupted preparation",
                            ));
                        }
                        let mut conn = Connection::open(
                            self.context
                                .directory
                                .parent()
                                .ok_or_else(|| bad("Invalid evidence root"))?
                                .join("ocr-evidence.sqlite3"),
                        )?;
                        conn.busy_timeout(std::time::Duration::ZERO)?;
                        let paused = (|| -> rusqlite::Result<()> {
                            let tx = conn.transaction_with_behavior(
                                rusqlite::TransactionBehavior::Immediate,
                            )?;
                            tx.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','paused') WHERE run_id=?", [id])?;
                            tx.execute("UPDATE queue_meta SET value=json_set(value,'$.paused',json('true'),'$.state','paused') WHERE key='gameplay_workflow' AND json_extract(value,'$.run_id')=?", [id])?;
                            tx.commit()
                        })();
                        match paused {
                            Err(rusqlite::Error::SqliteFailure(error, _))
                                if active_session.as_deref() == Some(session)
                                    && error.code == rusqlite::ErrorCode::DatabaseBusy => {}
                            result => result?,
                        }
                        drop(conn);
                        drop(transition);
                        return Ok(LabResponse::ok(
                            json!({"job":self.status(service,session)?}),
                        ));
                    }
                }
                drop(transition);
                let _operation = self.context.lock_operation()?;
                let mapped: Option<(String, Option<String>)> = self
                    .context
                    .connection()?
                    .query_row(
                        "SELECT session_id,job_id FROM gameplay_ai_runs WHERE run_id=?",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((session, None)) = &mapped {
                    if part == "stop" {
                        self.context.connection()?.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','paused') WHERE run_id=?",[id])?;
                        return Ok(LabResponse::ok(
                            json!({"job":self.status(service,session)?}),
                        ));
                    }
                }
                let resolved = mapped.and_then(|(_, job)| job);
                let id = resolved.as_deref().unwrap_or(id);
                let session: String = self
                    .context
                    .connection()?
                    .query_row(
                        "SELECT session_id FROM gameplay_ai_runs WHERE job_id=?",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(|_| bad("Unknown Gameplay job"))?;
                if part == "stop" {
                    service.ai_review.cancel(&self.context, id)?;
                } else {
                    let _preparation_lease =
                        quarantine::lock_preparation(&*self.context.connection()?)?;
                    if service
                        .gameplay
                        .evidence_store()?
                        .session(&session)
                        .map_err(bad)?["archived"]
                        == true
                    {
                        return Err(conflict("Archived recordings are read-only"));
                    }
                    quarantine::guard(&*self.context.connection()?, id)?;
                    let limit = request
                        .body
                        .get("max_requests")
                        .map(|value| {
                            value
                                .as_u64()
                                .filter(|limit| (1..=10000).contains(limit))
                                .ok_or_else(|| {
                                    bad("Request limit must be an integer from 1 to 10000")
                                })
                        })
                        .transpose()?;
                    service
                        .ai_review
                        .resume_with_limit(&self.context, id, limit)?;
                }
                json!({"job":self.status(service,&session)?})
            }
            ("GET", "items") => self.items(service, request)?,
            ("POST", "repair-plan") => self.repair_plan(&request.body)?,
            ("GET", "plan") => {
                let session = request
                    .query("session_id")
                    .ok_or_else(|| bad("Select a recording"))?;
                let conn = self.context.connection()?;
                let (run, _, scope) = selected_run(&conn, session)?
                    .ok_or_else(|| conflict("Prepare this recording first"))?;
                if !is_active_stream(&conn, &run)? {
                    return Err(conflict(
                        "Prepare this recording again before planning review",
                    ));
                }
                let scope: Value = serde_json::from_str(&scope)?;
                let kind = scope["kind"].as_str().map(str::to_owned);
                drop(conn);
                service.ai_review.evidence_plan(
                    &self.context,
                    request.number("batch_size", 12)?.clamp(1, 24) as i64,
                    kind.as_deref() == Some("pilot"),
                )?
            }
            ("GET", "proof") => {
                let session = request
                    .query("session_id")
                    .ok_or_else(|| bad("Select a recording"))?;
                let region = request
                    .query("region_id")
                    .ok_or_else(|| bad("Select a region"))?;
                let (_, current_profile) = self.profile()?;
                let profile = request
                    .query("profile_id")
                    .filter(|id| !id.is_empty())
                    .unwrap_or(&current_profile);
                let conn = self.context.connection()?;
                let regions = region.split(',').collect::<Vec<_>>();
                if regions.len() > 24 {
                    return Err(bad("Evidence proof supports at most24semanticitems"));
                }
                let keys = if let Some(occurrence) = request.query("occurrence_id") {
                    vec![conn.query_row("SELECT sample_key FROM gameplay_ai_occurrences WHERE id=? AND session_id=? AND profile_id=?",params![occurrence,session,profile],|r|r.get::<_,String>(0)).map_err(|_|bad("Unknown evidence occurrence"))?]
                } else if regions.len() == 1 {
                    let mut q=conn.prepare("SELECT DISTINCT o.sample_key FROM gameplay_ai_occurrences o JOIN queue_items q USING(sample_key) WHERE o.session_id=? AND o.region_id=? AND o.profile_id=? ORDER BY o.frame_id LIMIT 12")?;
                    let keys = q
                        .query_map(params![session, region, profile], |r| r.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    keys
                } else {
                    let mut keys = Vec::new();
                    for id in regions {
                        keys.push(conn.query_row("SELECT o.sample_key FROM gameplay_ai_occurrences o JOIN queue_items q USING(sample_key) WHERE o.session_id=? AND o.region_id=? AND o.profile_id=? ORDER BY o.frame_id LIMIT 1",params![session,id,profile],|r|r.get::<_,String>(0))?);
                    }
                    keys
                };
                drop(conn);
                return Ok(LabResponse::binary(
                    &service.ai_review.preview_grid(&self.context, &keys, true)?,
                    "image/png",
                ));
            }
            ("POST", "review") => self.review(service, &request.body)?,
            ("GET", part) if part.starts_with("crop/") => {
                let id = part.trim_start_matches("crop/");
                let conn = self.context.connection()?;
                let imported:Option<(String,String)>=conn.query_row("SELECT o.frame_id,o.region_id FROM gameplay_ai_occurrences o JOIN gameplay_ai_legacy l ON l.occurrence_id=o.id WHERE o.id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((frame, region)) = imported {
                    let source = legacy_connection(&service.gameplay.evidence_root()?)?
                        .ok_or_else(|| bad("Legacy crop evidence is unavailable"))?;
                    crate::lab::pixel_assets::install(&source)?;
                    let bytes:Vec<u8>=source.query_row("SELECT poker_verified_crop(a.png,a.pixel_sha256,a.width,a.height,a.png_sha256) FROM gameplay_import_labels l JOIN pixel_assets a USING(pixel_sha256) WHERE l.frame_id=? AND l.region_id=?",params![frame,region],|r|r.get(0)).map_err(|_|bad("Unknown or corrupt legacy crop"))?;
                    return Ok(LabResponse::binary(&bytes, "image/png"));
                }
                let (bytes,payload):(Vec<u8>,String)=conn.query_row(&format!("SELECT {},q.payload FROM gameplay_ai_occurrences o JOIN queue_items q ON q.sample_key=o.sample_key WHERE o.id=?",crate::lab::pixel_assets::expression(&conn,"q")?),[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|bad("Unknown or corrupt Gameplay crop"))?;
                let payload: Value =
                    cache::context(&conn, id)?.unwrap_or(serde_json::from_str(&payload)?);
                let bytes = cache::context_crop(&conn, &payload, bytes)?;
                let displayed = crops::presentation_png(&bytes, &payload["crop_mask"])?;
                return Ok(LabResponse::binary(&displayed, "image/png"));
            }
            _ => return Err(bad("Unknown Gameplay AI endpoint")),
        };
        Ok(LabResponse::ok(value))
    }
    #[cfg(test)]
    fn prepare(&self, service: &LabService, session: &str) -> LabResult<Value> {
        self.prepare_scope(service, session, None)
    }
    #[cfg(test)]
    fn prepare_scope(
        &self,
        service: &LabService,
        session: &str,
        selection: Option<&Value>,
    ) -> LabResult<Value> {
        self.prepare_workflow(service, session, selection, &Value::Null)
    }
    fn prepare_workflow(
        &self,
        service: &LabService,
        session: &str,
        selection: Option<&Value>,
        body: &Value,
    ) -> LabResult<Value> {
        let recovery = body
            .get("recover_from_job_id")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| bad("recover_from_job_id must be a job identity"))
            })
            .transpose()?;
        if let Some(job) = recovery {
            let conn = self.context.connection()?;
            if !quarantine::contains(&conn, job)?
                || !conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM gameplay_ai_runs WHERE job_id=? AND session_id=?)",
                    params![job, session],
                    |r| r.get::<_, bool>(0),
                )?
            {
                return Err(conflict(
                    "Recovery requires a quarantined job from this recording",
                ));
            }
        }
        let review = body["review_after_prepare"].as_bool().unwrap_or(false);
        if body
            .get("review_after_prepare")
            .is_some_and(|v| !v.is_boolean())
            || body.get("auto_correct").is_some_and(|v| !v.is_boolean())
        {
            return Err(bad("Workflow flags must be boolean"));
        }
        let budget = body
            .get("max_requests")
            .map(|v| {
                v.as_u64()
                    .filter(|v| (1..=10000).contains(v))
                    .ok_or_else(|| bad("Request budget must be1to10000"))
            })
            .transpose()?
            .unwrap_or(100);
        let store = service.gameplay.evidence_store()?;
        let recording = store.session(session).map_err(bad)?;
        if recording["archived"] == true {
            return Err(conflict("Archived recordings are read-only"));
        }
        let (profile, profile_id) = self.profile()?;
        let root = service.gameplay.evidence_root()?;
        let source = Connection::open_with_flags(
            root.join("gameplay.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut query=source.prepare("SELECT id,width,height,image_sha256,results_json FROM frames WHERE session_id=? ORDER BY captured_at,id")?;
        let mut frames = query
            .query_map([session], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let recording_frame_count = frames.len();
        let selected = if let Some(selection) = selection {
            let pairs = selection
                .as_array()
                .filter(|pairs| !pairs.is_empty() && pairs.len() <= 24)
                .ok_or_else(|| bad("Select1to24exactframe/regionpairs"))?;
            let available_frames = frames
                .iter()
                .map(|frame| frame.0.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            let mut selected = std::collections::BTreeSet::new();
            for pair in pairs {
                if pair.as_object().is_none_or(|pair| {
                    pair.len() != 2
                        || !pair.contains_key("frame_id")
                        || !pair.contains_key("region_id")
                }) {
                    return Err(bad("Pilotselectioncontainsidentitiesonly; labelsandreferencevalues arenotaccepted"));
                }
                let frame = pair["frame_id"]
                    .as_str()
                    .ok_or_else(|| bad("Selectedframeidentitymissing"))?;
                let region = pair["region_id"]
                    .as_str()
                    .ok_or_else(|| bad("Selectedregionidentitymissing"))?;
                if !available_frames.contains(frame)
                    || !profile["regions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["id"] == region && r["ocr"] != false)
                    || !selected.insert((frame.to_owned(), region.to_owned()))
                {
                    return Err(bad(
                        "Selectedpairs mustbeuniquecurrenttextregions inthisrecording",
                    ));
                }
            }
            Some(selected)
        } else {
            None
        };
        if let Some(selected) = &selected {
            frames.retain(|frame| selected.iter().any(|(id, _)| *id == frame.0));
        }
        let selection_sha = sha256(format!("{selected:?}").as_bytes());
        let scope_kind = if selected.is_some() {
            "pilot"
        } else {
            "recording"
        };
        let expected_regions = profile["regions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["ocr"] != false)
            .count();
        if frames.is_empty() || frames.len() > 10000 {
            return Err(bad("Select a recording containing1to10000frames"));
        }
        let normalized_cache = cache::normalized_enabled(&*self.context.connection()?)?;
        let normalization_policy = if normalized_cache {
            cache::money_shape::POLICY
        } else {
            "disabled"
        };
        let source_scope_sha = sha256(
            format!(
                "family_exact_v1:{}:{}:{profile_id}:{selection_sha}:{}:{}:{:?}{}",
                super::presence::POLICY,
                cache::REVIEW_POLICY,
                normalization_policy,
                sha256(crate::labels::CONTRACT_BYTES),
                frames,
                recovery
                    .map(|job| format!(":recover:{job}"))
                    .unwrap_or_default()
            )
            .as_bytes(),
        );

        let persisted_scope: Option<(String, Option<String>)> = self.context.connection()?.query_row(
            "SELECT scope,job_id FROM gameplay_ai_runs WHERE session_id=? AND json_extract(scope,'$.source_scope_sha')=? ORDER BY created_at DESC LIMIT 1",
            params![session,source_scope_sha], |r|Ok((r.get(0)?,r.get(1)?)),
        ).optional()?;
        let has_linked_job = persisted_scope
            .as_ref()
            .is_some_and(|(_, job)| job.is_some());
        let persisted_scope: Value = persisted_scope
            .map(|(raw, _)| serde_json::from_str(&raw))
            .transpose()?
            .unwrap_or(Value::Null);
        if has_linked_job
            && body.get("max_requests").is_none()
            && persisted_scope["workflow_options"]["max_requests"]
                .as_u64()
                .is_none()
        {
            return Err(conflict("Supply an explicit cumulative request budget for this older linked Gameplay review"));
        }
        let budget = if body.get("max_requests").is_none() {
            persisted_scope["workflow_options"]["max_requests"]
                .as_u64()
                .unwrap_or(budget)
        } else {
            budget
        };
        let workflow_options = json!({"review_after_prepare":review,"auto_correct":body["auto_correct"].as_bool().unwrap_or(true),"max_requests":budget});
        let transition = self
            .workflow_transition
            .lock()
            .map_err(|_| conflict("Workflow transition unavailable"))?;
        let adopt = || -> LabResult<Value> {
            let conn = self.context.connection()?;
            let (run, job, scope) = selected_run(&conn, session)?
                .ok_or_else(|| conflict("Gameplay preparation is starting; poll status"))?;
            let scope: Value = serde_json::from_str(&scope)?;
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let intent: Value = raw
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?
                .unwrap_or(Value::Null);
            if scope["source_scope_sha"] != source_scope_sha
                || intent["source_scope_sha"] != source_scope_sha
                || intent["session_id"] != session
                || intent["run_id"] != run
                || intent["review_after_prepare"] != review
                || intent["auto_correct"] != body["auto_correct"].as_bool().unwrap_or(true)
                || intent["recover_from_job_id"] != body["recover_from_job_id"]
                || intent["max_requests"] != budget
            {
                return Err(conflict(
                    "Stop the active Gameplay review before changing workflow scope or options",
                ));
            }
            Ok(json!({"run_id":run,"job_id":job,"scope":scope}))
        };
        let _preparing = match self.context.operation.try_lock() {
            Ok(guard) => guard,
            Err(_) => return adopt(),
        };
        let _preparation_lease = quarantine::lock_preparation(&*self.context.connection()?)?;
        if service.ai_review.is_busy(&self.context)? {
            let prepared = adopt()?;
            if review {
                if let Some(job) = prepared["job_id"].as_str() {
                    let status = service.ai_review.status(&self.context, Some(job), None)?;
                    if matches!(status["state"].as_str(), Some("queued" | "running")) {
                        return Ok(prepared);
                    }
                }
            }
            return Err(conflict(
                "Stop the active Gameplay review before preparing another recording",
            ));
        }
        let linked_auto_correct: Option<bool> = self.context.connection()?.query_row(
            "SELECT j.auto_correct FROM gameplay_ai_runs r JOIN ai_review_jobs j ON j.id=r.job_id WHERE r.session_id=? AND json_extract(r.scope,'$.source_scope_sha')=? ORDER BY r.created_at DESC LIMIT 1",
            params![session,source_scope_sha], |r|r.get(0),
        ).optional()?;
        if review
            && linked_auto_correct
                .is_some_and(|auto| auto != body["auto_correct"].as_bool().unwrap_or(true))
        {
            return Err(conflict(
                "Linked Gameplay review has different correction options",
            ));
        }
        let _launcher_activity = crate::launcher_activity::ActivityLease::acquire(
            crate::launcher_activity::ActivityRole::Preparation,
        )?;
        let generation = uuid();
        let initial_run: Option<String> = None;
        let intent = json!({"generation":generation,"session_id":session,"source_scope_sha":source_scope_sha,"run_id":initial_run,"review_after_prepare":review,"auto_correct":body["auto_correct"].as_bool().unwrap_or(true),"max_requests":budget,"recover_from_job_id":recovery,"paused":false,"state":"preparing"});
        self.context.connection()?.execute("INSERT INTO queue_meta(key,value) VALUES('gameplay_workflow',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [intent.to_string()])?;
        {
            let mut state = self
                .context
                .state
                .lock()
                .map_err(|_| bad("Preparation state unavailable"))?;
            state["cancel_preparation"] = json!(false);
            state["preparation_inflight"] = json!(true);
            state["preparation_session_id"] = json!(session);
            state["preparation_run_id"] = json!(initial_run);
        }
        drop(transition);
        let _activity = PreparationActivity(&self.context);
        let mut conn = Connection::open(
            self.context
                .directory
                .parent()
                .ok_or_else(|| bad("Invalid evidence root"))?
                .join("ocr-evidence.sqlite3"),
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        crate::lab::pixel_assets::install(&conn)?;
        cache::ensure(&conn)?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS gameplay_ai_crop_pixels ON queue_items(pixel_sha256)",
        )?;
        let existing: Option<(String,String,Option<String>)> = conn.query_row("SELECT run_id,scope,job_id FROM gameplay_ai_runs WHERE session_id=? AND json_extract(scope,'$.source_scope_sha')=? ORDER BY created_at DESC LIMIT 1",params![session,source_scope_sha],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let run = existing
            .as_ref()
            .map(|row| row.0.clone())
            .unwrap_or_else(uuid);
        {
            let _transition = self
                .workflow_transition
                .lock()
                .map_err(|_| conflict("Workflow transition unavailable"))?;
            self.context
                .state
                .lock()
                .map_err(|_| bad("Preparation state unavailable"))?["preparation_run_id"] =
                json!(run);
            conn.execute("UPDATE queue_meta SET value=json_set(value,'$.run_id',?) WHERE key='gameplay_workflow' AND json_extract(value,'$.generation')=?", params![run,generation])?;
        }
        let mut resume_scope = Value::Null;
        if let Some((_, scope, job)) = existing {
            let mut scope: Value = serde_json::from_str(&scope)?;
            if scope["phase"] == "prepared" && scope["admission_revision"] == 2 {
                for (frame, _, _, hash, _) in &frames {
                    if sha256(&fs::read(root.join("frames").join(format!("{frame}.png")))?) != *hash
                    {
                        return Err(conflict("Recorded frame pixels changed"));
                    }
                }
                scope["workflow_options"] = workflow_options.clone();
                let tx = conn.transaction()?;
                activate_prepared_scope(&tx, &run)?;
                if recovery.is_some() {
                    activate_recovery(&tx, &run)?;
                }
                tx.execute(
                    "UPDATE gameplay_ai_runs SET scope=? WHERE run_id=?",
                    params![scope.to_string(), run],
                )?;
                tx.commit()?;
                drop(conn);
                return self.finish_preparation(
                    service,
                    session,
                    &run,
                    &generation,
                    json!({"run_id":run,"scope":scope,"job_id":job}),
                );
            }
            resume_scope = scope;
            if resume_scope["admission_revision"] != 2 {
                resume_scope["processed_frames"] = json!(0);
                resume_scope["occurrences"] = json!(0);
                resume_scope["unique_crops"] = json!(0);
                resume_scope["ambiguous"] = json!(0);
                resume_scope["absent_count"] = json!(0);
                resume_scope["exact_cache_hits"] = json!(0);
                resume_scope["near_cache_hits"] = json!(0);
            }
        }
        let resume_count = resume_scope["processed_frames"].as_u64().unwrap_or(0) as usize;
        if resume_count > frames.len() {
            return Err(conflict("Invalid preparation checkpoint"));
        }
        for (frame, _, _, hash, _) in frames.iter().take(resume_count) {
            if sha256(&fs::read(root.join("frames").join(format!("{frame}.png")))?) != *hash {
                return Err(conflict("Recorded frame pixels changed"));
            }
        }
        let mut initial = json!({"session_id":session,"workflow_options":workflow_options,"review_policy":cache::REVIEW_POLICY,"recover_from_job_id":recovery,"kind":scope_kind,"selection_sha256":selection_sha,"recording_frame_count":recording_frame_count,"expected_regions":expected_regions,"frame_count":frames.len(),"occurrences":0,"unique_crops":0,"exact_cache_hits":0,"ambiguous":0,"absent_count":0,"profile_id":profile_id,"validation_sha256":sha256(crate::labels::CONTRACT_BYTES),"cache_policy":cache::POLICY,"presence_policy":super::presence::POLICY,"normalization_policy":normalization_policy,"admission_revision":2,"phase":"preparing","processed_frames":0,"source_scope_sha":source_scope_sha});
        if !resume_scope.is_null() {
            initial = resume_scope;
            initial["phase"] = json!("preparing");
            initial["admission_revision"] = json!(2);
            initial["workflow_options"] = workflow_options.clone();
        }
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO gameplay_ai_runs(run_id,session_id,profile_id,scope,created_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET scope=excluded.scope",params![run,session,profile_id,initial.to_string(),now_ms()])?;
        select_run(&tx, &run)?;
        tx.commit()?;
        let mut tx = conn.transaction()?;
        tx.execute("UPDATE queue_items SET active=0", [])?;
        if resume_count == 0 {
            tx.execute("DELETE FROM gameplay_ai_run_items WHERE run_id=?", [&run])?;
        }
        tx.execute("UPDATE queue_items SET active=1 WHERE sample_key IN (SELECT o.sample_key FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=? AND o.state NOT IN ('ambiguous','absent') AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=o.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id))) AND NOT EXISTS(SELECT 1 FROM gameplay_ai_manual m WHERE m.sample_key=queue_items.sample_key) AND NOT EXISTS(SELECT 1 FROM ai_review_items i WHERE i.sample_key=queue_items.sample_key AND i.state!='pending')",[&run])?;
        cache::restore_component_claims(&tx, &run)?;
        let mut occurrences = initial["occurrences"].as_u64().unwrap_or(0) as usize;
        let mut near_hits = initial["near_cache_hits"].as_u64().unwrap_or(0) as usize;
        let mut hits = initial["exact_cache_hits"].as_u64().unwrap_or(0) as usize;
        let mut unique = {
            let mut q=tx.prepare("SELECT DISTINCT o.sample_key FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=? AND o.state!='absent' AND o.sample_key NOT LIKE 'unsupported:%'")?;
            let keys = q
                .query_map([&run], |r| r.get::<_, String>(0))?
                .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
            keys
        };
        let mut ambiguous = initial["ambiguous"].as_u64().unwrap_or(0) as usize;
        let mut absent_count = initial["absent_count"].as_u64().unwrap_or(0) as usize;
        let started = std::time::Instant::now();
        let mut processed_frames = resume_count;
        let mut encoded_assets = 0usize;
        let mut reused_png_assets = 0usize;
        let regions = profile["regions"].as_array().unwrap();
        let geometry_keys=regions.iter().map(|region|json!({"bounds":region["bounds"],"polygon":region["polygon"],"viewport_padding":region["envelope"]["clippedToViewport"]}).to_string()).collect::<Vec<_>>();
        let mut geometry_counts = std::collections::BTreeMap::new();
        for key in &geometry_keys {
            *geometry_counts.entry(key.clone()).or_insert(0usize) += 1;
        }
        let mut material_crops = 0usize;
        let mut verified_png_decodes = 0usize;
        let mut verified_pngs = std::collections::BTreeMap::<String, String>::new();
        for (frame, width, height, image_hash, results) in frames.iter().skip(resume_count) {
            let legacy_labels = super::store::import::labels(&source, frame).map_err(bad)?;
            let before_frame = (
                occurrences,
                near_hits,
                hits,
                ambiguous,
                absent_count,
                encoded_assets,
                reused_png_assets,
                material_crops,
                verified_png_decodes,
            );
            let previous_unique = unique.clone();
            tx.execute_batch("SAVEPOINT gameplay_preparation_frame")?;
            let mut cancelled = self.preparation_cancelled();
            if !cancelled {
                if profile["viewport"]["width"].as_u64() != Some(*width as u64)
                    || profile["viewport"]["height"].as_u64() != Some(*height as u64)
                {
                    return Err(conflict(
                        "Recording geometry does not match the current verified region profile",
                    ));
                }
                let raw = fs::read(root.join("frames").join(format!("{frame}.png")))?;
                if sha256(&raw) != *image_hash {
                    return Err(conflict("Recorded frame pixels changed"));
                }
                let image = image::DynamicImage::ImageRgb8(
                    crate::media::decode_image(&raw).map_err(bad)?.to_rgb8(),
                );
                let results: Value = serde_json::from_str(results)?;
                let resolved_profile =
                    match super::panels::resolve_profile_cancellable(&image, &profile, &|| {
                        self.preparation_cancelled()
                    }) {
                        Ok(profile) => profile,
                        Err(_) if self.preparation_cancelled() => {
                            cancelled = true;
                            profile.clone()
                        }
                        Err(error) => return Err(error),
                    };
                let regions = resolved_profile["regions"]
                    .as_array()
                    .ok_or_else(|| bad("Invalid resolved profile"))?;
                let mut frame_materials =
                    std::collections::BTreeMap::<String, Arc<PixelMaterial>>::new();
                for (region_index, region) in regions.iter().enumerate() {
                    #[cfg(test)]
                    if let Some(hook) = self.preparation_hook.lock().unwrap().clone() {
                        hook(region_index);
                    }
                    if cancelled || self.preparation_cancelled() {
                        cancelled = true;
                        break;
                    }
                    if region["ocr"] == false {
                        continue;
                    }
                    let id = region["id"]
                        .as_str()
                        .ok_or_else(|| bad("Region identity missing"))?;
                    if selected
                        .as_ref()
                        .is_some_and(|selected| !selected.contains(&(frame.clone(), id.to_owned())))
                    {
                        continue;
                    }
                    let Some(category) = crate::labels::category_for_region(id) else {
                        continue;
                    };
                    let b = &region["bounds"];
                    let occurrence = sha256(format!("{frame}:{profile_id}:{id}").as_bytes());
                    let original = legacy_prediction(&results, id);
                    let label = original["text"].as_str().unwrap_or("");
                    if let Some(imported) = legacy_labels
                        .get(id)
                        .filter(|l| l["provenance"]["target_profile_sha256"] == profile_id)
                    {
                        let key = format!("legacy:{occurrence}");
                        tx.execute("INSERT INTO gameplay_ai_occurrences(id,run_id,session_id,frame_id,region_id,category,sample_key,original_label,original_prediction,profile_id,rect,state,reason,cache_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,'legacy_verified','Imported source annotation','legacy') ON CONFLICT(frame_id,profile_id,region_id) DO UPDATE SET run_id=excluded.run_id",params![occurrence,run,session,frame,id,category,key,imported["label"].as_str().unwrap(),legacy_label_prediction(id,imported).to_string(),profile_id,b.to_string()])?;
                        tx.execute("INSERT OR IGNORE INTO gameplay_ai_legacy(occurrence_id,label,provenance) VALUES(?,?,?)",params![occurrence,imported["label"].as_str().unwrap(),imported["provenance"].to_string()])?;
                        tx.execute("INSERT OR IGNORE INTO gameplay_ai_run_items(run_id,occurrence_id) VALUES(?,?)",params![run,occurrence])?;
                        cache::pin_frame_evidence(
                            &tx,
                            &occurrence,
                            &json!({"frame_id":frame,"image_sha256":image_hash,"width":width,"height":height,"profile_id":profile_id,"region_id":id}),
                        )?;
                        occurrences += 1;
                        continue;
                    }
                    let card = card_region(id);
                    if cache::source_absent(id, region) {
                        let mut absent_presence = region["presence"].clone();
                        if cache::proven_empty_seat(id, region) {
                            absent_presence = json!({"state":"absent","reason":region["seat_occupancy"]["reason"].as_str().unwrap_or("Source proves seat empty; OCR skipped"),"skip_reason":"empty_seat","policy":"source_free_seat_occupancy_v1"});
                        }
                        if cache::record_absence(
                            &tx,
                            &occurrence,
                            &run,
                            session,
                            frame,
                            id,
                            category,
                            &profile_id,
                            b,
                            &original,
                            &absent_presence,
                        )? {
                            ambiguous += 1;
                        } else {
                            absent_count += 1;
                        }
                        tx.execute("UPDATE gameplay_ai_cache_context SET payload=json_set(payload,'$.seat_occupancy',json(?)) WHERE occurrence_id=?",params![region["seat_occupancy"].to_string(),occurrence])?;
                        occurrences += 1;
                        continue;
                    }
                    if card {
                        tx.execute("UPDATE gameplay_ai_occurrences SET state='pending',reason='' WHERE id=? AND state IN ('absent','ambiguous') AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=gameplay_ai_occurrences.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id) AND d.state='ambiguous')",[&occurrence])?;
                    }
                    if card || region["presence"]["state"] == "present" {
                        tx.execute("UPDATE gameplay_ai_occurrences SET state='pending',reason='' WHERE id=? AND (state='absent' OR (state='ambiguous' AND reason LIKE ?))",params![occurrence,format!("{}%",cache::PRESENCE_CONFLICT)])?;
                    }
                    let geometry = &geometry_keys[region_index];
                    let material = if let Some(material) = frame_materials.get(geometry) {
                        material.clone()
                    } else {
                        match crops::crop_pixels(&image, region).and_then(PixelMaterial::new) {
                            Ok(material) => {
                                material_crops += 1;
                                let material = Arc::new(material);
                                if geometry_counts[geometry] > 1 {
                                    frame_materials.insert(geometry.clone(), material.clone());
                                }
                                material
                            }
                            Err(error) => {
                                ambiguous += 1;
                                occurrences += 1;
                                let known_occurrence:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_occurrences WHERE id=?)",[&occurrence],|r|r.get(0))?;
                                tx.execute("INSERT INTO gameplay_ai_occurrences(id,run_id,session_id,frame_id,region_id,category,sample_key,original_label,original_prediction,profile_id,rect,state,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ambiguous',?) ON CONFLICT(frame_id,profile_id,region_id) DO UPDATE SET run_id=excluded.run_id,sample_key=excluded.sample_key",params![occurrence,run,session,frame,id,category,format!("unsupported:{occurrence}"),label,original.to_string(),profile_id,b.to_string(),error.message])?;
                                if !known_occurrence
                                    || cache::context(&tx, &occurrence)?
                                        .is_some_and(|v| v["source_frame"].is_object())
                                {
                                    cache::pin_frame_evidence(
                                        &tx,
                                        &occurrence,
                                        &json!({"frame_id":frame,"image_sha256":image_hash,"width":width,"height":height,"profile_id":profile_id,"region_id":id}),
                                    )?;
                                }
                                tx.execute("INSERT OR IGNORE INTO gameplay_ai_run_items(run_id,occurrence_id) VALUES(?,?)",params![run,occurrence])?;
                                continue;
                            }
                        }
                    };
                    let crop_image = &material.image;
                    let mut guide = crops::recording_guide(region, crop_image, *width, *height);
                    if guide.is_object() {
                        for field in ["guideUnsupportedReason", "localization_error"] {
                            if !region[field].is_null() {
                                guide[field] = region[field].clone();
                            }
                        }
                    }
                    let missing_guide = profile["source"].is_string() && guide.is_null();
                    let system_guide_reason="Source-derived target guide is missing, clipped, or occurrence requires explicit human resolution";
                    if !missing_guide {
                        tx.execute("UPDATE gameplay_ai_occurrences SET state='pending',reason='' WHERE id=? AND state='ambiguous' AND reason=?",params![occurrence,system_guide_reason])?;
                    }
                    let support_payload = json!({"presence":region["presence"]});
                    let blocked=!cache::automatic_support(id, &support_payload) || missing_guide || (!card && region["presence"]["state"]=="ambiguous") || tx.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_occurrences WHERE id=? AND state='ambiguous')",[&occurrence],|r|r.get::<_,bool>(0))?;
                    if blocked {
                        ambiguous += 1;
                    }
                    let pixels = &material.pixels;
                    let evidence_family = cache::evidence_family(id, &guide)
                        .ok_or_else(|| bad("Unsupported evidence family"))?;
                    let family = evidence_family.as_str();
                    let signature = if normalized_cache && family == "money_scalar" && !blocked {
                        cache::money_shape::extract(
                            crop_image.as_rgb8().unwrap(),
                            &region["crop_mask"],
                        )
                    } else {
                        None
                    };
                    let exact = cache::representative(&tx, family, pixels)?;
                    let representative = if let Some(signature) = &signature {
                        cache::normalized_representative(&tx, signature, exact)?
                    } else {
                        exact
                    };
                    let mut key = representative.unwrap_or_else(|| cache::identity(family, pixels));
                    let mut existed: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM queue_items WHERE sample_key=?)",
                        [&key],
                        |r| r.get(0),
                    )?;
                    let mut near_match = existed
                        && tx.query_row(
                            "SELECT pixel_sha256!=? FROM queue_items WHERE sample_key=?",
                            params![pixels, key],
                            |r| r.get::<_, bool>(0),
                        )?;
                    let png = if existed {
                        Arc::new(Vec::new())
                    } else if let Some(bytes) = material.png.get() {
                        reused_png_assets += 1;
                        bytes.clone()
                    } else {
                        let cached:Option<Vec<u8>>=tx.query_row(&format!("SELECT {} FROM queue_items WHERE pixel_sha256=? ORDER BY queue_id DESC LIMIT 1",crate::lab::pixel_assets::expression(&tx,"queue_items")?),[pixels],|r|r.get(0)).optional()?;
                        let reusable = cached.filter(|bytes| {
                            let digest = sha256(bytes);
                            if verified_pngs.get(&digest) == Some(pixels) {
                                return true;
                            }
                            verified_png_decodes += 1;
                            if crate::lab::review::image_identity(bytes)
                                .is_ok_and(|(_, hash)| hash == *pixels)
                            {
                                verified_pngs.insert(digest, pixels.clone());
                                true
                            } else {
                                false
                            }
                        });
                        let bytes = if let Some(bytes) = reusable {
                            reused_png_assets += 1;
                            bytes
                        } else {
                            encoded_assets += 1;
                            let bytes = crate::media::png(crop_image).map_err(bad)?;
                            verified_pngs.insert(sha256(&bytes), pixels.clone());
                            bytes
                        };
                        let bytes = Arc::new(bytes);
                        let _ = material.png.set(bytes.clone());
                        bytes
                    };
                    if !existed && material.uniform_padding {
                        let hash = material
                            .phash
                            .get_or_init(|| crate::media::dhash(crop_image));
                        let mut q=tx.prepare(&format!("SELECT DISTINCT q.sample_key,{},q.phash FROM queue_items q JOIN gameplay_ai_cache_aliases a USING(sample_key) WHERE a.family=? AND q.phash IS NOT NULL ORDER BY q.created_at DESC LIMIT 8",crate::lab::pixel_assets::expression(&tx,"q")?))?;
                        let candidates = q
                            .query_map([family], |r| {
                                Ok((
                                    r.get::<_, String>(0)?,
                                    r.get::<_, Vec<u8>>(1)?,
                                    r.get::<_, String>(2)?,
                                ))
                            })?
                            .collect::<Result<Vec<_>, _>>()?;
                        for (candidate, bytes, old_hash) in candidates {
                            if crate::media::hamming(&hash, &old_hash) <= 2
                                && cache::strict_padding_equivalent(&png, &bytes)
                            {
                                key = candidate;
                                existed = true;
                                near_match = true;
                                break;
                            }
                        }
                    }
                    let adjudicated = !blocked
                        && matches!(cache::truth(&tx, &key)?, cache::Truth::Accepted { .. });
                    let terminal = !blocked && cache::terminal(&tx, &key)?;
                    if existed {
                        if adjudicated && !blocked {
                            if near_match {
                                near_hits += 1;
                            } else {
                                hits += 1;
                            }
                        }
                        tx.execute(
                        "UPDATE queue_items SET active=CASE WHEN ?1 THEN 0 ELSE MAX(active,?2) END,reviewed=CASE WHEN NOT ?1 AND ?2 AND COALESCE((SELECT action FROM label_review_events WHERE sample_key=queue_items.sample_key ORDER BY id DESC LIMIT 1),'')!='quarantined' THEN 1 ELSE reviewed END WHERE sample_key=?3",
                        params![terminal,i64::from(!blocked), key],
                    )?;
                    } else {
                        let phash = material
                            .phash
                            .get_or_init(|| crate::media::dhash(crop_image));
                        tx.execute("INSERT INTO queue_items(sample_key,frame_id,source,region_id,payload,crop,pixel_sha256,phash,created_at,active,reviewed,label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![key,frame,session,id,json!({"id":id,"sample_key":key,"label":label,"guide":guide,"presence":region["presence"],"seat_occupancy":region["seat_occupancy"],"crop_mask":region["crop_mask"]}).to_string(),png.as_slice(),pixels,phash,now_ms(),i64::from(!blocked),i64::from(!blocked),label])?;
                        crate::lab::pixel_assets::attach(
                            &tx,
                            "queue_items",
                            &key,
                            png.as_slice(),
                            pixels,
                        )?;
                    }
                    if !blocked {
                        tx.execute("UPDATE queue_items SET payload=json_set(payload,'$.presence',json(?),'$.seat_occupancy',json(?)) WHERE sample_key=?",params![region["presence"].to_string(),region["seat_occupancy"].to_string(),key])?;
                    }
                    let alias_pixels = if near_match {
                        tx.query_row(
                            "SELECT pixel_sha256 FROM queue_items WHERE sample_key=?",
                            [&key],
                            |r| r.get::<_, String>(0),
                        )?
                    } else {
                        pixels.clone()
                    };
                    cache::register(&tx, &key, family, &alias_pixels)?;
                    if let Some(signature) = &signature {
                        cache::record_normalized(&tx, pixels, &key, signature)?;
                    }
                    if family == "money_list" {
                        cache::admit_components(
                            &tx,
                            &key,
                            &crop_image.to_rgb8(),
                            &region["crop_mask"],
                            label,
                            frame,
                            session,
                            blocked,
                        )?;
                    }
                    let cache_kind = if blocked {
                        "blocked"
                    } else if existed && adjudicated {
                        if near_match {
                            "near"
                        } else {
                            "exact"
                        }
                    } else if near_match {
                        "near_pending"
                    } else {
                        "miss"
                    };
                    unique.insert(key.clone());
                    occurrences += 1;
                    tx.execute("INSERT INTO gameplay_ai_occurrences(id,run_id,session_id,frame_id,region_id,category,sample_key,original_label,original_prediction,profile_id,rect) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(frame_id,profile_id,region_id) DO UPDATE SET run_id=excluded.run_id,sample_key=CASE WHEN NOT EXISTS(SELECT 1 FROM queue_items old_q WHERE old_q.sample_key=gameplay_ai_occurrences.sample_key) THEN excluded.sample_key ELSE gameplay_ai_occurrences.sample_key END",params![occurrence,run,session,frame,id,category,key,label,original.to_string(),profile_id,b.to_string()])?;
                    if cache::save_context(
                        &tx,
                        &occurrence,
                        &guide,
                        &region["crop_mask"],
                        pixels,
                        crop_image,
                    )? {
                        encoded_assets += 1;
                    }
                    tx.execute("UPDATE gameplay_ai_cache_context SET payload=json_set(payload,'$.presence',json(?),'$.seat_occupancy',json(?)) WHERE occurrence_id=?",params![region["presence"].to_string(),region["seat_occupancy"].to_string(),occurrence])?;
                    tx.execute(
                        "UPDATE gameplay_ai_occurrences SET cache_kind=? WHERE id=?",
                        params![cache_kind, occurrence],
                    )?;
                    if blocked {
                        tx.execute(
                        "UPDATE gameplay_ai_occurrences SET state='ambiguous',reason=? WHERE id=?",
                        params![
                            region["guideUnsupportedReason"].as_str().unwrap_or("Source-derived target guide is missing, clipped, or occurrence requires explicit human resolution"),
                            occurrence
                        ],
                    )?;
                    }
                    tx.execute(
                    "INSERT OR IGNORE INTO gameplay_ai_run_items(run_id,occurrence_id) VALUES(?,?)",
                    params![run, occurrence],
                )?;
                }
            }
            cancelled |= self.preparation_cancelled();
            if cancelled {
                tx.execute_batch(
                    "ROLLBACK TO gameplay_preparation_frame; RELEASE gameplay_preparation_frame",
                )?;
                (
                    occurrences,
                    near_hits,
                    hits,
                    ambiguous,
                    absent_count,
                    encoded_assets,
                    reused_png_assets,
                    material_crops,
                    verified_png_decodes,
                ) = before_frame;
                unique = previous_unique;
            } else {
                tx.execute_batch("RELEASE gameplay_preparation_frame")?;
                processed_frames += 1;
            }
            if processed_frames % 25 == 0 || cancelled {
                let progress = json!({"session_id":session,"workflow_options":workflow_options,"review_policy":cache::REVIEW_POLICY,"recover_from_job_id":recovery,"kind":scope_kind,"selection_sha256":selection_sha,"recording_frame_count":recording_frame_count,"expected_regions":expected_regions,"frame_count":frames.len(),"occurrences":occurrences,"unique_crops":unique.len(),"exact_cache_hits":hits,"near_cache_hits":near_hits,"ambiguous":ambiguous,"absent_count":absent_count,"profile_id":profile_id,"validation_sha256":sha256(crate::labels::CONTRACT_BYTES),"cache_policy":cache::POLICY,"presence_policy":super::presence::POLICY,"normalization_policy":normalization_policy,"admission_revision":2,"phase":if cancelled{"paused"}else{"preparing"},"processed_frames":processed_frames,"source_scope_sha":source_scope_sha,"elapsed_ms":started.elapsed().as_millis(),"png_encodes":encoded_assets,"reused_png_assets":reused_png_assets,"material_crops":material_crops,"verified_png_decodes":verified_png_decodes});
                tx.execute(
                    "UPDATE gameplay_ai_runs SET scope=? WHERE run_id=?",
                    params![progress.to_string(), run],
                )?;
                if cancelled {
                    tx.execute("UPDATE queue_meta SET value=json_set(value,'$.paused',json('true'),'$.state','paused') WHERE key='gameplay_workflow' AND json_extract(value,'$.generation')=?", [&generation])?;
                }
                tx.commit()?;
                if cancelled {
                    return Ok(json!({"scope":progress,"run_id":run,"job_id":null}));
                }
                tx = conn.transaction()?;
                eprintln!("Gameplay prepare:{processed_frames}/{}frames,{}occurrences,{}uniqueassets,{}PNGencodes,{:.1}s",frames.len(),occurrences,unique.len(),encoded_assets,started.elapsed().as_secs_f64());
            }
        }
        let scope = json!({"session_id":session,"workflow_options":workflow_options,"review_policy":cache::REVIEW_POLICY,"recover_from_job_id":recovery,"kind":scope_kind,"selection_sha256":selection_sha,"recording_frame_count":recording_frame_count,"expected_regions":expected_regions,"frame_count":frames.len(),"occurrences":occurrences,"unique_crops":unique.len(),"exact_cache_hits":hits,"near_cache_hits":near_hits,"ambiguous":ambiguous,"absent_count":absent_count,"profile_id":profile_id,"validation_sha256":sha256(crate::labels::CONTRACT_BYTES),"cache_policy":cache::POLICY,"presence_policy":super::presence::POLICY,"normalization_policy":normalization_policy,"admission_revision":2,"elapsed_ms":started.elapsed().as_millis(),"png_encodes":encoded_assets,"reused_png_assets":reused_png_assets,"material_crops":material_crops,"verified_png_decodes":verified_png_decodes,"phase":"prepared","processed_frames":processed_frames,"source_scope_sha":source_scope_sha});
        activate_prepared_scope(&tx, &run)?;
        if recovery.is_some() {
            activate_recovery(&tx, &run)?;
        }
        tx.execute(
            "UPDATE gameplay_ai_runs SET scope=? WHERE run_id=?",
            params![scope.to_string(), run],
        )?;
        tx.commit()?;
        drop(conn);
        self.finish_preparation(
            service,
            session,
            &run,
            &generation,
            json!({"scope":scope,"run_id":run,"job_id":null}),
        )
    }
    fn finish_preparation(
        &self,
        service: &LabService,
        session: &str,
        run: &str,
        generation: &str,
        mut prepared: Value,
    ) -> LabResult<Value> {
        #[cfg(test)]
        if let Some(hook) = self.handoff_hook.lock().unwrap().clone() {
            hook();
        }
        let _transition = self
            .workflow_transition
            .lock()
            .map_err(|_| conflict("Workflow transition unavailable"))?;
        let conn = self.context.connection()?;
        let raw: String = conn.query_row(
            "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
            [],
            |r| r.get(0),
        )?;
        let intent: Value = serde_json::from_str(&raw)?;
        let cancelled = self.preparation_cancelled();
        if cancelled && intent["generation"] == generation && intent["run_id"] == run {
            conn.execute("UPDATE queue_meta SET value=json_set(value,'$.paused',json('true'),'$.state','paused') WHERE key='gameplay_workflow' AND json_extract(value,'$.generation')=?", [generation])?;
            conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','paused') WHERE run_id=? AND job_id IS NULL", [run])?;
        }
        let current = selected_run(&conn, session)?;
        let allowed = intent["generation"] == generation
            && intent["session_id"] == session
            && intent["run_id"] == run
            && intent["paused"] != true
            && !cancelled
            && current.as_ref().is_some_and(|row| row.0 == run);
        drop(conn);
        if !allowed {
            if let Some((_, job, scope)) = current {
                prepared["scope"] = serde_json::from_str(&scope)?;
                prepared["job_id"] = json!(job);
            }
            return Ok(prepared);
        }
        if intent["review_after_prepare"] != true {
            return Ok(prepared);
        }
        let mut workflow_state = "reviewing";
        if let Some(job) = current.and_then(|row| row.1) {
            let status = service.ai_review.status(&self.context, Some(&job), None)?;
            if matches!(
                status["state"].as_str(),
                Some("cancelled" | "interrupted" | "failed")
            ) {
                if service
                    .gameplay
                    .evidence_store()?
                    .session(session)
                    .map_err(bad)?["archived"]
                    == true
                {
                    return Err(conflict("Archived recordings are read-only"));
                }
                self.context.connection()?.execute("INSERT INTO queue_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("gameplay_request_budget:{job}"),intent["max_requests"].as_u64().unwrap_or(100).to_string()])?;
                self.context.connection()?.execute("INSERT INTO queue_meta(key,value) VALUES('gameplay_request_budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [intent["max_requests"].as_u64().unwrap_or(100).to_string()])?;
                quarantine::guard(&*self.context.connection()?, &job)?;
                service.ai_review.resume(&self.context, &job)?;
            }
            if status["state"] == "completed" {
                workflow_state = "completed";
            }
            prepared["job_id"] = json!(job);
        } else {
            let mut start = intent.clone();
            start["run_id"] = json!(run);
            self.start_locked(service, &start)?;
            prepared["job_id"] = self
                .context
                .connection()?
                .query_row(
                    "SELECT job_id FROM gameplay_ai_runs WHERE run_id=?",
                    [run],
                    |r| r.get::<_, Option<String>>(0),
                )?
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
        let state = if prepared["job_id"].is_null() {
            "completed"
        } else {
            workflow_state
        };
        self.context.connection()?.execute("UPDATE queue_meta SET value=json_set(value,'$.state',?) WHERE key='gameplay_workflow' AND json_extract(value,'$.generation')=?", params![state,generation])?;
        Ok(prepared)
    }
    fn repair_plan(&self, body: &Value) -> LabResult<Value> {
        let run = body["run_id"]
            .as_str()
            .ok_or_else(|| bad("Prepared run required"))?;
        let ids = body["repair_occurrence_ids"]
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= 2)
            .ok_or_else(|| bad("Repair selects1to2occurrences"))?;
        let conn = self.context.connection()?;
        let (session, profile): (String, String) = conn.query_row(
            "SELECT session_id,profile_id FROM gameplay_ai_runs WHERE run_id=?",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if body["session_id"] != session || self.profile()?.1 != profile {
            return Err(conflict("Repair scope or profile changed"));
        }
        let mut keys = std::collections::BTreeSet::new();
        for id in ids {
            let id = id
                .as_str()
                .ok_or_else(|| bad("Invalid repair occurrence"))?;
            let key:String=conn.query_row("SELECT o.sample_key FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=? AND o.id=? AND EXISTS(SELECT 1 FROM ai_review_items i WHERE i.sample_key=o.sample_key AND i.state!='pending')",params![run,id],|r|r.get(0)).map_err(|_|bad("Repair requires a previously reviewed occurrence in this frozen scope"))?;
            if !keys.insert(key) {
                return Err(bad("Duplicate repair occurrence"));
            }
        }
        Ok(
            json!({"evidence_policy":"gameplay_isolated_blind_v1","diagnostic_only":true,"sample_keys":keys,"semantic_items":keys.len(),"first_pass_batches":keys.len(),"two_pass_calls_upper_without_repairs":keys.len()*2,"max_requests":4,"batch_size":1,"auto_correct":false,"provider_calls":0}),
        )
    }
    fn start(&self, service: &LabService, body: &Value) -> LabResult<Value> {
        let _preparation_lease = quarantine::lock_preparation(&*self.context.connection()?)?;
        let _operation =
            self.context.operation.try_lock().map_err(|_| {
                conflict("Gameplay preparation or review transition is in progress")
            })?;
        self.start_locked(service, body)
    }
    fn start_locked(&self, service: &LabService, body: &Value) -> LabResult<Value> {
        if service.ai_review.is_busy(&self.context)? {
            return Err(conflict(
                "Stop the active Gameplay review before starting another",
            ));
        }
        let run = body["run_id"]
            .as_str()
            .ok_or_else(|| bad("Prepare this recording first"))?;
        let linked: Option<String> = self
            .context
            .connection()?
            .query_row(
                "SELECT job_id FROM gameplay_ai_runs WHERE run_id=?",
                [run],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let Some(job) = linked {
            quarantine::guard(&*self.context.connection()?, &job)?;
        }
        let session: String = self
            .context
            .connection()?
            .query_row(
                "SELECT session_id FROM gameplay_ai_runs WHERE run_id=? AND (job_id IS NULL OR ?)",
                params![run, body.get("repair_occurrence_ids").is_some()],
                |r| r.get(0),
            )
            .map_err(|_| conflict("Prepared Gameplay scope changed"))?;
        let (_, current_profile) = self.profile()?;
        let (prepared_profile, prepared_scope): (String, String) =
            self.context.connection()?.query_row(
                "SELECT profile_id,scope FROM gameplay_ai_runs WHERE run_id=?",
                [run],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
        let prepared_scope: Value = serde_json::from_str(&prepared_scope)?;
        if prepared_profile != current_profile
            || prepared_scope["validation_sha256"] != sha256(crate::labels::CONTRACT_BYTES)
            || prepared_scope["review_policy"] != cache::REVIEW_POLICY
            || prepared_scope["cache_policy"] != cache::POLICY
            || prepared_scope["presence_policy"] != super::presence::POLICY
            || prepared_scope["normalization_policy"]
                != if cache::normalized_enabled(&*self.context.connection()?)? {
                    cache::money_shape::POLICY
                } else {
                    "disabled"
                }
        {
            return Err(conflict(
                "Current region or validation profile changed; prepare this recording again",
            ));
        }
        let phase: Option<String> = self.context.connection()?.query_row(
            "SELECT json_extract(scope,'$.phase') FROM gameplay_ai_runs WHERE run_id=?",
            [run],
            |r| r.get(0),
        )?;
        if phase.as_deref().is_some_and(|phase| phase != "prepared") {
            return Err(conflict("Finish preparation before starting paid review"));
        }
        if body["session_id"] != session {
            return Err(conflict("Prepared recording does not match"));
        }
        let recording = service
            .gameplay
            .evidence_store()?
            .session(&session)
            .map_err(bad)?;
        if recording["archived"] == true {
            return Err(conflict("Archived recordings are read-only"));
        }
        if !is_active_stream(&*self.context.connection()?, run)? {
            return Err(conflict(
                "Prepare this recording again before starting paid review",
            ));
        }
        let budget = body
            .get("max_requests")
            .and_then(Value::as_u64)
            .unwrap_or(100);
        if budget == 0 || budget > 10000 {
            return Err(bad("Request budget must be1to10000"));
        }
        let pending: i64 = self.context.connection()?.query_row(
            "SELECT COUNT(*) FROM queue_items WHERE active=1",
            [],
            |r| r.get(0),
        )?;
        let repair = body
            .get("repair_occurrence_ids")
            .map(|_| self.repair_plan(body))
            .transpose()?;
        if repair.is_some() && budget > 4 {
            return Err(bad("Repair budget cannot exceed4requests"));
        }
        if pending == 0 && repair.is_none() {
            return Ok(json!({"job":self.status(service,&session)?}));
        }
        self.context.connection()?.execute("INSERT INTO queue_meta(key,value) VALUES('gameplay_request_budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[budget.to_string()])?;
        let job=service.ai_review.start(&self.context,&json!({"run_id":run,"max_requests":budget,"batch_size":if repair.is_some(){json!(1)}else{body.get("batch_size").cloned().unwrap_or(json!(12))},"auto_correct":if repair.is_some(){json!(false)}else{body.get("auto_correct").cloned().unwrap_or(json!(true))},"repair_sample_keys":repair.as_ref().map(|r|r["sample_keys"].clone()),"recover_from_job_id":body.get("recover_from_job_id"),"mixed_regions":false}))?;
        self.context.connection()?.execute(
            "UPDATE gameplay_ai_runs SET job_id=?,scope=json_set(scope,'$.workflow_options.max_requests',?) WHERE run_id=?",
            params![job["id"].as_str(), budget as i64, run],
        )?;
        Ok(json!({"job":self.status(service,&session)?}))
    }
    fn read_snapshot(&self, run: &str) -> LabResult<(ReadRows, ReadRows)> {
        let source = ReadSource::read(&*self.context.connection()?)?;
        {
            let cache = self
                .read_snapshot
                .lock()
                .map_err(|_| conflict("Read snapshot lock poisoned"))?;
            if let Some(snapshot) = cache.as_ref() {
                if snapshot.run == run && snapshot.source == source {
                    return Ok((snapshot.items.clone(), snapshot.grouped.clone()));
                }
            }
        }
        let conn =
            Connection::open_with_flags(&source.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        conn.execute_batch("BEGIN")?;
        let result = (|| {
            let items = read_items(&conn, run)?;
            let grouped = cache::group_work(&conn, items.clone())?;
            Ok::<_, crate::lab::LabError>((share_read_rows(items), share_read_rows(grouped)))
        })();
        let end = conn.execute_batch("ROLLBACK");
        let (items, grouped) = result?;
        end?;
        let after: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        #[cfg(test)]
        if let Some(hook) = self.projection_hook.lock().unwrap().as_ref() {
            hook();
        }
        let current = ReadSource::read(&*self.context.connection()?)?;
        if after != version || current != source {
            return Ok((items, grouped));
        }
        let mut cache = self
            .read_snapshot
            .lock()
            .map_err(|_| conflict("Read snapshot lock poisoned"))?;
        *cache = Some(ReadSnapshot {
            run: run.into(),
            source,
            items: items.clone(),
            grouped: grouped.clone(),
        });
        Ok((items, grouped))
    }
    fn status(&self, service: &LabService, session: &str) -> LabResult<Value> {
        let scope = selected_run(&*self.context.connection()?, session)?;
        let Some((run, job, scope)) = scope else {
            return Ok(Value::Null);
        };
        let scope: Value = serde_json::from_str(&scope)?;
        let raw = if let Some(id) = job.as_deref() {
            service.ai_review.status(&self.context, Some(id), None)?
        } else {
            Value::Null
        };
        let (items, grouped_items) = self.read_snapshot(&run)?;
        let absent_count = items
            .iter()
            .filter(|item| item["state"] == "absent")
            .count();
        let mut counts = json!({"total":items.len()-absent_count,"pending":0,"verified":0,"corrected":0,"manual":0,"needs_review":0,"ambiguous":0,"error":0,"frames_completed":0,"frames_total":scope["frame_count"]});
        let mut frames = std::collections::BTreeMap::<String, (bool, usize)>::new();
        let mut revision = 0i64;
        for item in items.iter() {
            let state = item["state"].as_str().unwrap_or("pending");
            if state == "absent" {
                frames
                    .entry(item["frame_id"].as_str().unwrap().into())
                    .and_modify(|value| value.1 += 1)
                    .or_insert((true, 1));
                continue;
            }
            let bucket = match state {
                "unchanged" | "legacy_verified" => "verified",
                "corrected" => "corrected",
                "manual" => "manual",
                "flagged" | "conflict" => "needs_review",
                "ambiguous" => "ambiguous",
                "error" => "error",
                _ => "pending",
            };
            counts[bucket] = json!(counts[bucket].as_u64().unwrap_or(0) + 1);
            let good = ["verified", "corrected", "manual"].contains(&bucket);
            frames
                .entry(item["frame_id"].as_str().unwrap().into())
                .and_modify(|v| {
                    v.0 &= good;
                    v.1 += 1;
                })
                .or_insert((good, 1));
            revision = revision.max(item["revision"].as_i64().unwrap_or(0));
        }
        counts["frames_completed"] = json!(frames
            .values()
            .filter(|v| v.0
                && v.1
                    == scope["expected_regions"]
                        .as_u64()
                        .unwrap_or(usize::MAX as u64) as usize)
            .count());
        let mut group_counts = json!({"total":grouped_items.len(),"pending":0,"verified":0,"corrected":0,"manual":0,"needs_review":0,"ambiguous":0,"error":0,"frames_completed":counts["frames_completed"],"frames_total":counts["frames_total"]});
        for item in grouped_items.iter() {
            let bucket = match item["state"].as_str().unwrap_or("pending") {
                "unchanged" | "legacy_verified" => "verified",
                "corrected" => "corrected",
                "manual" => "manual",
                "flagged" | "conflict" => "needs_review",
                "ambiguous" => "ambiguous",
                "error" => "error",
                _ => "pending",
            };
            group_counts[bucket] = json!(group_counts[bucket].as_u64().unwrap_or(0) + 1);
        }
        let activity = self
            .context
            .state
            .lock()
            .map_err(|_| bad("Preparation state unavailable"))?;
        let inflight =
            activity["preparation_inflight"] == true && activity["preparation_run_id"] == run;
        let pause_requested = inflight && activity["cancel_preparation"] == true;
        drop(activity);
        let state = if scope["quarantined"] == true {
            "quarantined"
        } else if pause_requested {
            "paused"
        } else if scope["phase"] == "preparing" {
            if inflight {
                "preparing"
            } else {
                "paused"
            }
        } else if scope["phase"] == "paused" {
            "paused"
        } else {
            raw["state"].as_str().unwrap_or(if counts["pending"] == 0 {
                "completed"
            } else {
                "prepared"
            })
        };
        let conn = self.context.connection()?;
        let recovery_candidate_job_id: Option<String> = if matches!(state, "paused" | "prepared")
            && !inflight
            && scope["recover_from_job_id"].is_null()
            && conn.query_row(
                "SELECT COUNT(*)=2 FROM sqlite_master WHERE type='table' AND name IN ('gameplay_ai_job_quarantines','ai_review_jobs')",
                [],
                |r| r.get::<_, bool>(0),
            )?
        {
            conn.query_row(
                "SELECT j.id FROM gameplay_ai_job_quarantines q
                 JOIN ai_review_jobs j ON j.id=q.job_id
                 JOIN gameplay_ai_runs r ON r.job_id=j.id AND r.run_id=j.run_id
                 WHERE r.session_id=? AND j.dataset_id='gameplay-ai'
                   AND j.state IN ('cancelled','interrupted','failed','completed')
                   AND NOT EXISTS(SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running'))
                 ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1",
                [session],
                |r| r.get(0),
            ).optional()?
        } else {
            None
        };
        let request_limit: Option<i64> = job
            .as_ref()
            .map(|id| {
                conn.query_row(
                    "SELECT CAST(value AS INTEGER) FROM queue_meta WHERE key=?",
                    [format!("gameplay_request_budget:{id}")],
                    |r| r.get(0),
                )
                .optional()
            })
            .transpose()?
            .flatten();
        Ok(
            json!({"id":job.unwrap_or(run),"quarantined":scope["quarantined"]==true,"state":state,"recovery_candidate_job_id":recovery_candidate_job_id,"preparation":{"processed_frames":scope["processed_frames"].as_u64().unwrap_or(0),"total_frames":scope["frame_count"],"inflight":inflight,"pause_requested":pause_requested},"counts":counts,"group_counts":group_counts,"absent_count":absent_count,"scope":scope,"revision":revision,"auto_correct":raw["auto_correct"].as_bool().or_else(||scope["workflow_options"]["auto_correct"].as_bool()).unwrap_or(true),"max_requests":request_limit.map(|limit| limit as u64).unwrap_or_else(||scope["workflow_options"]["max_requests"].as_u64().unwrap_or(100)),"error":raw["error"].as_str().unwrap_or(""),"usage":{"exact_cache_hits":scope["exact_cache_hits"],"near_cache_hits":scope["near_cache_hits"].as_u64().unwrap_or(0),"requests":raw["usage"]["requests"].as_u64().unwrap_or(0),"input_tokens":raw["usage"]["input_tokens"].as_u64().unwrap_or(0),"output_tokens":raw["usage"]["output_tokens"].as_u64().unwrap_or(0)}}),
        )
    }
    fn items(&self, _service: &LabService, request: &LabRequest) -> LabResult<Value> {
        let session = request
            .query("session_id")
            .ok_or_else(|| bad("Select a recording"))?;
        let conn = self.context.connection()?;
        let run = selected_run(&conn, session)?.map(|(run, _, _)| run);
        let grouped = match request.query("grouped") {
            None | Some("true") => true,
            Some("false") => false,
            _ => return Err(bad("grouped must be true or false")),
        };
        drop(conn);
        let snapshot = if let Some(run) = run {
            Some(self.read_snapshot(&run)?)
        } else {
            None
        };
        let source = snapshot
            .as_ref()
            .map(|(items, groups)| if grouped { groups } else { items });
        let mut items: Vec<&Value> = source
            .into_iter()
            .flat_map(|v| v.iter())
            .map(AsRef::as_ref)
            .filter(|item| item["state"] != "absent")
            .collect();
        if let Some(key) = request.query("work_key") {
            items.retain(|item| item["work_key"] == key);
        }
        let filter = request.query("filter").unwrap_or("all");
        items.retain(|item| match filter {
            "all" => true,
            "completed" => ["unchanged", "corrected", "manual", "legacy_verified"]
                .contains(&item["state"].as_str().unwrap_or("")),
            "manual" => ["flagged", "conflict"].contains(&item["state"].as_str().unwrap_or("")),
            other => item["state"] == other,
        });
        let total = items.len();
        let offset = request.number("cursor", 0)?;
        let limit = request.number("limit", 50)?.clamp(1, 100);
        let page = items
            .into_iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let more = offset + page.len() < total;
        Ok(
            json!({"items":page,"total":total,"hasMore":more,"nextCursor":if more{Some((offset+limit).to_string())}else{None},"meta":{},"grouped":grouped}),
        )
    }
    fn review(&self, service: &LabService, body: &Value) -> LabResult<Value> {
        let id = body["occurrence_id"]
            .as_str()
            .ok_or_else(|| bad("Occurrence identity required"))?;
        let label = body["label"].as_str().unwrap_or("");
        let action = body["action"].as_str().unwrap_or("");
        if !["manual", "ambiguous"].contains(&action) || label.chars().count() > 2000 {
            return Err(bad("Invalid manual review"));
        }
        let cached = self
            .read_snapshot
            .lock()
            .map_err(|_| conflict("Read snapshot lock poisoned"))?
            .clone();
        let mut conn = self.context.connection()?;
        let before = ReadSource::read(&conn)?;
        let cached = cached.filter(|snapshot| snapshot.source == before);
        let tx = conn.transaction()?;
        let (key, revision, category, region_id): (String, i64, String,String) = tx
            .query_row(
                "SELECT sample_key,revision,category,region_id FROM gameplay_ai_occurrences WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?,r.get(3)?)),
            )
            .map_err(|_| bad("Unknown Gameplay occurrence"))?;
        if body["expected_revision"].as_i64() != Some(revision) {
            return Err(conflict("Reading changed; reload before correcting"));
        }
        let normalized = crate::labels::normalize_region_text(&region_id, &category, label);
        let label = normalized.as_str();
        if action == "manual" {
            crate::labels::validate_reviewed_label(&region_id, label, "manual", true)
                .map_err(bad)?;
        }
        let crop: Option<(String, Vec<u8>, String)> = tx
            .query_row(
                &format!(
                    "SELECT region_id,{},pixel_sha256 FROM queue_items WHERE sample_key=?",
                    crate::lab::pixel_assets::expression(&tx, "queue_items")?
                ),
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None);
        let crop = crop.filter(|(_, png, pixels)| {
            crate::lab::review::image_identity(png).is_ok_and(|(_, found)| found == *pixels)
        });
        let occurrence_only = crop.is_none();
        let mut provenance = json!({});
        let event = if action == "manual" {
            if let Some((region, png, pixels)) = crop {
                let input = crate::lab::review::SampleInput {
                    key: key.clone(),
                    region_id: region,
                    png,
                    filename: None,
                };
                let event = crate::lab::review::review_conn(
                    &tx,
                    &self.context,
                    &input,
                    label,
                    "manual",
                    None,
                    true,
                )?;
                tx.execute(
                    "UPDATE queue_items SET label=?,reviewed=1 WHERE sample_key=?",
                    params![label, key],
                )?;
                provenance = json!({"source":"manual_crop","sample_key":key,"pixel_sha256":pixels,"cache_eligible":true});
                event["id"].as_i64()
            } else {
                provenance = manual_frame_evidence(service, &tx, id)?;
                provenance["schema_valid"] =
                    json!(crate::labels::validate_text(&category, label, false));
                None
            }
        } else {
            if occurrence_only {
                provenance = json!({"source":"manual_ambiguity","cache_eligible":false});
            } else {
                tx.execute(
                    "UPDATE queue_items SET reviewed=0 WHERE sample_key=?",
                    [&key],
                )?;
            }
            None
        };
        let decision_key = if occurrence_only {
            format!("manual-frame:{id}")
        } else {
            key.clone()
        };
        tx.execute("INSERT INTO gameplay_ai_decisions(occurrence_id,sample_key,label,state,event_id,created_at,provenance) VALUES(?,?,?,?,?,?,?)",params![id,decision_key,label,action,event,now_ms(),provenance.to_string()])?;
        let affected = if occurrence_only {
            tx.execute("UPDATE queue_items SET active=0 WHERE sample_key=? AND NOT EXISTS(SELECT 1 FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=json_extract((SELECT value FROM queue_meta WHERE key='active_stream'),'$') AND o.sample_key=queue_items.sample_key AND o.state NOT IN ('ambiguous','absent') AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=o.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id)))",[&key])?;
            tx.execute(
                "UPDATE gameplay_ai_occurrences SET revision=revision+1 WHERE id=?",
                [id],
            )?
        } else {
            let conflicting: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.sample_key=? AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id) AND (d.state!=? OR d.label!=?))",params![key,action,label],|r|r.get(0))?;
            let group_state = if conflicting { "conflict" } else { action };
            tx.execute("INSERT INTO gameplay_ai_manual(sample_key,label,state,revision,event_id) VALUES(?,?,?,1,?) ON CONFLICT(sample_key) DO UPDATE SET label=excluded.label,state=excluded.state,revision=revision+1,event_id=excluded.event_id",params![key,label,group_state,event])?;
            tx.execute("UPDATE queue_items SET active=0 WHERE sample_key=?", [&key])?;
            if conflicting {
                tx.execute(
                    "UPDATE queue_items SET reviewed=0,active=0 WHERE sample_key=?",
                    [&key],
                )?;
            }
            if cache::enabled(&tx)? {
                cache::propagate_revisions(&tx, &key, id, label, action)?
            } else {
                tx.execute("UPDATE gameplay_ai_occurrences SET revision=revision+1 WHERE sample_key=? AND (id=? OR (state!='ambiguous' AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=gameplay_ai_occurrences.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id) AND (d.label!=? OR d.state!=?))))",params![key,id,label,action])?
            }
        };
        // Derive the replacement inside the same transaction as the decision, before
        // another connection can commit a change to the evidence graph.
        let replacement = cached
            .as_ref()
            .and_then(|snapshot| refresh_manual_snapshot(&tx, snapshot, id, &key).ok());
        tx.commit()?;
        #[cfg(test)]
        if let Some(hook) = self.manual_hook.lock().unwrap().as_ref() {
            hook();
        }
        let after = ReadSource::read(&conn)?;
        let replacement = replacement.filter(|_| {
            before.data_version == after.data_version
                && before.schema_version == after.schema_version
                && before.path == after.path
        });
        let item = read_items_where(
            &conn,
            "o.id=?1",
            &[rusqlite::types::Value::Text(id.to_owned())],
        )?
        .into_iter()
        .find(|v| v["id"] == id)
        .ok_or_else(|| bad("Reading missing"))?;
        drop(conn);
        if let (Some(old), Some(mut updated)) = (cached, replacement) {
            updated.source = after;
            let mut cache = self
                .read_snapshot
                .lock()
                .map_err(|_| conflict("Read snapshot lock poisoned"))?;
            if cache.as_ref().is_some_and(|current| {
                current.run == old.run
                    && current.source == old.source
                    && Arc::ptr_eq(&current.items, &old.items)
            }) {
                *cache = Some(updated);
            }
        }
        Ok(json!({"revision":item["revision"],"item":item,"affected_count":affected}))
    }
}
#[cfg(test)]
#[path = "evidence_cache_tests.rs"]
mod evidence_cache_tests;
#[cfg(test)]
#[path = "ai_tests.rs"]
mod tests;
fn card_region(region: &str) -> bool {
    matches!(
        crate::labels::category_for_region(region),
        Some("card" | "suit")
    )
}

fn manual_frame_evidence(service: &LabService, conn: &Connection, id: &str) -> LabResult<Value> {
    use image::GenericImageView;
    let (frame,session,profile,region,original,rect):(String,String,String,String,String,String)=conn.query_row("SELECT frame_id,session_id,profile_id,region_id,original_prediction,rect FROM gameplay_ai_occurrences WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let root = service.gameplay.evidence_root()?;
    let source = Connection::open_with_flags(
        root.join("gameplay.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| bad("Original frame evidence is unavailable; keep this occurrence unresolved"))?;
    let context = cache::context(conn, id)?.unwrap_or_else(|| json!({}));
    let anchor = if context["source_frame"].is_object() {
        context["source_frame"].clone()
    } else {
        let (run,raw):(String,String)=conn.query_row("SELECT r.run_id,r.scope FROM gameplay_ai_runs r JOIN gameplay_ai_run_items i ON i.run_id=r.run_id WHERE i.occurrence_id=? ORDER BY r.created_at,r.rowid LIMIT 1",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let scope: Value = serde_json::from_str(&raw)?;
        if scope["cache_policy"] != cache::POLICY {
            return Err(bad(
                "Original frame evidence is not anchored to a supported frozen scope",
            ));
        }
        let mut frames=source.prepare("SELECT id,width,height,image_sha256,results_json FROM frames WHERE session_id=? ORDER BY captured_at,id")?.query_map([&session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,u32>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let count = scope["frame_count"]
            .as_u64()
            .ok_or_else(|| bad("Frozen frame count is missing"))? as usize;
        if scope["kind"] == "pilot" {
            let selected=conn.prepare("SELECT DISTINCT o.frame_id FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items i ON i.occurrence_id=o.id WHERE i.run_id=?")?.query_map([&run],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<std::collections::BTreeSet<_>>>()?;
            frames.retain(|f| selected.contains(&f.0));
        } else {
            frames.truncate(count);
        }
        if frames.len() != count {
            return Err(bad("Original frozen frame evidence is incomplete"));
        }
        let selection = scope["selection_sha256"]
            .as_str()
            .ok_or_else(|| bad("Frozen selection is missing"))?;
        let validation = scope["validation_sha256"]
            .as_str()
            .ok_or_else(|| bad("Frozen validation context is missing"))?;
        let mut parts = vec![cache::POLICY];
        if let Some(policy) = scope["presence_policy"].as_str() {
            parts.push(policy);
        }
        if let Some(policy) = scope["review_policy"].as_str() {
            parts.push(policy);
        }
        parts.extend([profile.as_str(), selection]);
        if let Some(policy) = scope["normalization_policy"].as_str() {
            parts.push(policy);
        }
        parts.push(validation);
        let recovery_suffix = scope["recover_from_job_id"]
            .as_str()
            .map(|job| format!(":recover:{job}"))
            .unwrap_or_default();
        if sha256(format!("{}:{frames:?}{recovery_suffix}", parts.join(":")).as_bytes())
            != scope["source_scope_sha"]
        {
            return Err(conflict(
                "Original frozen frame evidence changed; keep this occurrence unresolved",
            ));
        }
        let found = frames
            .iter()
            .find(|f| f.0 == frame)
            .ok_or_else(|| bad("Original frame is absent from its frozen scope"))?;
        json!({"frame_id":frame,"image_sha256":found.3,"width":found.1,"height":found.2,"profile_id":profile,"region_id":region})
    };
    if anchor["frame_id"] != frame
        || anchor["profile_id"] != profile
        || anchor["region_id"] != region
    {
        return Err(conflict("Original frame context changed"));
    }
    let stored: (u32, u32, String) = source
        .query_row(
            "SELECT width,height,image_sha256 FROM frames WHERE id=? AND session_id=?",
            params![frame, session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| {
            bad("Original frame evidence is unavailable; keep this occurrence unresolved")
        })?;
    if anchor["width"] != stored.0
        || anchor["height"] != stored.1
        || anchor["image_sha256"] != stored.2
    {
        return Err(conflict("Original frame hash or dimensions changed"));
    }
    let bytes = fs::read(root.join("frames").join(format!("{frame}.png")))
        .map_err(|_| bad("Original frame image is unavailable; keep this occurrence unresolved"))?;
    if sha256(&bytes) != stored.2 {
        return Err(conflict("Original frame image changed"));
    }
    let image =
        crate::media::decode_image(&bytes).map_err(|_| bad("Original frame image is corrupt"))?;
    if image.dimensions() != (stored.0, stored.1) {
        return Err(conflict("Original frame dimensions changed"));
    }
    cache::pin_frame_evidence(conn, id, &anchor)?;
    let schema = crate::lab::review::validation_contract();
    Ok(
        json!({"source":"manual_frame","frame":anchor,"region_bounds":serde_json::from_str::<Value>(&rect)?,"original_prediction_sha256":sha256(original.as_bytes()),"cache_eligible":false,"validation_contract":schema}),
    )
}

fn activate_recovery(conn: &Connection, run: &str) -> LabResult<()> {
    let items = read_items(conn, run)?;
    for item in items {
        if item["has_manual_decision"] == true
            || !cache::automatic_support(item["region_id"].as_str().unwrap_or(""), &item)
        {
            continue;
        }
        let key = item["sample_key"].as_str().unwrap();
        let manual: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM gameplay_ai_manual WHERE sample_key=?)",
            [key],
            |r| r.get(0),
        )?;
        if !manual
            && matches!(
                cache::truth(conn, key)?,
                cache::Truth::NeedsReview { .. } | cache::Truth::Pending
            )
        {
            conn.execute(
                "UPDATE queue_items SET active=1 WHERE sample_key=? AND discarded=0",
                [key],
            )?;
        }
    }
    Ok(())
}

fn activate_prepared_scope(conn: &Connection, run: &str) -> LabResult<()> {
    select_run(conn, run)?;
    conn.execute("UPDATE queue_items SET active=0", [])?;
    conn.execute("UPDATE queue_items SET active=1 WHERE sample_key IN (SELECT o.sample_key FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=? AND o.state NOT IN ('ambiguous','absent') AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=o.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id)))",[run])?;
    cache::restore_component_claims(conn, run)?;
    cache::coalesce_pending(conn)?;
    let ceiling:i64=conn.query_row("SELECT COALESCE(MAX(q.queue_id),0) FROM queue_items q WHERE q.active=1 OR q.sample_key IN (SELECT o.sample_key FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=?)",[run],|r|r.get(0))?;
    let old: Option<String> = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key=?",
            [format!("stream:{run}")],
            |r| r.get(0),
        )
        .optional()?;
    let mut stream = old
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let ceiling = ceiling.max(stream["ceiling"].as_i64().unwrap_or(0));
    stream["dataset_id"] = json!("gameplay-ai");
    stream["state"] = json!("active");
    stream["ceiling"] = json!(ceiling);
    conn.execute("INSERT INTO queue_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("stream:{run}"),stream.to_string()])?;
    conn.execute("INSERT INTO queue_meta(key,value) VALUES('active_stream',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json!(run).to_string()])?;
    Ok(())
}

fn is_active_stream(conn: &Connection, run: &str) -> LabResult<bool> {
    let active: Option<String> = conn
        .query_row(
            "SELECT json_extract(value,'$') FROM queue_meta WHERE key='active_stream'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(active.as_deref() == Some(run))
}

fn select_run(conn: &Connection, run: &str) -> LabResult<()> {
    conn.execute("INSERT INTO queue_meta(key,value) SELECT 'gameplay_selected:' || session_id, json_quote(run_id) FROM gameplay_ai_runs WHERE run_id=? ON CONFLICT(key) DO UPDATE SET value=excluded.value", [run])?;
    Ok(())
}

fn selected_run(
    conn: &Connection,
    session: &str,
) -> LabResult<Option<(String, Option<String>, String)>> {
    Ok(conn.query_row("SELECT run_id,job_id,scope FROM gameplay_ai_runs WHERE session_id=? ORDER BY (run_id=COALESCE((SELECT json_extract(value,'$') FROM queue_meta WHERE key='gameplay_selected:' || ?),'')) DESC, created_at DESC, rowid DESC LIMIT 1", params![session, session], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?)
}

fn refresh_manual_snapshot(
    conn: &Connection,
    old: &ReadSnapshot,
    id: &str,
    sample: &str,
) -> LabResult<ReadSnapshot> {
    use std::collections::{BTreeSet, HashMap};
    let groups: Vec<String> = if cache::enabled(conn)? {
        conn.prepare("WITH RECURSIVE edges(a,b) AS (SELECT p.cache_key,c.cache_key FROM gameplay_ai_cache_components x JOIN gameplay_ai_cache_aliases p ON p.sample_key=x.parent_key JOIN gameplay_ai_cache_aliases c ON c.sample_key=x.component_key UNION SELECT c.cache_key,p.cache_key FROM gameplay_ai_cache_components x JOIN gameplay_ai_cache_aliases p ON p.sample_key=x.parent_key JOIN gameplay_ai_cache_aliases c ON c.sample_key=x.component_key), related(g) AS (SELECT cache_key FROM gameplay_ai_cache_aliases WHERE sample_key=? UNION SELECT edges.b FROM edges JOIN related ON edges.a=related.g) SELECT g FROM related")?.query_map([sample], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    } else {
        Vec::new()
    };
    let mut values = vec![
        rusqlite::types::Value::Text(old.run.clone()),
        rusqlite::types::Value::Text(id.into()),
        rusqlite::types::Value::Text(sample.into()),
    ];
    values.extend(groups.iter().cloned().map(rusqlite::types::Value::Text));
    let aliases = if groups.is_empty() {
        String::new()
    } else {
        format!(" OR o.sample_key IN (SELECT sample_key FROM gameplay_ai_cache_aliases WHERE cache_key IN ({}))", (0..groups.len()).map(|_| "?").collect::<Vec<_>>().join(","))
    };
    let filter = format!("o.id IN (SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=?1) AND (o.id=?2 OR o.sample_key=?3{aliases})");
    let updated = read_items_where(conn, &filter, &values)?;
    let updates: HashMap<_, _> = updated
        .iter()
        .map(|item| {
            (
                item["id"].as_str().unwrap().to_owned(),
                Arc::new(item.clone()),
            )
        })
        .collect();
    let mut affected: BTreeSet<String> = old
        .items
        .iter()
        .filter(|item| updates.contains_key(item["id"].as_str().unwrap_or("")))
        .filter_map(|item| item["work_key"].as_str().map(str::to_owned))
        .collect();
    affected.extend(
        updated
            .iter()
            .filter_map(|item| item["work_key"].as_str().map(str::to_owned)),
    );
    let mut items = (*old.items).clone();
    for item in &mut items {
        if let Some(value) = updates.get(item["id"].as_str().unwrap_or("")) {
            *item = value.clone();
        }
    }
    let affected_items = items
        .iter()
        .filter(|item| {
            item["work_key"]
                .as_str()
                .is_some_and(|key| affected.contains(key))
        })
        .map(|item| item.as_ref().clone())
        .collect();
    let mut grouped: Vec<Arc<Value>> = old
        .grouped
        .iter()
        .filter(|item| {
            !item["work_key"]
                .as_str()
                .is_some_and(|key| affected.contains(key))
        })
        .cloned()
        .collect();
    grouped.extend(
        cache::group_work(conn, affected_items)?
            .into_iter()
            .map(Arc::new),
    );
    grouped.sort_by(|a, b| {
        a["frame_id"]
            .as_str()
            .cmp(&b["frame_id"].as_str())
            .then(a["region_id"].as_str().cmp(&b["region_id"].as_str()))
            .then(a["work_key"].as_str().cmp(&b["work_key"].as_str()))
    });
    Ok(ReadSnapshot {
        run: old.run.clone(),
        source: old.source.clone(),
        items: Arc::new(items),
        grouped: Arc::new(grouped),
    })
}

fn read_items(conn: &Connection, run: &str) -> LabResult<Vec<Value>> {
    read_items_for_region(conn, run, None)
}
fn read_items_for_region(
    conn: &Connection,
    run: &str,
    region: Option<&str>,
) -> LabResult<Vec<Value>> {
    read_items_filtered(conn, run, region, None)
}
fn read_items_filtered(
    conn: &Connection,
    run: &str,
    region: Option<&str>,
    frame: Option<&str>,
) -> LabResult<Vec<Value>> {
    let values = vec![
        rusqlite::types::Value::Text(run.into()),
        region
            .map(|v| rusqlite::types::Value::Text(v.into()))
            .unwrap_or(rusqlite::types::Value::Null),
        frame
            .map(|v| rusqlite::types::Value::Text(v.into()))
            .unwrap_or(rusqlite::types::Value::Null),
    ];
    read_items_where(conn,"o.id IN (SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=?1) AND (?2 IS NULL OR o.region_id=?2) AND (?3 IS NULL OR o.frame_id=?3)",&values)
}
fn read_items_where(
    conn: &Connection,
    filter: &str,
    values: &[rusqlite::types::Value],
) -> LabResult<Vec<Value>> {
    #[cfg(test)]
    let stage = std::time::Instant::now();
    let sql=format!("SELECT o.id,o.frame_id,o.region_id,o.category,o.original_label,o.revision,o.sample_key,
        CASE WHEN d.id IS NOT NULL THEN d.label WHEN o.state='ambiguous' THEN o.original_label ELSE COALESCE(m.label,q.label,o.original_label) END,
        CASE WHEN o.state='absent' THEN 'absent' WHEN o.state='ambiguous' AND o.reason LIKE 'Presence contradicts occurrence-owned human evidence%' THEN 'ambiguous' WHEN d.id IS NOT NULL THEN d.state WHEN o.state='ambiguous' THEN 'ambiguous' ELSE COALESCE(m.state,(SELECT i.state FROM ai_review_items i WHERE i.sample_key=o.sample_key AND i.state!='pending' ORDER BY rowid DESC LIMIT 1),o.state) END,
        CASE WHEN o.state='ambiguous' THEN json_object('reason',o.reason) WHEN m.state='conflict' AND d.id IS NULL THEN json_object('reason','Conflicting manual readings') ELSE COALESCE((SELECT i.result FROM ai_review_items i WHERE i.sample_key=o.sample_key ORDER BY rowid DESC LIMIT 1),json_object('reason',o.reason)) END
        ,q.payload,o.cache_kind,d.id IS NOT NULL,o.state,q.sample_key IS NOT NULL,COALESCE(d.provenance,'{{}}') FROM gameplay_ai_occurrences o LEFT JOIN queue_items q USING(sample_key) LEFT JOIN gameplay_ai_manual m USING(sample_key) LEFT JOIN gameplay_ai_decisions d ON d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id) WHERE {filter} ORDER BY o.frame_id,o.region_id");
    let mut q = conn.prepare(&sql)?;
    let mut rows=q.query_map(rusqlite::params_from_iter(values.iter()),|r|{let id:String=r.get(0)?;let frame:String=r.get(1)?;Ok(json!({"id":id,"frame_id":frame,"region_id":r.get::<_,String>(2)?,"category":r.get::<_,String>(3)?,"original_label":r.get::<_,String>(4)?,"revision":r.get::<_,i64>(5)?,"sample_key":r.get::<_,String>(6)?,"label":r.get::<_,String>(7)?,"state":r.get::<_,String>(8)?,"reason":serde_json::from_str::<Value>(&r.get::<_,String>(9)?).unwrap_or(Value::Null)["reason"].as_str().unwrap_or(""),"crop_url":if r.get::<_,bool>(14)? {json!(format!("/api/gameplay/ai/crop/{id}"))}else{Value::Null},"crop_available":r.get::<_,bool>(14)?,"review_evidence":serde_json::from_str::<Value>(&r.get::<_,String>(15)?).unwrap_or(Value::Null),"image_url":format!("/api/gameplay/frames/{frame}/image"),"guide":serde_json::from_str::<Value>(&r.get::<_,Option<String>>(10)?.unwrap_or_else(||"{}".into())).unwrap_or(Value::Null)["guide"],"cache_kind":r.get::<_,String>(11)?,"has_manual_decision":r.get::<_,bool>(12)?,"_own_decision":r.get::<_,bool>(12)?,"_occurrence_state":r.get::<_,String>(13)?}))})?.collect::<Result<Vec<_>,_>>()?;
    #[cfg(test)]
    if std::env::var_os("POKER_PERF_DB").is_some() {
        eprintln!("sql rows: {:?}", stage.elapsed());
    }
    #[cfg(test)]
    let stage = std::time::Instant::now();
    for item in &mut rows {
        let legacy: Option<(String, String)> = conn
            .prepare_cached(
                "SELECT label,provenance FROM gameplay_ai_legacy WHERE occurrence_id=?",
            )?
            .query_row([item["id"].as_str().unwrap()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        if let Some((label, provenance)) = legacy {
            item["legacy_provenance"] = serde_json::from_str(&provenance)?;
            if item["has_manual_decision"] != true {
                item["state"] = json!("legacy_verified");
                item["label"] = json!(label);
                item["_own_decision"] = json!(true);
                item["review_evidence"] = json!({"source":"legacy","cache_eligible":false});
                item["schema_valid"] = json!(crate::labels::validate_text(
                    item["category"].as_str().unwrap_or(""),
                    item["label"].as_str().unwrap_or(""),
                    false
                ));
                item["outside_contract"] = json!(item["schema_valid"] != true);
            }
        }
    }
    #[cfg(test)]
    if std::env::var_os("POKER_PERF_DB").is_some() {
        eprintln!("legacy: {:?}", stage.elapsed());
    }
    #[cfg(test)]
    let stage = std::time::Instant::now();
    cache::project(conn, &mut rows)?;
    #[cfg(test)]
    if std::env::var_os("POKER_PERF_DB").is_some() {
        eprintln!("project: {:?}", stage.elapsed());
    }
    for item in &mut rows {
        finish_projected_item(item);
    }
    Ok(rows)
}
fn finish_projected_item(item: &mut Value) {
    if item["legacy_provenance"].is_object() {
        item["crop_available"] = json!(true);
        item["crop_url"] = json!(format!(
            "/api/gameplay/ai/crop/{}",
            item["id"].as_str().unwrap()
        ));
        item["crop_scope"] = json!("legacy_source");
        item["guide"] = Value::Null;
    }
    item["source"] = json!(match item["state"].as_str().unwrap_or("") {
        "legacy_verified" => "legacy",
        "manual" => "human",
        "unchanged" | "corrected" => "ai",
        _ => "capture",
    });
    if item["state"] == "legacy_verified" {
        return;
    }
    if ["unchanged", "corrected", "manual", "legacy_verified"]
        .contains(&item["state"].as_str().unwrap_or(""))
    {
        let label = crate::labels::normalize_region_text(
            item["region_id"].as_str().unwrap_or(""),
            item["category"].as_str().unwrap_or(""),
            item["label"].as_str().unwrap_or(""),
        );
        let valid = crate::labels::validate_reviewed_label(
            item["region_id"].as_str().unwrap_or(""),
            &label,
            if item["state"] == "manual" {
                "manual"
            } else {
                "accepted"
            },
            item["state"] == "manual",
        );
        if let Ok(schema_valid) = valid {
            item["label"] = json!(label);
            item["schema_valid"] = json!(schema_valid);
            item["outside_contract"] = json!(!schema_valid);
        } else {
            item["state"] = json!("conflict");
            item["reason"]=json!("Stored reading is outside the current validation contract; human evidence is preserved");
        }
    }
}

fn read_summary_items_where(
    conn: &Connection,
    filter: &str,
    values: &[rusqlite::types::Value],
    truth_memo: &mut std::collections::HashMap<String, cache::Truth>,
) -> LabResult<Vec<Value>> {
    // The summary needs the same truth projection, but not crops, URLs, review
    // response bodies or revision fields. Fetch context and aliases in this scan.
    #[cfg(test)]
    let query_start = std::time::Instant::now();
    let has_cache = cache::enabled(conn)?;
    let (context_column, alias_columns, cache_joins) = if has_cache {
        ("CASE WHEN c.payload IS NULL THEN NULL ELSE json_object('guide',json_object('guideUnsupportedReason',json_extract(c.payload,'$.guide.guideUnsupportedReason'),'localization_error',json_extract(c.payload,'$.guide.localization_error')),'presence',json_object('state',json_extract(c.payload,'$.presence.state'),'target_support',json_extract(c.payload,'$.presence.target_support'),'card_evidence',json_object('target_support',json_extract(c.payload,'$.presence.card_evidence.target_support'),'policy',json_extract(c.payload,'$.presence.card_evidence.policy'),'boundary_contact',json_extract(c.payload,'$.presence.card_evidence.boundary_contact'))),'seat_occupancy',json_object('state',json_extract(c.payload,'$.seat_occupancy.state'),'source',json_extract(c.payload,'$.seat_occupancy.source'),'policy',json_extract(c.payload,'$.seat_occupancy.policy'))) END", "a.family,a.cache_key", "LEFT JOIN gameplay_ai_cache_context c ON c.occurrence_id=o.id LEFT JOIN gameplay_ai_cache_aliases a USING(sample_key)")
    } else {
        ("NULL", "NULL,NULL", "")
    };
    let latest_state = if has_cache {
        "CASE WHEN a.sample_key IS NULL THEN (SELECT i.state FROM ai_review_items i WHERE i.sample_key=o.sample_key AND i.state!='pending' ORDER BY rowid DESC LIMIT 1) END"
    } else {
        "(SELECT i.state FROM ai_review_items i WHERE i.sample_key=o.sample_key AND i.state!='pending' ORDER BY rowid DESC LIMIT 1)"
    };
    let guide_missing_context = if has_cache { "c.payload IS NULL" } else { "1" };
    let sql = format!("SELECT o.id,o.frame_id,o.region_id,o.category,o.original_label,o.sample_key,
        CASE WHEN d.id IS NOT NULL THEN d.label WHEN o.state='ambiguous' THEN o.original_label ELSE COALESCE(m.label,q.label,o.original_label) END,
        CASE WHEN o.state='absent' THEN 'absent' WHEN o.state='ambiguous' AND o.reason LIKE 'Presence contradicts occurrence-owned human evidence%' THEN 'ambiguous' WHEN d.id IS NOT NULL THEN d.state WHEN o.state='ambiguous' THEN 'ambiguous' ELSE COALESCE(m.state,{latest_state},o.state) END,
        d.id IS NOT NULL,o.state,COALESCE(d.provenance,'{{}}'),
        CASE WHEN {guide_missing_context} THEN CASE WHEN json_valid(q.payload) THEN CASE WHEN json_type(q.payload,'$.guide')='object' THEN json_extract(q.payload,'$.guide') END END END,
        l.label,l.provenance,{context_column},{alias_columns}
        FROM gameplay_ai_occurrences o LEFT JOIN queue_items q USING(sample_key)
        LEFT JOIN gameplay_ai_manual m USING(sample_key)
        LEFT JOIN gameplay_ai_decisions d ON d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id)
        LEFT JOIN gameplay_ai_legacy l ON l.occurrence_id=o.id {cache_joins}
        WHERE {filter} ORDER BY o.frame_id,o.region_id");
    let mut query = conn.prepare(&sql)?;
    let mut rows=query.query_map(rusqlite::params_from_iter(values.iter()), |r| {
        let guide: Option<String> = r.get(11)?;
        let context: Option<String> = r.get(14)?;
        let family: Option<String> = r.get(15)?;
        let group: Option<String> = r.get(16)?;
        Ok((json!({"id":r.get::<_,String>(0)?,"frame_id":r.get::<_,String>(1)?,"region_id":r.get::<_,String>(2)?,"category":r.get::<_,String>(3)?,"original_label":r.get::<_,String>(4)?,"sample_key":r.get::<_,String>(5)?,"label":r.get::<_,String>(6)?,"state":r.get::<_,String>(7)?,"has_manual_decision":r.get::<_,bool>(8)?,"_own_decision":r.get::<_,bool>(8)?,"_occurrence_state":r.get::<_,String>(9)?,"review_evidence":serde_json::from_str::<Value>(&r.get::<_,String>(10)?).unwrap_or(Value::Null),"guide":guide.and_then(|v|serde_json::from_str::<Value>(&v).ok()).unwrap_or(Value::Null)}), context, family, group, r.get::<_,Option<String>>(12)?, r.get::<_,Option<String>>(13)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    #[cfg(test)]
    if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
        eprintln!(
            "summary input query: {:?} rows={}",
            query_start.elapsed(),
            rows.len()
        );
    }
    #[cfg(test)]
    let projection_start = std::time::Instant::now();
    let mut items = Vec::with_capacity(rows.len());
    for (mut item, context, family, group, legacy_label, legacy_provenance) in rows.drain(..) {
        if has_cache {
            item["_prefetched_context"] = context
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?
                .unwrap_or(Value::Null);
            item["_prefetched_alias"] = match (family, group) {
                (Some(family), Some(group)) => json!([family, group]),
                (None, None) => Value::Null,
                _ => return Err(bad("Invalid cached alias")),
            };
        }
        if let Some(label) = legacy_label {
            let provenance: Value =
                serde_json::from_str(legacy_provenance.as_deref().unwrap_or("null"))?;
            item["legacy_provenance"] = provenance;
            if item["has_manual_decision"] != true {
                item["state"] = json!("legacy_verified");
                item["label"] = json!(label);
                item["_own_decision"] = json!(true);
                item["review_evidence"] = json!({"source":"legacy","cache_eligible":false});
            }
        }
        items.push(item);
    }
    cache::project_with_memo(conn, &mut items, truth_memo)?;
    for item in &mut items {
        finish_projected_item(item);
    }
    #[cfg(test)]
    if std::env::var_os("POKER_SUMMARY_PROFILE").is_some() {
        eprintln!("summary truth projection: {:?}", projection_start.elapsed());
    }
    Ok(items)
}

pub(in crate::lab) fn legacy_region_id(id: &str) -> String {
    if id == "game.id" {
        "round_id".into()
    } else if id == "pot.total" {
        "pot".into()
    } else if let Some(index) = id
        .strip_prefix("board.")
        .and_then(|s| s.strip_suffix(".rank"))
    {
        format!("community_cards[{index}]")
    } else {
        let parts = id.split('.').collect::<Vec<_>>();
        if parts.len() >= 3 && parts[0] == "seat" {
            if let Ok(index) = parts[1].parse::<usize>() {
                let seat = (index + 6) % 9;
                if parts.len() == 5 && parts[2] == "card" && parts[4] == "rank" {
                    format!("seats[{seat}].cards[{}]", parts[3])
                } else {
                    format!("seats[{seat}].{}", parts[2])
                }
            } else {
                id.into()
            }
        } else {
            id.into()
        }
    }
}
fn prediction_key(results: &Value, id: &str) -> String {
    if results.get(id).is_some() {
        id.into()
    } else {
        legacy_region_id(id)
    }
}
fn legacy_prediction(results: &Value, id: &str) -> Value {
    results[prediction_key(results, id)]["prediction"].clone()
}

fn apply_frame_summaries(
    frames: &mut [Value],
    summaries: &std::collections::HashMap<String, Value>,
    baseline: &std::collections::BTreeMap<String, String>,
    profile: &Value,
    hash: &str,
) {
    for frame in frames {
        frame["verification"] = frame["id"]
            .as_str()
            .and_then(|id| summaries.get(id))
            .cloned()
            .unwrap_or_else(|| verification_summary(hash, baseline.values().map(String::as_str)));
        if frame["width"]
            .as_u64()
            .is_some_and(|w| Some(w) != profile["viewport"]["width"].as_u64())
            || frame["height"]
                .as_u64()
                .is_some_and(|h| Some(h) != profile["viewport"]["height"].as_u64())
        {
            frame["verification"] = json!({"region_profile_id":hash,"status":"unavailable","total":0,"verified":0,"unverified":0,"needs_review":0,"unsupported":0});
        }
    }
}

fn verification_summary<'a>(hash: &str, states: impl Iterator<Item = &'a str>) -> Value {
    let mut summary = json!({"region_profile_id":hash,"status":"unverified","total":0,"verified":0,"unverified":0,"needs_review":0,"unsupported":0,"absent_count":0});
    for state in states {
        if state == "visual_indicator" {
            continue;
        }
        if state == "absent" {
            summary["absent_count"] = json!(summary["absent_count"].as_u64().unwrap_or(0) + 1);
            continue;
        }
        let bucket = if ["unchanged", "corrected", "manual", "legacy_verified"].contains(&state) {
            "verified"
        } else if state == "unsupported" {
            "unsupported"
        } else if ["flagged", "conflict", "ambiguous", "error"].contains(&state) {
            "needs_review"
        } else {
            "unverified"
        };
        summary["total"] = json!(summary["total"].as_u64().unwrap_or(0) + 1);
        summary[bucket] = json!(summary[bucket].as_u64().unwrap_or(0) + 1);
    }
    verification_status(&mut summary);
    summary
}

fn verification_status(summary: &mut Value) {
    summary["status"] = json!(if summary["needs_review"].as_u64().unwrap_or(0) > 0 {
        "needs_review"
    } else if summary["total"].as_u64().unwrap_or(0) > 0 && summary["verified"] == summary["total"]
    {
        "verified"
    } else if summary["verified"].as_u64().unwrap_or(0) > 0 {
        "partial"
    } else {
        "unverified"
    });
}

fn legacy_connection(root: &Path) -> LabResult<Option<Connection>> {
    let path = root.join("gameplay.sqlite3");
    if !path.is_file() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_import_labels')",
        [],
        |r| r.get(0),
    )?;
    Ok(exists.then_some(conn))
}
fn legacy_label_prediction(region: &str, label: &Value) -> Value {
    let valid = crate::labels::category_for_region(region).is_some_and(|category| {
        crate::labels::validate_text(category, label["label"].as_str().unwrap_or(""), false)
    });
    json!({"text":label["label"],"schema_valid":valid,"outside_contract":!valid,"review_state":"legacy_verified","visually_verified":false})
}
