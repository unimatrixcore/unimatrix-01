//! Dataset-local visual review with app-wide OpenAI settings. Only explicit start/resume spends API usage.
#[path = "ai_review/credentials.rs"]
mod credentials;
#[path = "ai_review/grid.rs"]
mod grid;
#[path = "ai_review/protocol.rs"]
mod protocol;
#[path = "ai_review/recovery.rs"]
mod recovery;
#[path = "ai_review/risk.rs"]
mod risk;
use super::datasets::{DatasetContext, DatasetRegistry};
use super::model::ModelRuntime;
use super::{bad, conflict, now_ms, uuid, LabRequest, LabResponse, LabResult, LabService};
use crate::launcher_activity::{ActivityLease, ActivityRole};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
const ACTIVE: &[&str] = &["queued", "running"];
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Item {
    job_id: String,
    ordinal: i64,
    batch_index: i64,
    queue_id: i64,
    sample_key: String,
    region_id: String,
    group_name: String,
    prior_label: String,
    prior_prediction_id: Option<String>,
    pixel_sha256: String,
    prior_event_id: i64,
    #[serde(default)]
    crop: Vec<u8>,
    #[serde(default)]
    guide: Value,
}
pub fn region_group(region: &str) -> String {
    if region
        .strip_prefix("pot.")
        .is_some_and(|index| index.parse::<usize>().is_ok())
    {
        return "pot.visible[*]".into();
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\[\d+\]").unwrap())
        .replace_all(region, "[*]")
        .into_owned()
}
fn row_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut value = serde_json::Map::new();
    for index in 0..row.as_ref().column_count() {
        let key = row.as_ref().column_name(index)?;
        use rusqlite::types::ValueRef;
        let v = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(v) => json!(v),
            ValueRef::Real(v) => json!(v),
            ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
            ValueRef::Blob(_) => continue,
        };
        value.insert(key.into(), v);
    }
    Ok(Value::Object(value))
}
fn rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> LabResult<Vec<Value>> {
    let mut query = conn.prepare(sql)?;
    let result = query
        .query_map(args, row_value)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}
fn item(row: &Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        job_id: row.get("job_id")?,
        ordinal: row.get("ordinal")?,
        batch_index: row.get("batch_index")?,
        queue_id: row.get("queue_id")?,
        sample_key: row.get("sample_key")?,
        region_id: row.get("region_id")?,
        group_name: row.get("group_name")?,
        prior_label: row.get("prior_label")?,
        prior_prediction_id: row.get("prior_prediction_id")?,
        pixel_sha256: row.get("pixel_sha256")?,
        prior_event_id: row.get("prior_event_id")?,
        crop: row.get("crop")?,
        guide: row
            .get::<_, String>("visual_evidence")
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|value| value["guide"].clone())
            .unwrap_or(Value::Null),
    })
}
struct Config {
    key: Option<String>,
    model: String,
    running: HashSet<(String, String)>,
    storage_error: Option<String>,
}
type Transport = dyn Fn(Value, &str) -> LabResult<Value> + Send + Sync;
struct Inner {
    registry: Arc<DatasetRegistry>,
    config: Mutex<Config>,
    initialized: Mutex<HashSet<String>>,
    transport: Arc<Transport>,
    background: bool,
    activity: fn(ActivityRole) -> LabResult<ActivityLease>,
    credentials: Option<credentials::CredentialStore>,
}
#[derive(Clone)]
pub struct AiReviewManager {
    inner: Arc<Inner>,
}
impl AiReviewManager {
    pub fn new(
        registry: Arc<DatasetRegistry>,
        _model: Arc<ModelRuntime>,
        config_root: PathBuf,
    ) -> LabResult<Self> {
        Ok(Self::with_storage(
            registry,
            Arc::new(protocol::request),
            true,
            Some(credentials::CredentialStore::new(config_root)),
        ))
    }
    #[cfg(test)]
    pub(crate) fn with_transport(
        registry: Arc<DatasetRegistry>,
        transport: Arc<Transport>,
        background: bool,
    ) -> Self {
        Self::with_storage(registry, transport, background, None)
    }
    #[cfg(test)]
    pub(crate) fn run_fixture(&self, ctx: &Arc<DatasetContext>, id: &str) {
        self.run_job(ctx, id);
    }
    fn with_storage(
        registry: Arc<DatasetRegistry>,
        transport: Arc<Transport>,
        background: bool,
        storage: Option<credentials::CredentialStore>,
    ) -> Self {
        let mut config = Config {
            key: None,
            model: "gpt-4.1".into(),
            running: HashSet::new(),
            storage_error: None,
        };
        if let Some(storage) = &storage {
            match storage.load().and_then(|saved| {
                if let Some(saved) = saved {
                    Self::validate_model(&saved.model)?;
                    Ok(Some(credentials::SavedSettings {
                        api_key: Self::validate_key(saved.api_key.as_deref().unwrap_or(""))?,
                        model: saved.model,
                    }))
                } else {
                    Ok(None)
                }
            }) {
                Ok(Some(saved)) => {
                    config.key = saved.api_key;
                    config.model = saved.model;
                }
                Ok(None) => {}
                Err(error) => {
                    config.storage_error =
                        Some(format!("{}; save AI review settings again", error.message));
                }
            }
        }
        Self {
            inner: Arc::new(Inner {
                registry,
                config: Mutex::new(config),
                initialized: Mutex::new(HashSet::new()),
                transport,
                background,
                activity: ActivityLease::acquire,
                credentials: storage,
            }),
        }
    }
    pub fn ensure(&self, ctx: &DatasetContext) -> LabResult<()> {
        let mut initialized = self
            .inner
            .initialized
            .lock()
            .map_err(|_| conflict("AI initialization lock poisoned"))?;
        if initialized.contains(&ctx.id) {
            return Ok(());
        }
        super::review::ensure(ctx)?;
        super::queue::ensure(ctx)?;
        ctx.connection()?.execute_batch("CREATE TABLE IF NOT EXISTS ai_review_jobs(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,model TEXT NOT NULL,batch_size INTEGER NOT NULL,auto_correct INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',usage TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS ai_review_items(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,batch_index INTEGER NOT NULL,queue_id INTEGER NOT NULL,sample_key TEXT NOT NULL,region_id TEXT NOT NULL,group_name TEXT NOT NULL,prior_label TEXT NOT NULL,prior_prediction_id TEXT,pixel_sha256 TEXT NOT NULL,prior_event_id INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,PRIMARY KEY(job_id,ordinal),UNIQUE(job_id,sample_key));
CREATE TABLE IF NOT EXISTS ai_review_batches(job_id TEXT NOT NULL,batch_index INTEGER NOT NULL,grid BLOB,blind_grid BLOB,response TEXT,verification TEXT,PRIMARY KEY(job_id,batch_index));
CREATE TABLE IF NOT EXISTS ai_review_attempts(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,batch_index INTEGER NOT NULL,phase TEXT NOT NULL,attempt INTEGER NOT NULL,created_at INTEGER NOT NULL,response_id TEXT,model TEXT,usage TEXT NOT NULL,error TEXT NOT NULL,repairs TEXT NOT NULL,diagnostics TEXT NOT NULL);
UPDATE ai_review_jobs SET state='interrupted',error='Collector restarted. Resume to continue.' WHERE state IN ('running','queued');")?;
        {
            let mut conn = ctx.connection()?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let columns: Vec<String> = tx
                .prepare("PRAGMA table_info(ai_review_attempts)")?
                .query_map([], |row| row.get(1))?
                .collect::<rusqlite::Result<_>>()?;
            for (name, default) in [("repairs", "[]"), ("diagnostics", "{}")] {
                if !columns.iter().any(|column| column == name) {
                    tx.execute_batch(&format!("ALTER TABLE ai_review_attempts ADD COLUMN {name} TEXT NOT NULL DEFAULT '{default}'"))?;
                }
            }
            tx.commit()?;
        }
        initialized.insert(ctx.id.clone());
        Ok(())
    }
    pub(crate) fn evidence_plan(
        &self,
        ctx: &DatasetContext,
        batch: i64,
        mixed: bool,
    ) -> LabResult<Value> {
        self.ensure(ctx)?;
        let conn = ctx.connection()?;
        let mut snapshot=rows(&conn,"SELECT queue_id,sample_key,region_id,label,prediction_id,pixel_sha256,payload,frame_id FROM queue_items WHERE active=1 AND reviewed=1 AND discarded=0 ORDER BY queue_id",[])?;
        let ceiling = snapshot
            .iter()
            .filter_map(|row| row["queue_id"].as_i64())
            .max()
            .unwrap_or(0);
        risk::order(&conn, &mut snapshot, ceiling)?;
        let batches = grid::plan_batches_mixed(&snapshot, batch, mixed)?;
        let mut panels = 0usize;
        for indices in &batches {
            let mut keys = HashSet::new();
            for index in indices {
                let row = &snapshot[*index];
                let guide = serde_json::from_str::<Value>(row["payload"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null)["guide"]
                    .clone();
                let key = grid::panel_key(&guide, row["pixel_sha256"].as_str().unwrap_or(""))
                    .unwrap_or_else(|| format!("semantic-{index}"));
                keys.insert(key);
            }
            panels += keys.len();
        }
        Ok(
            json!({"batch_size_semantic_ceiling":batch,"semantic_items":snapshot.len(),"presentation_panels":panels,"first_pass_batches":batches.len(),"two_pass_calls_upper_without_repairs":batches.len()*2,"provider_calls":0}),
        )
    }
    pub(crate) fn preview_grid(
        &self,
        ctx: &DatasetContext,
        keys: &[String],
        blind: bool,
    ) -> LabResult<Vec<u8>> {
        let conn = ctx.connection()?;
        let mut items = Vec::new();
        for (ordinal, key) in keys.iter().enumerate() {
            let (region, label, crop, payload): (String, String, Vec<u8>, String) = conn
                .query_row(
                    &format!(
                        "SELECT region_id,label,{},payload FROM queue_items WHERE sample_key=?",
                        super::pixel_assets::expression(&conn, "queue_items")?
                    ),
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            items.push(Item {
                job_id: "read-only-evidence-preview".into(),
                ordinal: ordinal as i64,
                batch_index: 0,
                queue_id: 0,
                sample_key: key.clone(),
                group_name: region_group(&region),
                region_id: region,
                prior_label: label,
                prior_prediction_id: None,
                pixel_sha256: String::new(),
                prior_event_id: 0,
                crop,
                guide: serde_json::from_str::<Value>(&payload)?["guide"].clone(),
            });
        }
        grid::build(&items, blind)
    }
    pub fn config(&self) -> LabResult<Value> {
        let c = self
            .inner
            .config
            .lock()
            .map_err(|_| conflict("AI configuration lock poisoned"))?;
        if let Some(error) = &c.storage_error {
            return Err(super::unavailable(error.clone()));
        }
        Ok(
            json!({"configured":c.key.as_ref().is_some_and(|k|!k.is_empty())||std::env::var("OPENAI_API_KEY").is_ok_and(|k|!k.is_empty()),"model":c.model,"batch_size":12,"max_batch_size":24}),
        )
    }
    fn validate_model(model: &str) -> LabResult<()> {
        if !regex::Regex::new(r"\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}\z")
            .unwrap()
            .is_match(model)
        {
            return Err(bad("Invalid OpenAI model name"));
        }
        Ok(())
    }
    fn validate_key(key: &str) -> LabResult<Option<String>> {
        if key.chars().count() > 1000
            || key
                .chars()
                .any(|value| value.is_whitespace() || value.is_control())
        {
            return Err(bad("API key must be a single token"));
        }
        Ok(if key.is_empty() {
            None
        } else {
            Some(key.into())
        })
    }
    pub fn configure(&self, data: &Value) -> LabResult<Value> {
        let object = super::object(data)?;
        if object
            .keys()
            .any(|key| !["api_key", "model"].contains(&key.as_str()))
        {
            return Err(bad("Unknown AI review settings"));
        }
        let key = data
            .get("api_key")
            .filter(|value| !value.is_null())
            .map(|value| {
                Self::validate_key(
                    value
                        .as_str()
                        .ok_or_else(|| bad("API key must be a single token"))?,
                )
            })
            .transpose()?;
        let model = data
            .get("model")
            .filter(|value| !value.is_null())
            .map(|value| {
                let model = value
                    .as_str()
                    .ok_or_else(|| bad("Invalid OpenAI model name"))?;
                Self::validate_model(model)?;
                Ok::<_, super::LabError>(model.to_owned())
            })
            .transpose()?;
        {
            let mut config = self
                .inner
                .config
                .lock()
                .map_err(|_| conflict("AI configuration lock poisoned"))?;
            let saved = credentials::SavedSettings {
                api_key: key.unwrap_or_else(|| config.key.clone()),
                model: model.unwrap_or_else(|| config.model.clone()),
            };
            if let Some(storage) = &self.inner.credentials {
                storage.save(&saved)?;
            }
            config.key = saved.api_key;
            config.model = saved.model;
            config.storage_error = None;
        }
        self.config()
    }
    pub fn handle_configuration(&self, request: &LabRequest) -> Option<LabResult<LabResponse>> {
        if request.path != "/api/ai-review/config" {
            return None;
        }
        Some(match request.method.as_str() {
            "GET" => self.config().map(LabResponse::ok),
            "POST" => self.configure(&request.body).map(LabResponse::ok),
            _ => Err(super::not_found("Unknown AI review configuration route")),
        })
    }
    fn job(conn: &Connection, ctx: &DatasetContext, id: &str) -> LabResult<Value> {
        if id.len() != 32
            || !id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(bad("Invalid AI review job identity"));
        }
        conn.query_row(
            "SELECT * FROM ai_review_jobs WHERE id=? AND dataset_id=?",
            params![id, ctx.id],
            row_value,
        )
        .optional()?
        .ok_or_else(|| bad("AI review job does not belong to this dataset"))
    }
    fn active_run(&self, conn: &Connection, ctx: &DatasetContext, run: &str) -> LabResult<Value> {
        if ctx.id == "gameplay-ai" {
            ctx.ensure_active()?;
        } else {
            self.inner.registry.resolve(&ctx.id)?;
        }
        if run.is_empty() || run.chars().count() > 64 {
            return Err(bad("Review run identity is required"));
        }
        let saved: Option<String> = conn
            .query_row(
                "SELECT value FROM queue_meta WHERE key=?",
                [format!("stream:{run}")],
                |r| r.get(0),
            )
            .optional()?;
        let active: Option<String> = conn
            .query_row(
                "SELECT value FROM queue_meta WHERE key='active_stream'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let record: Value = saved
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null);
        let current: Value = active
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(Value::Null);
        if record["dataset_id"] != ctx.id || current != run {
            return Err(conflict("Review run changed; reload the current review"));
        }
        if record["state"] != "active" {
            return Err(conflict("Review run is no longer active"));
        }
        Ok(record)
    }
    pub fn is_busy(&self, ctx: &DatasetContext) -> LabResult<bool> {
        self.ensure(ctx)?;
        Ok(ctx
            .connection()?
            .query_row(
                "SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running') LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
    pub fn start(&self, ctx: &Arc<DatasetContext>, data: &Value) -> LabResult<Value> {
        self.ensure(ctx)?;
        super::object(data)?;
        let run = data["run_id"]
            .as_str()
            .filter(|r| !r.is_empty() && r.chars().count() <= 64)
            .ok_or_else(|| bad("Review run identity is required"))?;
        let config = self.config()?;
        let model = data
            .get("model")
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
            .unwrap_or(&config["model"])
            .as_str()
            .ok_or_else(|| bad("Invalid OpenAI model name"))?;
        Self::validate_model(model)?;
        let batch = data
            .get("batch_size")
            .unwrap_or(&json!(12))
            .as_i64()
            .filter(|b| (1..=24).contains(b))
            .ok_or_else(|| bad("Batch size must be between 1 and 24"))?;
        let auto = data
            .get("auto_correct")
            .unwrap_or(&Value::Bool(true))
            .as_bool()
            .ok_or_else(|| bad("auto_correct must be boolean"))?;
        if config["configured"] != true {
            return Err(bad("Add an OpenAI API key before starting visual review"));
        }
        let lease = (self.inner.activity)(ActivityRole::Review)?;
        let id = uuid();
        {
            let mut config = self
                .inner
                .config
                .lock()
                .map_err(|_| conflict("AI configuration lock poisoned"))?;
            let mut conn = ctx.connection()?;
            if conn
                .query_row(
                    "SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running') LIMIT 1",
                    [],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                return Err(conflict(
                    "An OpenAI review is already running for this dataset",
                ));
            }
            if config.running.len() >= 2 {
                return Err(conflict(
                    "Two OpenAI reviews are already running; wait for one to finish",
                ));
            }
            let snapshot = self.active_run(&conn, ctx, run)?;
            let ceiling = snapshot["ceiling"]
                .as_i64()
                .ok_or_else(|| bad("Invalid review run ceiling"))?;
            let repair = data
                .get("repair_sample_keys")
                .filter(|value| !value.is_null());
            if repair.is_some() && ctx.id != "gameplay-ai" {
                return Err(bad("Diagnostic evidence selection is Gameplay-only"));
            }
            let mut snapshot=rows(&conn,"SELECT queue_id,sample_key,region_id,label,prediction_id,pixel_sha256,payload,active,reviewed,frame_id FROM queue_items WHERE discarded=0 AND queue_id<=? ORDER BY queue_id",[ceiling])?;
            if let Some(keys) = repair {
                let keys = keys
                    .as_array()
                    .filter(|keys| !keys.is_empty() && keys.len() <= 2)
                    .ok_or_else(|| bad("Repair requires1to2existing samples"))?;
                let keys = keys
                    .iter()
                    .map(|key| key.as_str().ok_or_else(|| bad("Invalid repair sample")))
                    .collect::<LabResult<HashSet<_>>>()?;
                snapshot.retain(|row| keys.contains(row["sample_key"].as_str().unwrap_or("")));
                if snapshot.len() != keys.len() {
                    return Err(bad("Unknown repair sample"));
                }
                if batch != 1 || auto {
                    return Err(bad(
                        "Repair requires isolated batches and automatic correction disabled",
                    ));
                }
            } else {
                snapshot.retain(|row| {
                    row["active"] == 1
                        && (row["reviewed"] == 1
                            || (ctx.id == "gameplay-ai" && data["recover_from_job_id"].is_string()))
                });
            }
            if snapshot.is_empty() {
                return Err(bad("This review run has no labeled crops to check"));
            }
            if snapshot.len() > 100_000 {
                return Err(bad("Review snapshot exceeds 100,000 crops"));
            }
            risk::order(&conn, &mut snapshot, ceiling)?;
            let latest: BTreeMap<String, i64> = rows(
                &conn,
                "SELECT sample_key,MAX(id) event_id FROM label_review_events GROUP BY sample_key",
                [],
            )?
            .into_iter()
            .map(|r| {
                (
                    r["sample_key"].as_str().unwrap().into(),
                    r["event_id"].as_i64().unwrap(),
                )
            })
            .collect();
            let tx = conn.transaction()?;
            let now = now_ms();
            tx.execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?)",params![id,ctx.id,run,model,batch,auto,now,now])?;
            if ctx.id == "gameplay-ai" {
                let budget = data["max_requests"].as_u64().unwrap_or(100);
                if !(1..=10000).contains(&budget) {
                    return Err(bad("Request budget must be1to10000"));
                }
                tx.execute(
                    "INSERT INTO queue_meta(key,value) VALUES(?,?)",
                    params![format!("gameplay_request_budget:{id}"), budget.to_string()],
                )?;
                // Keep the gameplay link in the same transaction as the job. A crash
                // after commit must never leave an unlinked, potentially billed job.
                let has_gameplay_runs: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='gameplay_ai_runs')",
                    [],
                    |row| row.get(0),
                )?;
                if has_gameplay_runs {
                    let linked = tx.execute(
                        "UPDATE gameplay_ai_runs SET job_id=? WHERE run_id=? AND (job_id IS NULL OR ?)",
                        params![id, run, repair.is_some()],
                    )?;
                    if linked != 1 {
                        return Err(conflict("Prepared Gameplay scope changed"));
                    }
                }
                tx.execute("UPDATE ai_review_jobs SET usage=? WHERE id=?",params![json!({"evidence_policy":if repair.is_some(){"gameplay_isolated_blind_v1"}else{"gameplay_family_blind_v1"},"diagnostic_only":repair.is_some(),"recover_from_job_id":data["recover_from_job_id"],"reading_contract":protocol::READING_CONTRACT,"review_policy":super::gameplay::ai::evidence_cache::REVIEW_POLICY}).to_string(),id])?;
            }
            let mut ordinal = 0i64;
            for (batch_index, indices) in grid::plan_batches_mixed(
                &snapshot,
                batch,
                ctx.id == "gameplay-ai" && data["mixed_regions"] == true,
            )?
            .into_iter()
            .enumerate()
            {
                for index in indices {
                    let row = &snapshot[index];
                    let group = region_group(row["region_id"].as_str().unwrap());
                    let key = row["sample_key"].as_str().unwrap();
                    tx.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,prior_prediction_id,pixel_sha256,prior_event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![id,ordinal,batch_index as i64,row["queue_id"].as_i64(),key,row["region_id"].as_str(),group,row["label"].as_str(),row["prediction_id"].as_str(),row["pixel_sha256"].as_str(),latest.get(key).copied().unwrap_or(0)])?;
                    ordinal += 1;
                }
            }
            if let Some(source) = data["recover_from_job_id"].as_str() {
                recovery::import(&tx, ctx, source, &id)?;
            }
            tx.commit()?;
            if self.inner.background {
                config.running.insert((ctx.id.clone(), id.clone()));
            }
        }
        self.launch(ctx, id.clone(), lease);
        self.status(ctx, Some(&id), None)
    }
    fn launch(&self, ctx: &Arc<DatasetContext>, id: String, lease: ActivityLease) {
        if self.inner.background {
            let manager = self.clone();
            let ctx = ctx.clone();
            std::thread::spawn(move || {
                let _lease = lease;
                manager.run_job(&ctx, &id);
            });
        }
    }
    pub fn resume(&self, ctx: &Arc<DatasetContext>, id: &str) -> LabResult<Value> {
        self.resume_with_limit(ctx, id, None)
    }
    pub fn resume_with_limit(
        &self,
        ctx: &Arc<DatasetContext>,
        id: &str,
        max_requests: Option<u64>,
    ) -> LabResult<Value> {
        if max_requests.is_some_and(|limit| !(1..=10000).contains(&limit)) {
            return Err(bad("Request limit must be an integer from 1 to 10000"));
        }
        self.ensure(ctx)?;
        let lease = (self.inner.activity)(ActivityRole::Review)?;
        if self.config()?["configured"] != true {
            return Err(bad("Add an OpenAI API key before resuming"));
        }
        {
            let mut config = self
                .inner
                .config
                .lock()
                .map_err(|_| conflict("AI configuration lock poisoned"))?;
            if config.running.contains(&(ctx.id.clone(), id.into())) {
                return Err(conflict(
                    "The previous request is still stopping. Resume after it settles.",
                ));
            }
            let conn = ctx.connection()?;
            let job = Self::job(&conn, ctx, id)?;
            if !["failed", "interrupted", "cancelled"]
                .contains(&job["state"].as_str().unwrap_or(""))
            {
                return Err(bad("Only stopped or interrupted reviews can resume"));
            }
            self.active_run(&conn, ctx, job["run_id"].as_str().unwrap())?;
            if config.running.len() >= 2 {
                return Err(conflict("Two OpenAI reviews are already running"));
            }
            if conn
                .query_row(
                    "SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running') AND id!=?",
                    [id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                return Err(conflict(
                    "Another review is already running for this dataset",
                ));
            }
            if ctx.id == "gameplay-ai" {
                super::gameplay::ai::quarantine::guard(&conn, id)?;
                let limit = match max_requests {
                    Some(limit) => limit,
                    None => conn.query_row(
                        "SELECT CAST(value AS INTEGER) FROM queue_meta WHERE key=?",
                        [format!("gameplay_request_budget:{id}")],
                        |r| r.get::<_, i64>(0),
                    )? as u64,
                };
                let usage: Value = serde_json::from_str(job["usage"].as_str().unwrap_or("{}"))?;
                if usage["requests"].as_u64().unwrap_or(0) >= limit {
                    return Err(bad("Request limit is already exhausted; set a limit above requests already used"));
                }
                if max_requests.is_some() {
                    conn.execute(
                        "INSERT INTO queue_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![format!("gameplay_request_budget:{id}"), limit.to_string()],
                    )?;
                }
            }
            conn.execute(
                "UPDATE ai_review_jobs SET state='queued',error='',updated_at=? WHERE id=?",
                params![now_ms(), id],
            )?;
            if self.inner.background {
                config.running.insert((ctx.id.clone(), id.into()));
            }
        }
        self.launch(ctx, id.into(), lease);
        self.status(ctx, Some(id), None)
    }
    pub fn cancel(&self, ctx: &DatasetContext, id: &str) -> LabResult<Value> {
        self.ensure(ctx)?;
        {
            let conn = ctx.connection()?;
            Self::job(&conn, ctx, id)?;
            conn.execute("UPDATE ai_review_jobs SET state='cancelled',error='',updated_at=? WHERE id=? AND state IN ('running','queued')",params![now_ms(),id])?;
        }
        self.status(ctx, Some(id), None)
    }
    pub fn status(
        &self,
        ctx: &DatasetContext,
        id: Option<&str>,
        run: Option<&str>,
    ) -> LabResult<Value> {
        self.ensure(ctx)?;
        let conn = ctx.connection()?;
        let owned = if id.is_none() {
            let sql="SELECT id FROM ai_review_jobs WHERE dataset_id=? AND (? IS NULL OR run_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1";
            conn.query_row(sql, params![ctx.id, run, run], |r| r.get::<_, String>(0))
                .optional()?
        } else {
            None
        };
        let Some(id) = id.or(owned.as_deref()) else {
            return Ok(Value::Null);
        };
        let mut job = Self::job(&conn, ctx, id)?;
        let counts: BTreeMap<String, i64> = rows(
            &conn,
            "SELECT state,COUNT(*) n FROM ai_review_items WHERE job_id=? GROUP BY state",
            [id],
        )?
        .into_iter()
        .map(|r| {
            (
                r["state"].as_str().unwrap().into(),
                r["n"].as_i64().unwrap(),
            )
        })
        .collect();
        let count = |s: &str| counts.get(s).copied().unwrap_or(0);
        let total: i64 = counts.values().sum();
        let pending=rows(&conn,"SELECT batch_index,group_name FROM ai_review_items WHERE job_id=? AND state='pending' ORDER BY ordinal LIMIT 1",[id])?.into_iter().next();
        let recent:Vec<Value>=rows(&conn,"SELECT result FROM ai_review_items WHERE job_id=? AND result IS NOT NULL ORDER BY ordinal DESC LIMIT 20",[id])?.into_iter().map(|r|serde_json::from_str(r["result"].as_str().unwrap())).collect::<Result<_,_>>()?;
        let batches: i64 = conn.query_row(
            "SELECT COALESCE(MAX(batch_index)+1,0) FROM ai_review_items WHERE job_id=?",
            [id],
            |r| r.get(0),
        )?;
        let available: Option<i64> = conn.query_row(
            "SELECT MAX(batch_index) FROM ai_review_batches WHERE job_id=? AND grid IS NOT NULL",
            [id],
            |r| r.get(0),
        )?;
        let grid_region: Option<String> = conn
            .query_row(
                "SELECT group_name FROM ai_review_items WHERE job_id=? AND batch_index=? LIMIT 1",
                params![id, available],
                |r| r.get(0),
            )
            .optional()?;
        let usage: Value = serde_json::from_str(job["usage"].as_str().unwrap())?;
        let auto = job["auto_correct"].as_i64() == Some(1);
        let object = job.as_object_mut().unwrap();
        object.remove("usage");
        object.insert("auto_correct".into(), json!(auto));
        for(key,value)in json!({"total":total,"checked":total-count("pending"),"corrected":count("corrected"),"flagged":count("flagged"),"conflicts":count("conflict"),"unchanged":count("unchanged"),"batches":batches,"batch_index":pending.as_ref().map(|p|p["batch_index"].as_i64().unwrap()).unwrap_or((batches-1).max(0)),"region":pending.as_ref().and_then(|p|p["group_name"].as_str()).unwrap_or(""),"grid_batch_index":available,"grid_region":grid_region.unwrap_or_default(),"usage":usage,"recent":recent,"changes":recent,"visually_verified":false}).as_object().unwrap(){object.insert(key.clone(),value.clone());}
        Ok(job)
    }
    pub fn results(
        &self,
        ctx: &DatasetContext,
        id: &str,
        cursor: usize,
        limit: usize,
    ) -> LabResult<Value> {
        if !(1..=100).contains(&limit) || cursor > i64::MAX as usize {
            return Err(bad("Invalid AI result page"));
        }
        self.ensure(ctx)?;
        let conn = ctx.connection()?;
        Self::job(&conn, ctx, id)?;
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ai_review_items WHERE job_id=? AND result IS NOT NULL",
            [id],
            |r| r.get(0),
        )?;
        let items:Vec<Value>=rows(&conn,"SELECT result FROM ai_review_items WHERE job_id=? AND result IS NOT NULL ORDER BY ordinal LIMIT ? OFFSET ?",params![id,limit as i64,cursor as i64])?.iter().map(|r|serde_json::from_str(r["result"].as_str().unwrap())).collect::<Result<_,_>>()?;
        Ok(
            json!({"items":items,"total":total,"next_cursor":if cursor.saturating_add(limit)<total as usize{Some(cursor+limit)}else{None}}),
        )
    }
    pub fn grid(
        &self,
        ctx: &DatasetContext,
        id: &str,
        index: usize,
        blind: bool,
    ) -> LabResult<Vec<u8>> {
        self.ensure(ctx)?;
        let conn = ctx.connection()?;
        Self::job(&conn, ctx, id)?;
        let sql = if blind {
            "SELECT blind_grid FROM ai_review_batches WHERE job_id=? AND batch_index=?"
        } else {
            "SELECT grid FROM ai_review_batches WHERE job_id=? AND batch_index=?"
        };
        conn.query_row(sql, params![id, index as i64], |r| {
            r.get::<_, Option<Vec<u8>>>(0)
        })
        .optional()?
        .flatten()
        .ok_or_else(|| bad("Grid is not available yet"))
    }
    pub fn handle(
        &self,
        _service: &LabService,
        ctx: &Arc<DatasetContext>,
        request: &LabRequest,
    ) -> Option<LabResult<LabResponse>> {
        if !request.path.starts_with("/api/ai-review/") {
            return None;
        }
        Some((|| {
            let parts: Vec<_> = request
                .path
                .trim_start_matches("/api/ai-review/")
                .split('/')
                .collect();
            let mut response = match (request.method.as_str(), parts.as_slice()) {
                ("GET", ["jobs"]) => {
                    LabResponse::ok(json!({"job":self.status(ctx,None,request.query("run_id"))?}))
                }
                ("POST", ["jobs"]) => {
                    LabResponse::ok(json!({"job":self.start(ctx,&request.body)?}))
                }
                ("GET", ["jobs", id]) => {
                    LabResponse::ok(json!({"job":self.status(ctx,Some(id),None)?}))
                }
                ("POST", ["jobs", id, "cancel"]) => {
                    LabResponse::ok(json!({"job":self.cancel(ctx,id)?}))
                }
                ("POST", ["jobs", id, "resume"]) => {
                    LabResponse::ok(json!({"job":self.resume(ctx,id)?}))
                }
                ("GET", ["jobs", id, "results"]) => LabResponse::ok(self.results(
                    ctx,
                    id,
                    request.number("cursor", 0)?,
                    request.number("limit", 50)?,
                )?),
                ("GET", ["jobs", id, "grid"]) => LabResponse::binary(
                    &self.grid(ctx, id, request.number("batch", 0)?, false)?,
                    "image/png",
                ),
                _ => return Err(super::not_found("Unknown AI review endpoint")),
            };
            response
                .headers
                .insert("Cache-Control".into(), "private, no-store".into());
            Ok(response)
        })())
    }
    fn still_running(&self, ctx: &DatasetContext, id: &str) -> LabResult<bool> {
        Ok(ACTIVE.contains(
            &Self::job(&*ctx.connection()?, ctx, id)?["state"]
                .as_str()
                .unwrap_or(""),
        ))
    }
    fn complete_gameplay_intent(
        conn: &mut Connection,
        request_key: &str,
        response: Option<&Value>,
    ) -> LabResult<()> {
        let tx = conn.transaction()?;
        if let Some(response) = response {
            if tx.execute("UPDATE gameplay_ai_request_intents SET state='received',response=? WHERE request_key=? AND state='pending'", params![response.to_string(),request_key])? != 1 {
                return Err(conflict("Provider request intent changed before response persistence"));
            }
        } else if !tx.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_request_intents WHERE request_key=? AND state='received' AND response IS NOT NULL)",[request_key],|r|r.get::<_,bool>(0))? {
            return Err(conflict("Saved provider response is unavailable"));
        }
        tx.execute(
            "UPDATE gameplay_ai_asset_requests SET state='received' WHERE request_key=?",
            [request_key],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn call(
        &self,
        ctx: &DatasetContext,
        id: &str,
        model: &str,
        png: &[u8],
        items: &[Item],
        blind: bool,
    ) -> LabResult<Option<Value>> {
        if !self.still_running(ctx, id)? {
            return Ok(None);
        }
        let key = self
            .inner
            .config
            .lock()
            .map_err(|_| conflict("AI configuration lock poisoned"))?
            .key
            .clone()
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| bad("OpenAI API key is no longer configured."))?;
        let mut feedback = None;
        for attempt in 0..3 {
            if !self.still_running(ctx, id)? {
                return Ok(None);
            }
            {
                let _operation = ctx.lock_operation()?;
                let conn = ctx.connection()?;
                let job = Self::job(&conn, ctx, id)?;
                if !ACTIVE.contains(&job["state"].as_str().unwrap_or("")) {
                    return Ok(None);
                }
                self.active_run(&conn, ctx, job["run_id"].as_str().unwrap())?;
            }
            let mut payload =
                protocol::payload(model, png, items, blind || ctx.id == "gameplay-ai");
            if ctx.id == "gameplay-ai" {
                let job = Self::job(&*ctx.connection()?, ctx, id)?;
                let metadata = serde_json::from_str::<Value>(job["usage"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null);
                let policy = metadata["evidence_policy"]
                    .as_str()
                    .unwrap_or("gameplay_family_blind_v1");
                let prompt = payload["input"][0]["content"][0]["text"]
                    .as_str()
                    .unwrap_or("");
                payload["input"][0]["content"][0]["text"] =
                    json!(format!("Evidence presentation policy: {policy}. {prompt}"));
            }
            if ctx.id == "gameplay-ai" && !blind {
                let prompt = payload["input"][0]["content"][0]["text"]
                    .as_str()
                    .unwrap_or("");
                payload["input"][0]["content"][0]["text"] =
                    json!(format!("First unverified pixel-only reading. {prompt}"));
            }
            if let Some(error) = &feedback {
                if let Some(prompt) = payload["input"][0]["content"][0]["text"].as_str() {
                    payload["input"][0]["content"][0]["text"]=json!(format!("{prompt}\nYour previous response failed validation: {error} Return the complete corrected JSON with exactly the requested IDs. Preserve the image transcription; do not invent missing text. Text must be at most 200 characters, reason at most 1000; clear requires nonempty text and blank requires empty text."));
                }
            }
            let transport_result = if ctx.id == "gameplay-ai" {
                let request_key =
                    super::sha256(format!("{id}:{}", serde_json::to_string(&payload)?).as_bytes());
                let mut conn = ctx.connection()?;
                conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_request_intents(request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS gameplay_ai_asset_requests(claim_key TEXT PRIMARY KEY,request_key TEXT NOT NULL,state TEXT NOT NULL)")?;
                let saved:Option<(String,Option<String>)>=conn.query_row("SELECT state,response FROM gameplay_ai_request_intents WHERE request_key=? AND job_id=?",params![request_key,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((state, response)) = saved {
                    if state != "received" {
                        return Err(bad("A previous provider request has an unknown outcome; automatic retry is blocked"));
                    }
                    let mut response: Value = serde_json::from_str(
                        response
                            .as_deref()
                            .ok_or_else(|| bad("Saved provider response missing"))?,
                    )?;
                    Self::complete_gameplay_intent(&mut conn, &request_key, None)?;
                    response["_reused_response"] = json!(true);
                    Ok(response)
                } else {
                    let phase = if blind { "verification" } else { "review" };
                    for item in items {
                        let claim =
                            super::sha256(format!("{}:{phase}", item.sample_key).as_bytes());
                        let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_asset_requests WHERE claim_key=? AND state='pending')",[&claim],|r|r.get(0))?;
                        if pending {
                            return Err(bad("A previous provider request for this crop has an unknown outcome; automatic retry is blocked"));
                        }
                    }
                    let limit: Option<String> = conn
                        .query_row(
                            "SELECT value FROM queue_meta WHERE key=?",
                            [format!("gameplay_request_budget:{id}")],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let limit = limit
                        .and_then(|v| v.parse::<i64>().ok())
                        .filter(|v| (1..=10000).contains(v))
                        .ok_or_else(|| bad("Set an explicit request limit before resuming this older Gameplay review"))?;
                    let used: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM gameplay_ai_request_intents WHERE job_id=?",
                        [id],
                        |r| r.get(0),
                    )?;
                    if used >= limit {
                        return Err(bad(
                            "Gameplay request budget reached; no further API request was sent",
                        ));
                    }
                    conn.execute("INSERT INTO gameplay_ai_request_intents(request_key,job_id,state,created_at) VALUES(?,?,'pending',?)",params![request_key,id,now_ms()])?;
                    for item in items {
                        let claim =
                            super::sha256(format!("{}:{phase}", item.sample_key).as_bytes());
                        conn.execute("INSERT INTO gameplay_ai_asset_requests(claim_key,request_key,state) VALUES(?,?,'pending') ON CONFLICT(claim_key) DO UPDATE SET request_key=excluded.request_key,state='pending'",params![claim,request_key])?;
                    }
                    drop(conn);
                    let response = (self.inner.transport)(payload, &key);
                    if let Ok(value) = &response {
                        Self::complete_gameplay_intent(
                            &mut *ctx.connection()?,
                            &request_key,
                            Some(value),
                        )?;
                    }
                    response
                }
            } else {
                (self.inner.transport)(payload, &key)
            };
            let response = match transport_result {
                Ok(response) => response,
                Err(error) => {
                    self.record_attempt(
                        ctx,
                        id,
                        items,
                        blind,
                        attempt,
                        None,
                        Some(&error.message),
                        &[],
                    )?;
                    if ctx.id == "gameplay-ai" {
                        return Err(error);
                    }
                    if !protocol::retryable_transport(&error.message) || attempt == 2 {
                        return Err(error);
                    }
                    if !self.retry_pause(ctx, id, attempt)? {
                        return Ok(None);
                    }
                    continue;
                }
            };
            let (response, repairs) = protocol::repair_format(&response);
            let parsed = protocol::parse(&response, items);
            self.record_attempt(
                ctx,
                id,
                items,
                blind,
                attempt,
                Some(&response),
                parsed.as_ref().err().map(|error| error.message.as_str()),
                &repairs,
            )?;
            if !self.still_running(ctx, id)? {
                return Ok(None);
            }
            match parsed {
                Ok(readings) => {
                    let mut parsed = serde_json::to_value(readings)?;
                    let mut identity = serde_json::Map::new();
                    for field in ["id", "model"] {
                        if let Some(value) = response[field].as_str() {
                            identity.insert(
                                field.into(),
                                json!(value.chars().take(200).collect::<String>()),
                            );
                        }
                    }
                    for item in items {
                        let reading = &mut parsed[&item.ordinal.to_string()];
                        reading["_response"] = Value::Object(identity.clone());
                        reading["request_evidence"] = recovery::request_evidence(
                            &item.guide,
                            &item.pixel_sha256,
                            &item.sample_key,
                            &item.group_name,
                        );
                    }
                    parsed
                        .as_object_mut()
                        .unwrap()
                        .insert("_response".into(), Value::Object(identity));
                    parsed["_response"]["format_repairs"] = json!(repairs);
                    return Ok(Some(parsed));
                }
                Err(error) => {
                    if error.message == "OpenAI declined this batch. No labels were changed."
                        || attempt == 2
                    {
                        return Err(error);
                    }
                    feedback = Some(error.message);
                    if !self.retry_pause(ctx, id, attempt)? {
                        return Ok(None);
                    }
                }
            }
        }
        unreachable!()
    }
    fn retry_pause(&self, ctx: &DatasetContext, id: &str, attempt: usize) -> LabResult<bool> {
        for _ in 0..(20 << attempt) {
            if !self.still_running(ctx, id)? {
                return Ok(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        self.still_running(ctx, id)
    }
    #[allow(clippy::too_many_arguments)]
    fn record_attempt(
        &self,
        ctx: &DatasetContext,
        id: &str,
        items: &[Item],
        blind: bool,
        attempt: usize,
        response: Option<&Value>,
        error: Option<&str>,
        repairs: &[&str],
    ) -> LabResult<()> {
        let mut conn = ctx.connection()?;
        let tx = conn.transaction()?;
        let response = response.cloned().unwrap_or(Value::Null);
        let job = Self::job(&tx, ctx, id)?;
        let mut usage: Value = serde_json::from_str(job["usage"].as_str().unwrap())?;
        for field in ["input_tokens", "output_tokens", "total_tokens"] {
            if response["_reused_response"] == true {
                continue;
            }
            if let Some(value) = response["usage"][field].as_u64() {
                usage[field] = json!(usage[field].as_u64().unwrap_or(0).saturating_add(value));
            }
        }
        if response["_reused_response"] != true {
            usage["requests"] = json!(usage["requests"].as_u64().unwrap_or(0).saturating_add(1));
        }
        tx.execute("INSERT INTO ai_review_attempts(job_id,batch_index,phase,attempt,created_at,response_id,model,usage,error,repairs,diagnostics) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![id,items.first().map(|item|item.batch_index).unwrap_or(0),if blind {"verification"}else{"review"},(attempt+1) as i64,now_ms(),response["id"].as_str().map(|v|v.chars().take(200).collect::<String>()),response["model"].as_str().map(|v|v.chars().take(200).collect::<String>()),response["usage"].to_string(),error.unwrap_or("").chars().take(400).collect::<String>(),serde_json::to_string(repairs)?,protocol::diagnostics(&response).to_string()])?;
        tx.execute(
            "UPDATE ai_review_jobs SET usage=?,updated_at=? WHERE id=?",
            params![usage.to_string(), now_ms(), id],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn run_job(&self, ctx: &Arc<DatasetContext>, id: &str) {
        let (lease, outcome) = match (self.inner.activity)(ActivityRole::Review) {
            Ok(lease) => {
                let outcome = self.run_inner(ctx, id);
                (Some(lease), outcome)
            }
            Err(error) => (None, Err(error)),
        };
        let _lease = lease;
        if let Err(error) = outcome {
            let message = if error.status == 409 {
                "Review stopped because its dataset, run, or source changed. Resume after checking the session.".into()
            } else if error.status >= 500 {
                format!("AI review stopped because of a local processing or storage error: {}. Resume to retry.",error.message)
            } else {
                error.message
            };
            if let Ok(conn) = ctx.connection() {
                let _=conn.execute("UPDATE ai_review_jobs SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('running','queued')",params![message.chars().take(400).collect::<String>(),now_ms(),id]);
            }
        }
        if let Ok(mut config) = self.inner.config.lock() {
            config.running.remove(&(ctx.id.clone(), id.into()));
        }
    }
    fn run_inner(&self, ctx: &Arc<DatasetContext>, id: &str) -> LabResult<()> {
        let job = {
            let _operation = ctx.lock_operation()?;
            let conn = ctx.connection()?;
            let job = Self::job(&conn, ctx, id)?;
            if !ACTIVE.contains(&job["state"].as_str().unwrap_or("")) {
                return Ok(());
            }
            conn.execute(
                "UPDATE ai_review_jobs SET state='running',error='' WHERE id=?",
                [id],
            )?;
            job
        };
        while self.still_running(ctx, id)? {
            let (index, items, saved) = {
                let _operation = ctx.lock_operation()?;
                let conn = ctx.connection()?;
                self.active_run(&conn, ctx, job["run_id"].as_str().unwrap())?;
                let first:Option<i64>=conn.query_row("SELECT batch_index FROM ai_review_items WHERE job_id=? AND state='pending' ORDER BY ordinal LIMIT 1",[id],|r|r.get(0)).optional()?;
                let Some(index) = first else {
                    conn.execute("UPDATE ai_review_jobs SET state='completed',updated_at=? WHERE id=? AND state='running'",params![now_ms(),id])?;
                    break;
                };
                let mut query=conn.prepare(&format!("SELECT i.*,{} AS crop,q.payload AS visual_evidence FROM ai_review_items i JOIN queue_items q ON q.queue_id=i.queue_id WHERE i.job_id=? AND i.batch_index=? ORDER BY i.ordinal",super::pixel_assets::expression(&conn,"q")?))?;
                let items = query
                    .query_map(params![id, index], item)?
                    .collect::<Result<Vec<_>, _>>()?;
                let saved:Option<(Option<Vec<u8>>,Option<String>,Option<String>)>=conn.query_row("SELECT grid,response,verification FROM ai_review_batches WHERE job_id=? AND batch_index=?",params![id,index],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                (index, items, saved)
            };
            let grid = match saved.as_ref().and_then(|s| s.0.clone()) {
                Some(grid) => grid,
                None => grid::build(&items, ctx.id == "gameplay-ai")?,
            };
            ctx.connection()?.execute(
                "INSERT INTO ai_review_batches(job_id,batch_index,grid) VALUES(?,?,?) ON CONFLICT(job_id,batch_index) DO UPDATE SET grid=COALESCE(ai_review_batches.grid,excluded.grid)",
                params![id, index, grid],
            )?;
            let mut reviewed: Value = saved
                .as_ref()
                .and_then(|s| s.1.as_ref())
                .map(|v| serde_json::from_str(v))
                .transpose()?
                .unwrap_or_else(|| json!({}));
            let missing_first: Vec<Item> = items
                .iter()
                .filter(|i| reviewed.get(i.ordinal.to_string()).is_none())
                .cloned()
                .collect();
            if !missing_first.is_empty() {
                let first_grid = grid::build(&missing_first, ctx.id == "gameplay-ai")?;
                let Some(readings) = self.call(
                    ctx,
                    id,
                    job["model"].as_str().unwrap(),
                    &first_grid,
                    &missing_first,
                    false,
                )?
                else {
                    break;
                };
                for (key, value) in readings
                    .as_object()
                    .ok_or_else(|| bad("Invalid saved readings"))?
                {
                    reviewed[key] = value.clone();
                }
                ctx.connection()?.execute(
                    "UPDATE ai_review_batches SET response=? WHERE job_id=? AND batch_index=?",
                    params![reviewed.to_string(), id, index],
                )?;
            }
            let mut verified: Value = saved
                .as_ref()
                .and_then(|s| s.2.as_ref())
                .map(|value| serde_json::from_str(value))
                .transpose()?
                .unwrap_or_else(|| json!({}));
            // Gameplay needs an independent reading even when the first pass matches
            // the captured label. Reuse any saved verification before requesting more.
            let missing: Vec<Item> = items
                .iter()
                .filter(|i| {
                    reviewed[i.ordinal.to_string()]["clarity"] != "uncertain"
                        && (ctx.id == "gameplay-ai"
                            || reviewed[i.ordinal.to_string()]["text"] != i.prior_label)
                        && verified.get(i.ordinal.to_string()).is_none()
                })
                .cloned()
                .collect();
            if !missing.is_empty() {
                let blind = grid::build(&missing, true)?;
                ctx.connection()?.execute(
                    "UPDATE ai_review_batches SET blind_grid=? WHERE job_id=? AND batch_index=?",
                    params![blind, id, index],
                )?;
                let Some(readings) = self.call(
                    ctx,
                    id,
                    job["model"].as_str().unwrap(),
                    &blind,
                    &missing,
                    true,
                )?
                else {
                    break;
                };
                if let (Some(target), Some(source)) =
                    (verified.as_object_mut(), readings.as_object())
                {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
                ctx.connection()?.execute(
                    "UPDATE ai_review_batches SET verification=? WHERE job_id=? AND batch_index=?",
                    params![verified.to_string(), id, index],
                )?;
            }
            self.apply_batch(ctx, &job, &items, &reviewed, &verified)?;
        }
        Ok(())
    }
    fn apply_batch(
        &self,
        ctx: &DatasetContext,
        job: &Value,
        items: &[Item],
        reviewed: &Value,
        verified: &Value,
    ) -> LabResult<()> {
        let _operation = ctx.lock_operation()?;
        let mut conn = ctx.connection()?;
        self.active_run(&conn, ctx, job["run_id"].as_str().unwrap())?;
        let tx = conn.transaction()?;
        let id = job["id"].as_str().unwrap();
        if !ACTIVE.contains(&Self::job(&tx, ctx, id)?["state"].as_str().unwrap_or("")) {
            return Ok(());
        }
        for item in items {
            let state: String = tx.query_row(
                "SELECT state FROM ai_review_items WHERE job_id=? AND ordinal=?",
                params![id, item.ordinal],
                |r| r.get(0),
            )?;
            if state != "pending" {
                continue;
            }
            let key = item.ordinal.to_string();
            let reading = &reviewed[&key];
            let verification = verified.get(&key);
            let first_response = reading.get("_response").unwrap_or(&reviewed["_response"]);
            let second_response = verification
                .and_then(|v| v.get("_response"))
                .unwrap_or(&verified["_response"]);
            let current = tx
                .query_row(
                    "SELECT * FROM queue_items WHERE queue_id=?",
                    [item.queue_id],
                    row_value,
                )
                .optional()?;
            let crop: Option<Vec<u8>> = tx
                .query_row(
                    &format!(
                        "SELECT {} FROM queue_items WHERE queue_id=?",
                        super::pixel_assets::expression(&tx, "queue_items")?
                    ),
                    [item.queue_id],
                    |r| r.get(0),
                )
                .optional()?;
            let event: i64 = tx.query_row(
                "SELECT COALESCE(MAX(id),0) FROM label_review_events WHERE sample_key=?",
                [&item.sample_key],
                |r| r.get(0),
            )?;
            let diagnostic_only =
                serde_json::from_str::<Value>(job["usage"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null)["diagnostic_only"]
                    == true;
            let mut conflict = current.as_ref().is_none_or(|c| {
                (!diagnostic_only
                    && (c["active"] != 1
                        || (c["reviewed"] != 1
                            && serde_json::from_str::<Value>(
                                job["usage"].as_str().unwrap_or("{}"),
                            )
                            .unwrap_or(Value::Null)["recover_from_job_id"]
                                .is_null())))
                    || c["discarded"] != 0
                    || c["sample_key"] != item.sample_key
                    || c["region_id"] != item.region_id
                    || c["pixel_sha256"] != item.pixel_sha256
                    || c["label"] != item.prior_label
                    || c["prediction_id"].as_str() != item.prior_prediction_id.as_deref()
                    || event != item.prior_event_id
            });
            if !conflict {
                conflict =
                    super::review::image_identity(crop.as_ref().unwrap())?.1 != item.pixel_sha256;
            }
            let text = reading["text"]
                .as_str()
                .ok_or_else(|| bad("Invalid saved AI transcription"))?;
            let mut state = "unchanged";
            let mut reason = reading["reason"].as_str().unwrap_or("").to_string();
            let mut prediction_id = None;
            let mut new_event = None;
            if conflict {
                state = "conflict";
                reason = "Source was edited, removed, or replaced after this review began.".into();
            } else if ctx.id == "gameplay-ai"
                && !super::gameplay::ai::evidence_cache::automatic_support(
                    &item.region_id,
                    &current
                        .as_ref()
                        .and_then(|c| c["payload"].as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or(Value::Null),
                )
            {
                state = "flagged";
                reason = "Card target support requires manual review".into();
            } else if ctx.id == "gameplay-ai"
                && super::gameplay::ai::evidence_cache::blank_contradicts_foreground(
                    &item.region_id,
                    &current
                        .as_ref()
                        .and_then(|c| c["payload"].as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or(Value::Null),
                    text,
                )
            {
                state = "flagged";
                reason =
                    "Blank reading contradicts supported card foreground; human review required"
                        .into();
            } else if diagnostic_only {
                state = "flagged";
                reason =
                    "Diagnostic evidence only; an operator must inspect and release this reading."
                        .into();
            } else if !crate::labels::category_for_region(&item.region_id).is_some_and(|category| {
                crate::labels::validate_text(category, text, reading["clarity"] == "blank")
            }) {
                state = "flagged";
                reason = "Reading is outside the current validation contract.".into();
            } else if reading["clarity"] == "uncertain" {
                state = "flagged";
            } else if ctx.id == "gameplay-ai"
                && !verification.is_some_and(|v| {
                    v["clarity"] != "uncertain"
                        && v["text"] == text
                        && v["clarity"] == reading["clarity"]
                })
            {
                state = "flagged";
                reason = "Independent reading disagreed or was uncertain.".into();
            } else if text != item.prior_label {
                let agreed = verification.is_some_and(|v| {
                    v["clarity"] != "uncertain"
                        && v["text"] == text
                        && v["clarity"] == reading["clarity"]
                });
                let valid = crate::labels::category_for_region(&item.region_id)
                    .is_some_and(|category| crate::labels::validate_text(category, text, true));
                if !agreed {
                    state = "flagged";
                    reason = "Independent reading disagreed or was uncertain.".into();
                } else if !valid {
                    state = "flagged";
                    reason = "Verified text is outside the automatic validation contract.".into();
                } else if job["auto_correct"] != 1 && job["auto_correct"] != true {
                    state = "flagged";
                    reason = "Verified correction; automatic correction is disabled.".into();
                } else {
                    let input = super::review::SampleInput {
                        key: item.sample_key.clone(),
                        region_id: item.region_id.clone(),
                        png: crop.unwrap(),
                        filename: None,
                    };
                    let (image_hash, pixel_hash) = super::review::image_identity(&input.png)?;
                    // Seed pre-existing queue truth before the append-only accepted event.
                    tx.execute("INSERT OR IGNORE INTO review_samples(sample_key,region_id,pixel_sha256,image_sha256,filename,label,crop) VALUES(?,?,?,?,NULL,?,?)",params![input.key,input.region_id,pixel_hash,image_hash,item.prior_label,input.png])?;
                    tx.execute(
                        "UPDATE review_samples SET label=? WHERE sample_key=?",
                        params![item.prior_label, item.sample_key],
                    )?;
                    let payload = json!({"text":text,"raw_text":reading["raw_text"].as_str().unwrap_or(text),"schema_valid":true,"category":crate::labels::category_for_region(&item.region_id),"review_provider":"openai","model_version":verified["_response"]["model"].as_str().unwrap_or(job["model"].as_str().unwrap()),"model":job["model"],"first_response":first_response,"verification_response":second_response,"ai_review_job_id":id,"independent_visual_agreement":true,"visually_verified":false,"validation_contract":{"version":crate::labels::contract_version(),"sha256":super::sha256(crate::labels::CONTRACT_BYTES)},"pixel_sha256":pixel_hash,"image_sha256":image_hash});
                    let prediction = super::review::prediction_conn(&tx, ctx, &input, payload)?;
                    let prediction_key = prediction["id"]
                        .as_str()
                        .ok_or_else(|| bad("Stored prediction identity missing"))?
                        .to_string();
                    let event = super::review::review_conn(
                        &tx,
                        ctx,
                        &input,
                        text,
                        "accepted",
                        Some(&prediction_key),
                        false,
                    )?;
                    new_event = event["id"].as_i64();
                    prediction_id = Some(prediction_key);
                    tx.execute("UPDATE queue_items SET label=?,reviewed=1,discarded=0,prediction_id=? WHERE queue_id=?",params![text,prediction_id,item.queue_id])?;
                    tx.execute("INSERT INTO queue_meta(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
                    state = "corrected";
                }
            }
            let label = if state == "corrected" {
                text
            } else {
                current
                    .as_ref()
                    .and_then(|c| c["label"].as_str())
                    .unwrap_or(&item.prior_label)
            };
            let result = json!({"sample_key":item.sample_key,"queue_id":item.queue_id,"region_id":item.region_id,"prior_label":item.prior_label,"label":label,"proposed_label":text,"state":state,"outcome":state,"reason":reason.chars().take(1000).collect::<String>(),"prediction_id":prediction_id,"event_id":new_event,"original_prediction_id":item.prior_prediction_id,"pixel_sha256":item.pixel_sha256,"ordinal":item.ordinal,"batch_index":item.batch_index,"visually_verified":false,"first_reading":reading,"verification":verification,"first_response":first_response,"verification_response":second_response});
            tx.execute("UPDATE ai_review_items SET state=?,result=? WHERE job_id=? AND ordinal=? AND state='pending'",params![state,result.to_string(),id,item.ordinal])?;
        }
        tx.execute(
            "UPDATE ai_review_jobs SET updated_at=? WHERE id=?",
            params![now_ms(), id],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};
    use std::{
        io::Cursor,
        sync::atomic::{AtomicUsize, Ordering},
    };
    struct Fixture {
        _root: tempfile::TempDir,
        ctx: Arc<DatasetContext>,
        manager: AiReviewManager,
        calls: Arc<AtomicUsize>,
    }
    impl Fixture {
        fn new(reading: &str, clarity: &str) -> Self {
            let root = tempfile::tempdir().unwrap();
            let registry = Arc::new(DatasetRegistry::new(root.path().join("datasets")).unwrap());
            let ctx = registry.resolve("legacy").unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let text = reading.to_owned();
            let clarity = clarity.to_owned();
            let transport = Arc::new(move |_payload: Value, _key: &str| {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(
                    json!({"status":"completed","id":"response-fixture","model":"fixture-resolved","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"output_text":json!({"items":[{"id":"0","text":text,"clarity":clarity,"reason":"Pixel reading"}]}).to_string()}),
                )
            });
            let manager = AiReviewManager::with_transport(registry, transport, false);
            manager.ensure(&ctx).unwrap();
            manager
                .configure(&json!({"api_key":"fixture-key"}))
                .unwrap();
            Self {
                _root: root,
                ctx,
                manager,
                calls,
            }
        }
        fn queue(&self, prior: &str) {
            let mut png = Cursor::new(Vec::new());
            DynamicImage::new_rgb8(30, 10)
                .write_to(&mut png, ImageFormat::Png)
                .unwrap();
            let png = png.into_inner();
            let pixel = super::super::review::image_identity(&png).unwrap().1;
            let conn = self.ctx.connection().unwrap();
            conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at,reviewed,label) VALUES('sample','seats[0].name','{}',?,?,0,1,?)",params![png,pixel,prior]).unwrap();
            let ceiling = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO queue_meta(key,value) VALUES('active_stream','\"run\"')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO queue_meta(key,value) VALUES('stream:run',?)",
                [
                    json!({"id":"run","dataset_id":"legacy","state":"active","ceiling":ceiling})
                        .to_string(),
                ],
            )
            .unwrap();
            drop(conn);
        }
        fn seed(&self, prior: &str) -> String {
            self.queue(prior);
            let job = self
                .manager
                .start(&self.ctx, &json!({"run_id":"run"}))
                .unwrap();
            job["id"].as_str().unwrap().into()
        }
    }
    #[test]
    fn failed_activity_protection_starts_no_job_and_spends_no_request() {
        let mut f = Fixture::new("ace", "clear");
        f.queue("ace");
        Arc::get_mut(&mut f.manager.inner).unwrap().activity =
            |_| Err(bad("Fixture launcher rejected activity"));
        assert!(f.manager.start(&f.ctx, &json!({"run_id":"run"})).is_err());
        assert_eq!(
            f.ctx
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn worker_activity_failure_records_terminal_error_without_calling_provider() {
        let mut f = Fixture::new("ace", "clear");
        let id = f.seed("ace");
        Arc::get_mut(&mut f.manager.inner).unwrap().activity =
            |_| Err(bad("Fixture activity timed out"));
        f.manager.run_job(&f.ctx, &id);
        assert_eq!(
            f.manager.status(&f.ctx, Some(&id), None).unwrap()["state"],
            "failed"
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn source_guided_ellipsis_preserves_display_string_without_inferring_hidden_identity() {
        for name in ["maxhamme...", "codywilson…"] {
            assert!(crate::labels::validate_text("name", name, false));
            let f = Fixture::new(name, "clear");
            let canonical = crate::labels::normalize_text("name", name);
            let id = f.seed(&canonical);
            f.ctx
                .connection()
                .unwrap()
                .execute(
                    "UPDATE queue_items SET payload=?",
                    [json!({"guide":{"family":"name"}}).to_string()],
                )
                .unwrap();
            f.manager.run_job(&f.ctx, &id);
            let state: String = f
                .ctx
                .connection()
                .unwrap()
                .query_row(
                    "SELECT state FROM ai_review_items WHERE job_id=?",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(state, "unchanged");
            let result: String = f
                .ctx
                .connection()
                .unwrap()
                .query_row(
                    "SELECT result FROM ai_review_items WHERE job_id=?",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            let result: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(result["first_reading"]["text"], canonical);
            assert_eq!(result["first_reading"]["clarity"], "clear");
            assert_eq!(result["label"], canonical);
            assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        }
        let f = Fixture::new("Alice.Smith", "clear");
        let id = f.seed("Alice.Smith");
        f.ctx
            .connection()
            .unwrap()
            .execute(
                "UPDATE queue_items SET payload=?",
                [json!({"guide":{"family":"name"}}).to_string()],
            )
            .unwrap();
        f.manager.run_job(&f.ctx, &id);
        let state: String = f
            .ctx
            .connection()
            .unwrap()
            .query_row(
                "SELECT state FROM ai_review_items WHERE job_id=?",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "unchanged");
    }
    #[test]
    fn old_attempt_audit_table_migrates_before_resume_and_preserves_history() {
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("Alice");
        f.manager.cancel(&f.ctx, &id).unwrap();
        {
            let conn = f.ctx.connection().unwrap();
            conn.execute_batch("DROP TABLE ai_review_attempts; CREATE TABLE ai_review_attempts(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,batch_index INTEGER NOT NULL,phase TEXT NOT NULL,attempt INTEGER NOT NULL,created_at INTEGER NOT NULL,response_id TEXT,model TEXT,usage TEXT NOT NULL,error TEXT NOT NULL);").unwrap();
            conn.execute("INSERT INTO ai_review_attempts(job_id,batch_index,phase,attempt,created_at,usage,error) VALUES(?,0,'review',1,0,'{}','historical failure')",[&id]).unwrap();
        }
        let restarted = AiReviewManager::with_transport(
            f.manager.inner.registry.clone(),
            f.manager.inner.transport.clone(),
            false,
        );
        restarted.ensure(&f.ctx).unwrap();
        restarted.ensure(&f.ctx).unwrap();
        restarted.configure(&json!({"api_key":"key"})).unwrap();
        restarted.resume(&f.ctx, &id).unwrap();
        restarted.run_job(&f.ctx, &id);
        assert_eq!(
            restarted.status(&f.ctx, Some(&id), None).unwrap()["state"],
            "completed"
        );
        let conn = f.ctx.connection().unwrap();
        let attempts = rows(
            &conn,
            "SELECT repairs,diagnostics,error FROM ai_review_attempts WHERE job_id=? ORDER BY id",
            [&id],
        )
        .unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0]["error"], "historical failure");
        assert_eq!(attempts[0]["repairs"], "[]");
        assert_eq!(attempts[0]["diagnostics"], "{}");
        assert_eq!(attempts[1]["error"], "");
        assert_ne!(attempts[1]["diagnostics"], "{}");
    }
    #[test]
    fn internal_audit_error_is_not_reported_as_changed_source() {
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("Alice");
        f.ctx.connection().unwrap().execute_batch("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON ai_review_attempts BEGIN SELECT RAISE(ABORT,'fixture audit storage failure'); END;").unwrap();
        f.manager.run_job(&f.ctx, &id);
        let job = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["state"], "failed");
        assert!(job["error"]
            .as_str()
            .unwrap()
            .contains("fixture audit storage failure"));
        assert!(!job["error"].as_str().unwrap().contains("source changed"));
        assert_eq!(job["checked"], 0);
    }
    #[test]
    fn malformed_transcription_retries_with_feedback_and_audits_all_usage() {
        let f = Fixture::new("Alice", "clear");
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let transport = Arc::new(move |payload: Value, _: &str| {
            let attempt = counter.fetch_add(1, Ordering::SeqCst);
            if attempt > 0 {
                assert!(payload["input"][0]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("clear crops must have nonempty text"));
            }
            Ok(
                json!({"id":format!("attempt-{attempt}"),"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"output_text":json!({"items":[{"id":"0","text":if attempt==0 {""}else{"Alice"},"clarity":"clear","reason":"Pixels"}]}).to_string()}),
            )
        });
        let manager =
            AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
        manager.ensure(&f.ctx).unwrap();
        manager.configure(&json!({"api_key":"key"})).unwrap();
        let id = f.seed("Alice");
        manager.run_job(&f.ctx, &id);
        let job = manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["state"], "completed");
        assert_eq!(job["checked"], 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(job["usage"]["requests"], 2);
        assert_eq!(job["usage"]["total_tokens"], 10);
        let conn = f.ctx.connection().unwrap();
        let attempts = rows(
            &conn,
            "SELECT * FROM ai_review_attempts WHERE job_id=? ORDER BY id",
            [&id],
        )
        .unwrap();
        assert_eq!(attempts.len(), 2);
        assert!(attempts[0]["error"]
            .as_str()
            .unwrap()
            .contains("nonempty text"));
        assert_eq!(attempts[1]["error"], "");
        assert!(!attempts[0]["diagnostics"]
            .as_str()
            .unwrap()
            .contains("Alice"));
    }
    #[test]
    fn malformed_transcription_exhaustion_preserves_labels_and_partial_batch() {
        let f = Fixture::new("", "clear");
        let id = f.seed("Alice");
        f.manager.run_job(&f.ctx, &id);
        let job = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["state"], "failed");
        assert_eq!(job["checked"], 0);
        assert_eq!(job["usage"]["requests"], 3);
        assert_eq!(f.calls.load(Ordering::SeqCst), 3);
        let conn = f.ctx.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT label FROM queue_items", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Alice"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM label_review_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM ai_review_batches WHERE response IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn repairs_only_unambiguous_format_without_another_provider_request() {
        for form in ["fence", "envelope", "array"] {
            let f = Fixture::new("Alice", "clear");
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let text =
                json!({"items":[{"id":"0","text":"Alice","clarity":"clear","reason":"Pixels"}]});
            let output = match form {
                "fence" => format!("```json\n{text}\n```"),
                "envelope" => json!({"result":text}).to_string(),
                _ => text["items"].to_string(),
            };
            let transport = Arc::new(move |_: Value, _: &str| {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"output_text":output}))
            });
            let manager =
                AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
            manager.ensure(&f.ctx).unwrap();
            manager.configure(&json!({"api_key":"key"})).unwrap();
            let id = f.seed("Alice");
            manager.run_job(&f.ctx, &id);
            assert_eq!(
                manager.status(&f.ctx, Some(&id), None).unwrap()["state"],
                "completed"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let repairs: String = f
                .ctx
                .connection()
                .unwrap()
                .query_row("SELECT repairs FROM ai_review_attempts", [], |r| r.get(0))
                .unwrap();
            assert_ne!(repairs, "[]");
        }
    }
    #[test]
    fn authentication_and_refusal_fail_without_automatic_retry() {
        for refusal in [false, true] {
            let f = Fixture::new("Alice", "clear");
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let transport = Arc::new(move |_: Value, _: &str| {
                counter.fetch_add(1, Ordering::SeqCst);
                if refusal {
                    Ok(json!({"output":[{"content":[{"type":"refusal"}]}]}))
                } else {
                    Err(bad("OpenAI rejected the API key or model access."))
                }
            });
            let manager =
                AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
            manager.ensure(&f.ctx).unwrap();
            manager.configure(&json!({"api_key":"key"})).unwrap();
            let id = f.seed("Alice");
            manager.run_job(&f.ctx, &id);
            assert_eq!(
                manager.status(&f.ctx, Some(&id), None).unwrap()["state"],
                "failed"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
    #[test]
    fn explicit_start_snapshot_and_independent_correction_are_audited() {
        let f = Fixture::new("Alice", "clear");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        let id = f.seed("A1ice");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        f.manager.run_job(&f.ctx, &id);
        let status = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(status["state"], "completed");
        assert_eq!(status["corrected"], 1);
        assert_eq!(status["usage"]["requests"], 2);
        assert_eq!(status["usage"]["total_tokens"], 10);
        assert_eq!(status["visually_verified"], false);
        let conn = f.ctx.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT label FROM queue_items", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Alice"
        );
        assert_eq!(
            conn.query_row("SELECT prior_label FROM label_review_events", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "A1ice"
        );
        let payload: String = conn
            .query_row("SELECT payload FROM model_predictions", [], |r| r.get(0))
            .unwrap();
        assert!(!payload.contains("fixture-key"));
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["independent_visual_agreement"], true);
        assert_eq!(payload["model_version"], "fixture-resolved");
        assert_eq!(payload["visually_verified"], false);
        assert!(conn
            .execute("UPDATE label_review_events SET label='bad'", [])
            .is_err());
    }
    #[test]
    fn uncertain_reading_never_corrects() {
        let f = Fixture::new("A1ice", "uncertain");
        let id = f.seed("Alice");
        f.manager.run_job(&f.ctx, &id);
        let status = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(status["flagged"], 1);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert_eq!(status["recent"][0]["label"], "Alice");
    }
    #[test]
    fn concurrent_label_or_pixels_changes_conflict() {
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("A1ice");
        f.ctx
            .connection()
            .unwrap()
            .execute("UPDATE queue_items SET label='Edited'", [])
            .unwrap();
        f.manager.run_job(&f.ctx, &id);
        let status = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(status["conflicts"], 1);
        assert_eq!(status["corrected"], 0);
        assert_eq!(status["recent"][0]["label"], "Edited");
    }
    #[test]
    fn restart_requires_explicit_resume_and_cancel_blocks_calls() {
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("Alice");
        let restarted = AiReviewManager::with_transport(
            f.manager.inner.registry.clone(),
            f.manager.inner.transport.clone(),
            false,
        );
        let status = restarted.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(status["state"], "interrupted");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        assert!(restarted.resume(&f.ctx, &id).is_err());
        restarted
            .configure(&json!({"api_key":"fixture-key"}))
            .unwrap();
        restarted.resume(&f.ctx, &id).unwrap();
        restarted.cancel(&f.ctx, &id).unwrap();
        restarted.run_job(&f.ctx, &id);
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            restarted.status(&f.ctx, Some(&id), None).unwrap()["state"],
            "cancelled"
        );
    }
    #[test]
    fn response_exact_ids_and_schema_are_required() {
        let item = Item {
            job_id: "job".into(),
            ordinal: 7,
            batch_index: 0,
            queue_id: 1,
            sample_key: "sample".into(),
            region_id: "pot".into(),
            group_name: "pot".into(),
            prior_label: "".into(),
            prior_prediction_id: None,
            pixel_sha256: "hash".into(),
            prior_event_id: 0,
            crop: vec![],
            guide: Value::Null,
        };
        let response = |items: Value| json!({"output_text":json!({"items":items}).to_string()});
        assert!(protocol::parse(&response(json!([])), std::slice::from_ref(&item)).is_err());
        assert!(protocol::parse(
            &response(json!([{"id":"7","text":"","clarity":"clear","reason":""}])),
            std::slice::from_ref(&item)
        )
        .is_err());
        assert!(protocol::parse(
            &response(json!([{"id":"7","text":" ","clarity":"clear","reason":""}])),
            std::slice::from_ref(&item)
        )
        .is_err());
        let valid = json!({"id":"7","text":"","clarity":"blank","reason":"Visibly blank"});
        assert!(protocol::parse(
            &response(json!([valid, valid])),
            std::slice::from_ref(&item)
        )
        .is_err());
        assert!(protocol::parse(&response(json!([valid])), std::slice::from_ref(&item)).is_ok());
        for malformed in [
            json!({"items":[{"id":"other","text":"Away","clarity":"clear","reason":"Pixels"}]}),
            json!({"items":[{"id":"7","text":123,"clarity":"clear","reason":"Pixels"}]}),
            json!({"items":[{"id":"7","text":"Away","clarity":"blank","reason":"Pixels"}]}),
        ] {
            let wrapped = json!({"output_text":format!("```json\n{malformed}\n```")});
            let (repaired, _) = protocol::repair_format(&wrapped);
            assert!(protocol::parse(&repaired, std::slice::from_ref(&item)).is_err());
        }
        let exact =
            json!({"items":[{"id":"7","text":" Away ","clarity":"clear","reason":"Pixels"}]});
        let (repaired, _) =
            protocol::repair_format(&json!({"output_text":format!("```json\n{exact}\n```")}));
        let normalized = protocol::parse(&repaired, &[item]).unwrap();
        assert_eq!(normalized["7"]["text"], "Away");
        assert_eq!(normalized["7"]["raw_text"], " Away ");
    }
    #[test]
    fn key_is_not_exposed_in_responses_or_job_records_and_invalid_configuration_fails() {
        let f = Fixture::new("Alice", "clear");
        assert!(f.manager.configure(&json!({"api_key":"bad key"})).is_err());
        assert!(f.manager.configure(&json!({"model":"../model"})).is_err());
        let original = f.manager.inner.config.lock().unwrap().key.clone();
        assert!(f
            .manager
            .configure(&json!({"api_key":"replacement-fixture-key","model":"../invalid"}))
            .is_err());
        assert_eq!(f.manager.inner.config.lock().unwrap().key, original);
        assert!(!f
            .manager
            .config()
            .unwrap()
            .to_string()
            .contains("fixture-key"));
        let _ = f.seed("Alice");
        let conn = f.ctx.connection().unwrap();
        let job: String = conn
            .query_row("SELECT model||usage||error FROM ai_review_jobs", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!job.contains("fixture-key"));
    }
    #[test]
    fn snapshot_includes_reviewed_blanks_and_excludes_discarded_pending_and_later_captures() {
        let f = Fixture::new("Alice", "clear");
        let first = f.seed("Alice");
        f.manager.cancel(&f.ctx, &first).unwrap();
        {
            let conn = f.ctx.connection().unwrap();
            for (key, label, reviewed, discarded) in [
                ("blank", "", 1, 0),
                ("discarded", "Alice", 1, 1),
                ("pending", "Alice", 0, 0),
                ("later", "Alice", 1, 0),
            ] {
                conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at,reviewed,discarded,label) SELECT ?,'seats[0].name','{}',crop,pixel_sha256,0,?,?,? FROM queue_items WHERE sample_key='sample'",params![key,reviewed,discarded,label]).unwrap();
            }
            conn.execute(
                "UPDATE queue_meta SET value=? WHERE key='stream:run'",
                [json!({"dataset_id":"legacy","state":"active","ceiling":4}).to_string()],
            )
            .unwrap();
        }
        let job = f.manager.start(&f.ctx, &json!({"run_id":"run"})).unwrap();
        assert_eq!(job["total"], 2);
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        let conn = f.ctx.connection().unwrap();
        let labels: Vec<String> = conn
            .prepare("SELECT prior_label FROM ai_review_items WHERE job_id=? ORDER BY ordinal")
            .unwrap()
            .query_map([job["id"].as_str().unwrap()], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(labels, vec!["Alice", ""]);
    }
    #[test]
    fn pixel_and_append_only_event_conflicts_prevent_corrections() {
        for change_pixels in [false, true] {
            let f = Fixture::new("Alice", "clear");
            let id = f.seed("A1ice");
            {
                let conn = f.ctx.connection().unwrap();
                if change_pixels {
                    let mut png = Cursor::new(Vec::new());
                    DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                        30,
                        10,
                        image::Rgb([255, 0, 0]),
                    ))
                    .write_to(&mut png, ImageFormat::Png)
                    .unwrap();
                    conn.execute("UPDATE queue_items SET crop=?", [png.into_inner()])
                        .unwrap();
                } else {
                    conn.execute("INSERT INTO label_review_events(sample_key,prior_label,label,action,pixel_sha256,dataset_id,created_at) SELECT sample_key,label,label,'manual',pixel_sha256,'legacy',0 FROM queue_items",[]).unwrap();
                }
            }
            f.manager.run_job(&f.ctx, &id);
            let job = f.manager.status(&f.ctx, Some(&id), None).unwrap();
            assert_eq!(job["conflicts"], 1);
            assert_eq!(job["corrected"], 0);
        }
    }
    #[test]
    fn cancelled_inflight_response_cannot_apply_labels() {
        let f = Fixture::new("Alice", "clear");
        let ctx = f.ctx.clone();
        let transport = Arc::new(move |_: Value, _: &str| {
            ctx.connection()?.execute(
                "UPDATE ai_review_jobs SET state='cancelled' WHERE state='running'",
                [],
            )?;
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"Alice","clarity":"clear","reason":"Pixels"}]}).to_string()}),
            )
        });
        let manager =
            AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
        manager.ensure(&f.ctx).unwrap();
        manager.configure(&json!({"api_key":"key"})).unwrap();
        let id = f.seed("A1ice");
        manager.run_job(&f.ctx, &id);
        let job = manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["state"], "cancelled");
        assert_eq!(job["checked"], 0);
        assert_eq!(job["corrected"], 0);
        assert_eq!(
            f.ctx
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM label_review_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn saved_first_reading_is_reused_on_explicit_resume() {
        let f = Fixture::new("Alice", "clear");
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let transport = Arc::new(move |_: Value, _: &str| {
            let request = calls.fetch_add(1, Ordering::SeqCst);
            if request == 1 {
                return Err(bad("Fixture transport interrupted"));
            }
            Ok(
                json!({"id":format!("response-{request}"),"model":"fixture","output_text":json!({"items":[{"id":"0","text":"Alice","clarity":"clear","reason":"Pixels"}]}).to_string()}),
            )
        });
        let manager =
            AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
        manager.ensure(&f.ctx).unwrap();
        manager.configure(&json!({"api_key":"key"})).unwrap();
        let id = f.seed("A1ice");
        manager.run_job(&f.ctx, &id);
        assert_eq!(
            manager.status(&f.ctx, Some(&id), None).unwrap()["state"],
            "failed"
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        manager.resume(&f.ctx, &id).unwrap();
        manager.run_job(&f.ctx, &id);
        let job = manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["state"], "completed");
        assert_eq!(job["corrected"], 1);
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert_eq!(job["usage"]["requests"], 3);
        assert_eq!(job["recent"][0]["first_response"]["id"], "response-0");
        assert_eq!(
            job["recent"][0]["verification_response"]["id"],
            "response-2"
        );
    }
    #[test]
    fn changed_run_or_archive_revokes_job_before_requests() {
        for archive in [false, true] {
            let f = Fixture::new("Alice", "clear");
            let id = f.seed("A1ice");
            if archive {
                f.manager
                    .inner
                    .registry
                    .update("legacy", &json!({"archived":true}))
                    .unwrap();
            } else {
                f.ctx
                    .connection()
                    .unwrap()
                    .execute(
                        "UPDATE queue_meta SET value='\"other\"' WHERE key='active_stream'",
                        [],
                    )
                    .unwrap();
            }
            f.manager.run_job(&f.ctx, &id);
            assert_eq!(f.calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                f.manager.status(&f.ctx, Some(&id), None).unwrap()["state"],
                "failed"
            );
        }
    }
    #[test]
    fn independent_correction_is_flagged_when_automatic_changes_are_disabled() {
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("A1ice");
        f.ctx
            .connection()
            .unwrap()
            .execute("UPDATE ai_review_jobs SET auto_correct=0 WHERE id=?", [&id])
            .unwrap();
        f.manager.run_job(&f.ctx, &id);
        let job = f.manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["flagged"], 1);
        assert_eq!(job["corrected"], 0);
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
        assert_eq!(job["recent"][0]["label"], "A1ice");
    }
    #[test]
    fn at_most_two_jobs_and_one_per_dataset_run_concurrently() {
        use std::sync::{mpsc, Condvar};
        use std::time::{Duration, Instant};
        let f = Fixture::new("Alice", "clear");
        let old = f.seed("Alice");
        f.manager.cancel(&f.ctx, &old).unwrap();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = gate.clone();
        let (sender, entered) = mpsc::channel();
        let transport = Arc::new(move |_: Value, _: &str| {
            sender.send(()).unwrap();
            let (lock, condition) = &*worker_gate;
            let released = lock.lock().unwrap();
            let _ = condition
                .wait_timeout_while(released, Duration::from_secs(3), |released| !*released)
                .unwrap();
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"Alice","clarity":"clear","reason":"Pixels"}]}).to_string()}),
            )
        });
        let manager =
            AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, true);
        manager.configure(&json!({"api_key":"key"})).unwrap();
        manager.ensure(&f.ctx).unwrap();
        let mut contexts = vec![f.ctx.clone()];
        for _ in 0..2 {
            let row = manager.inner.registry.create("Fixture").unwrap();
            let ctx = manager
                .inner
                .registry
                .resolve(row["id"].as_str().unwrap())
                .unwrap();
            manager.ensure(&ctx).unwrap();
            let png: Vec<u8> = f
                .ctx
                .connection()
                .unwrap()
                .query_row("SELECT crop FROM queue_items", [], |r| r.get(0))
                .unwrap();
            let pixels = super::super::review::image_identity(&png).unwrap().1;
            {
                let conn = ctx.connection().unwrap();
                conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at,reviewed,label) VALUES('sample','seats[0].name','{}',?,?,0,1,'Alice')",params![png,pixels]).unwrap();
                conn.execute(
                    "INSERT INTO queue_meta(key,value) VALUES('active_stream','\"run\"')",
                    [],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO queue_meta(key,value) VALUES('stream:run',?)",
                    [json!({"dataset_id":ctx.id,"state":"active","ceiling":1}).to_string()],
                )
                .unwrap();
            }
            contexts.push(ctx);
        }
        let first = manager
            .start(&contexts[0], &json!({"run_id":"run"}))
            .unwrap();
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = manager
            .start(&contexts[1], &json!({"run_id":"run"}))
            .unwrap();
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            manager
                .start(&contexts[2], &json!({"run_id":"run"}))
                .unwrap_err()
                .status,
            409
        );
        assert!(manager
            .start(&contexts[0], &json!({"run_id":"run"}))
            .unwrap_err()
            .message
            .contains("this dataset"));
        manager
            .cancel(&contexts[0], first["id"].as_str().unwrap())
            .unwrap();
        manager
            .cancel(&contexts[1], second["id"].as_str().unwrap())
            .unwrap();
        {
            let (lock, condition) = &*gate;
            *lock.lock().unwrap() = true;
            condition.notify_all();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !manager.inner.config.lock().unwrap().running.is_empty() && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(manager.inner.config.lock().unwrap().running.is_empty());
    }
    #[test]
    fn background_snapshot_waits_for_dataset_operation_before_spending() {
        use std::{sync::mpsc, time::Duration};
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("A1ice");
        let operation = f.ctx.lock_operation().unwrap();
        let manager = f.manager.clone();
        let ctx = f.ctx.clone();
        let worker_id = id.clone();
        let (entered, waiting) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            manager.run_job(&ctx, &worker_id);
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        assert!(!worker.is_finished());
        drop(operation);
        worker.join().unwrap();
        assert_eq!(
            f.manager.status(&f.ctx, Some(&id), None).unwrap()["corrected"],
            1
        );
    }
    #[test]
    fn cancelled_call_waiting_for_dataset_operation_does_not_spend() {
        use std::{sync::mpsc, time::Duration};
        let f = Fixture::new("Alice", "clear");
        let id = f.seed("A1ice");
        let operation = f.ctx.lock_operation().unwrap();
        let manager = f.manager.clone();
        let ctx = f.ctx.clone();
        let worker_id = id.clone();
        let (entered, waiting) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            manager.call(&ctx, &worker_id, "fixture", &[], &[], false)
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        assert!(!worker.is_finished());
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        f.manager.cancel(&f.ctx, &id).unwrap();
        drop(operation);
        assert!(worker.join().unwrap().unwrap().is_none());
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn background_application_waits_for_dataset_edit_and_detects_its_conflict() {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let f = Fixture::new("Alice", "clear");
        let (verification_ready, waiting) = mpsc::channel();
        let (release_response, receive) = mpsc::channel();
        let receive = Mutex::new(receive);
        let calls = AtomicUsize::new(0);
        let transport = Arc::new(move |_: Value, _: &str| {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                verification_ready.send(()).unwrap();
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
            }
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"Alice","clarity":"clear","reason":"Pixels"}]}).to_string()}),
            )
        });
        let manager =
            AiReviewManager::with_transport(f.manager.inner.registry.clone(), transport, false);
        manager.ensure(&f.ctx).unwrap();
        manager.configure(&json!({"api_key":"key"})).unwrap();
        let id = f.seed("A1ice");
        let runner = manager.clone();
        let ctx = f.ctx.clone();
        let worker_id = id.clone();
        let worker = std::thread::spawn(move || runner.run_job(&ctx, &worker_id));
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let operation = f.ctx.lock_operation().unwrap();
        release_response.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let saved: bool = f
                .ctx
                .connection()
                .unwrap()
                .query_row(
                    "SELECT verification IS NOT NULL FROM ai_review_batches WHERE job_id=?",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            if saved {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(!worker.is_finished());
        assert_eq!(
            f.ctx
                .connection()
                .unwrap()
                .query_row(
                    "SELECT state FROM ai_review_items WHERE job_id=?",
                    [&id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "pending"
        );
        f.ctx
            .connection()
            .unwrap()
            .execute(
                "UPDATE queue_items SET label='Edited' WHERE sample_key='sample'",
                [],
            )
            .unwrap();
        drop(operation);
        worker.join().unwrap();
        let job = manager.status(&f.ctx, Some(&id), None).unwrap();
        assert_eq!(job["conflicts"], 1);
        assert_eq!(job["corrected"], 0);
        assert_eq!(job["recent"][0]["label"], "Edited");
    }
    #[test]
    #[ignore = "requires private confirmed failure pixels and raw paid observations"]
    fn offline_visible_diamond_raw_pair_recovery_flags_without_provider() {
        use super::super::gameplay::ai::{evidence_cache as cache, quarantine};
        let path = std::path::PathBuf::from(
            std::env::var_os("POKER_BLANK_FAILURE").expect("set POKER_BLANK_FAILURE"),
        );
        let failure: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let crop = std::fs::read(path.parent().unwrap().join("failure-crop.png")).unwrap();
        assert_eq!(
            super::super::review::image_identity(&crop).unwrap().1,
            failure["pixel_sha256"]
        );
        let rgb = image::load_from_memory(&crop).unwrap().to_rgb8();
        let guide = &failure["payload"]["guide"];
        assert_eq!(guide["crop_width"], rgb.width());
        assert_eq!(guide["crop_height"], rgb.height());
        let ax = guide["anchor"]["x"].as_f64().unwrap();
        let ay = guide["anchor"]["y"].as_f64().unwrap();
        assert!((ax - f64::from(rgb.width()) / 2.).abs() < 1e-6);
        assert!((ay - f64::from(rgb.height()) / 2.).abs() < 1e-6);
        assert_eq!(
            rgb.get_pixel(ax.floor() as u32, ay.floor() as u32).0,
            [255, 255, 255]
        );
        let mut f = Fixture::new("", "blank");
        let database: String = f
            .ctx
            .connection()
            .unwrap()
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        f.ctx = Arc::new(DatasetContext {
            id: "gameplay-ai".into(),
            directory: f.ctx.directory.clone(),
            db: Mutex::new(Connection::open(database).unwrap()),
            operation: Mutex::new(()),
            state: Mutex::new(json!({})),
            _archive_snapshot: None,
        });
        f.queue("");
        {
            let conn = f.ctx.connection().unwrap();
            conn.execute("UPDATE queue_meta SET value=json_set(value,'$.dataset_id','gameplay-ai') WHERE key='stream:run'",[]).unwrap();
            conn.execute(
                "UPDATE queue_items SET sample_key=?,region_id=?,pixel_sha256=?,crop=?,payload=?",
                params![
                    failure["sample_key"].as_str(),
                    failure["region_id"].as_str(),
                    failure["pixel_sha256"].as_str(),
                    crop,
                    failure["payload"].to_string()
                ],
            )
            .unwrap();
        }
        let target = f
            .manager
            .start(&f.ctx, &json!({"run_id":"run","max_requests":1}))
            .unwrap();
        let id = target["id"].as_str().unwrap();
        let source = failure["job_id"].as_str().unwrap();
        {
            let conn = f.ctx.connection().unwrap();
            conn.execute_batch("CREATE TABLE gameplay_ai_runs(run_id TEXT,job_id TEXT,profile_id TEXT,session_id TEXT,scope TEXT); CREATE TABLE gameplay_ai_job_quarantines(job_id TEXT PRIMARY KEY);
CREATE TABLE gameplay_ai_decisions(id INTEGER,occurrence_id TEXT,sample_key TEXT,label TEXT,state TEXT);
CREATE TABLE gameplay_ai_manual(sample_key TEXT,label TEXT,state TEXT);
CREATE TABLE gameplay_ai_cache_aliases(sample_key TEXT PRIMARY KEY,family TEXT,pixel_sha256 TEXT,cache_key TEXT);").unwrap();
            let scope = json!({"validation_sha256":super::super::sha256(crate::labels::CONTRACT_BYTES),"review_policy":cache::REVIEW_POLICY});
            conn.execute(
                "INSERT INTO gameplay_ai_runs VALUES('run',?,'same-profile','same-session',?)",
                params![id, scope.to_string()],
            )
            .unwrap();
            let mut old_scope = scope.clone();
            old_scope["review_policy"] = json!("card_support_seat_occupancy_raw_recovery_v2");
            conn.execute("INSERT INTO gameplay_ai_runs VALUES('source-run',?,'same-profile','same-session',?)",params![source,old_scope.to_string()]).unwrap();
            conn.execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at,usage) SELECT ?1,dataset_id,'source-run','cancelled',model,batch_size,auto_correct,created_at,updated_at,usage FROM ai_review_jobs WHERE id=?2",params![source,id]).unwrap();
            conn.execute("INSERT INTO ai_review_items SELECT ?1,31,19,queue_id,sample_key,region_id,group_name,prior_label,prior_prediction_id,pixel_sha256,prior_event_id,'pending',NULL FROM ai_review_items WHERE job_id=?2",params![source,id]).unwrap();
            let mut phases = Vec::new();
            for key in ["first_reading", "verification"] {
                let reading = &failure["result"][key];
                assert_eq!(
                    reading["request_evidence"],
                    recovery::request_evidence(
                        &failure["payload"]["guide"],
                        failure["pixel_sha256"].as_str().unwrap(),
                        failure["sample_key"].as_str().unwrap(),
                        failure["group_name"].as_str().unwrap()
                    )
                );
                phases.push(json!({"31":reading,"_response":reading["_response"]}).to_string());
            }
            conn.execute("INSERT INTO ai_review_batches(job_id,batch_index,response,verification) VALUES(?,19,?,?)",params![source,phases[0],phases[1]]).unwrap();
            conn.execute(
                "INSERT INTO gameplay_ai_job_quarantines VALUES(?)",
                [source],
            )
            .unwrap();
            recovery::import(&conn, &f.ctx, source, id).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM ai_review_recovered_observations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2
            );
            cache::register(
                &conn,
                failure["sample_key"].as_str().unwrap(),
                "suit",
                failure["pixel_sha256"].as_str().unwrap(),
            )
            .unwrap();
        }
        f.manager.run_fixture(&f.ctx, id);
        let conn = f.ctx.connection().unwrap();
        let raw: String = conn
            .query_row(
                "SELECT result FROM ai_review_items WHERE job_id=?",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let result: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(result["state"], "flagged", "{result}");
        assert!(result["reason"].as_str().unwrap().contains("contradicts"));
        assert!(result["event_id"].is_null());
        assert_eq!(result["proposed_label"], "");
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM label_review_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(matches!(
            cache::truth(&conn, failure["sample_key"].as_str().unwrap()).unwrap(),
            cache::Truth::NeedsReview { .. }
        ));
        assert!(quarantine::guard(&conn, source).is_err());
        if let Ok(output) = std::env::var("POKER_BLANK_RECEIPT") {
            std::fs::write(output,serde_json::to_vec_pretty(&json!({"state":"flagged","provider_calls":0,"recovered_phases":2,"accepted_events":0,"cache":"needs_review","result":result})).unwrap()).unwrap();
        }
    }
    #[test]
    fn received_intent_and_claims_commit_atomically_and_reconcile_replay() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE gameplay_ai_request_intents(request_key TEXT PRIMARY KEY,state TEXT,response TEXT); CREATE TABLE gameplay_ai_asset_requests(claim_key TEXT PRIMARY KEY,request_key TEXT,state TEXT); INSERT INTO gameplay_ai_request_intents VALUES('k','pending',NULL); INSERT INTO gameplay_ai_asset_requests VALUES('c','k','pending'); INSERT INTO gameplay_ai_asset_requests VALUES('other','other-key','pending'); CREATE TRIGGER fail_claim BEFORE UPDATE ON gameplay_ai_asset_requests BEGIN SELECT RAISE(ABORT,'simulated crash'); END;").unwrap();
        let response = json!({"id":"paid-response"});
        assert!(
            AiReviewManager::complete_gameplay_intent(&mut conn, "k", Some(&response)).is_err()
        );
        let stored: (String, Option<String>) = conn
            .query_row(
                "SELECT state,response FROM gameplay_ai_request_intents WHERE request_key='k'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, ("pending".into(), None));
        conn.execute_batch("DROP TRIGGER fail_claim").unwrap();
        AiReviewManager::complete_gameplay_intent(&mut conn, "k", Some(&response)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT state FROM gameplay_ai_asset_requests WHERE claim_key='c'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "received"
        );
        conn.execute(
            "UPDATE gameplay_ai_asset_requests SET state='pending' WHERE claim_key='c'",
            [],
        )
        .unwrap();
        AiReviewManager::complete_gameplay_intent(&mut conn, "k", None).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT state FROM gameplay_ai_asset_requests WHERE claim_key='c'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "received"
        );
        assert_eq!(
            conn.query_row(
                "SELECT state FROM gameplay_ai_asset_requests WHERE claim_key='other'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
    }
}
