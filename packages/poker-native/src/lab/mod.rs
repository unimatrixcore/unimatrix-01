use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

pub mod ai_review;
pub mod capture;
pub mod datasets;
pub mod gameplay;
pub mod migration;
pub mod model;
pub mod queue;
pub mod review;
pub mod training;
pub mod watch;

#[derive(Debug)]
pub struct LabError {
    pub status: u16,
    pub message: String,
}
impl std::fmt::Display for LabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for LabError {}
impl From<rusqlite::Error> for LabError {
    fn from(e: rusqlite::Error) -> Self {
        Self {
            status: 500,
            message: e.to_string(),
        }
    }
}
impl From<std::io::Error> for LabError {
    fn from(e: std::io::Error) -> Self {
        Self {
            status: 500,
            message: e.to_string(),
        }
    }
}
impl From<serde_json::Error> for LabError {
    fn from(e: serde_json::Error) -> Self {
        bad(e.to_string())
    }
}
impl From<String> for LabError {
    fn from(e: String) -> Self {
        bad(e)
    }
}
pub type LabResult<T> = Result<T, LabError>;
pub fn bad(message: impl Into<String>) -> LabError {
    LabError {
        status: 400,
        message: message.into(),
    }
}
pub fn conflict(message: impl Into<String>) -> LabError {
    LabError {
        status: 409,
        message: message.into(),
    }
}
pub fn not_found(message: impl Into<String>) -> LabError {
    LabError {
        status: 404,
        message: message.into(),
    }
}
pub fn unavailable(message: impl Into<String>) -> LabError {
    LabError {
        status: 503,
        message: message.into(),
    }
}
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
pub fn uuid() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> LabResult<T> {
    Ok(serde_json::from_value(value.clone())?)
}
pub fn object(value: &Value) -> LabResult<&serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| bad("Expected a JSON object"))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LabRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Value,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}
impl LabRequest {
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(String::as_str)
    }
    pub fn number(&self, name: &str, default: usize) -> LabResult<usize> {
        self.query(name)
            .map(|value| {
                value
                    .parse::<usize>()
                    .map_err(|_| bad(format!("Invalid {name}")))
            })
            .unwrap_or(Ok(default))
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}
impl LabResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: BTreeMap::from([("Content-Type".into(), "application/json".into())]),
            body,
            body_base64: None,
        }
    }
    pub fn ok(body: Value) -> Self {
        Self::json(200, body)
    }
    pub fn binary(bytes: &[u8], mime: &str) -> Self {
        Self {
            status: 200,
            headers: BTreeMap::from([
                ("Content-Type".into(), mime.into()),
                ("Cache-Control".into(), "private, no-store".into()),
            ]),
            body: Value::Null,
            body_base64: Some(STANDARD.encode(bytes)),
        }
    }
    pub fn error(error: LabError) -> Self {
        Self::json(error.status, json!({"success":false,"error":error.message}))
    }
}
pub struct LabService {
    pub registry: Arc<datasets::DatasetRegistry>,
    pub model: Arc<model::ModelRuntime>,
    pub ai_review: Arc<ai_review::AiReviewManager>,
    pub gameplay: Arc<gameplay::GameplayService>,
    pub capture: Arc<capture::CaptureService>,
    pub training: training::TrainingManager,
    pub watch: watch::WatchCoordinator,
    pub started: f64,
}
impl LabService {
    pub fn list_page(
        &self,
        request: LabRequest,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<LabResponse, String> {
        match self.list_page_inner(request, cursor, limit) {
            Err(error) if error.status == 409 => Ok(LabResponse::error(error)),
            result => result.map_err(|error| error.message),
        }
    }

    fn list_page_inner(
        &self,
        request: LabRequest,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> LabResult<LabResponse> {
        let parts: Vec<_> = request.path.split('/').collect();
        let gameplay = match parts.as_slice() {
            ["", "api", "gameplay"] => Some(("sessions", None)),
            ["", "api", "gameplay", "sessions", id]
                if !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') =>
            {
                Some(("hands", Some(*id)))
            }
            ["", "api", "gameplay", "sessions", id, "frames"]
                if !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') =>
            {
                Some(("frames", Some(*id)))
            }
            _ => None,
        };
        let ai_job = match parts.as_slice() {
            ["", "api", "ai-review", "jobs", id, "results"]
                if !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') =>
            {
                Some(*id)
            }
            _ => None,
        };
        if request.method != "GET"
            || (gameplay.is_none()
                && ai_job.is_none()
                && ![
                    "/api/queue",
                    "/api/queue/review/items",
                    "/api/db_entries",
                    "/api/datasets",
                    "/api/get_session_history",
                    "/api/label_history",
                    "/api/name_suggestions",
                ]
                .contains(&request.path.as_str()))
        {
            return Err(bad("Unsupported list resource"));
        }
        let limit = limit.unwrap_or(250) as usize;
        if !(1..=500).contains(&limit) {
            return Err(bad("Page size must be between 1 and 500"));
        }
        let allowed: &[&str] = match request.path.as_str() {
            "/api/queue" => &["order"],
            "/api/queue/review/items" => &["run_id", "search", "filter"],
            "/api/db_entries" => &["search", "keys_only"],
            "/api/datasets" => &["include_archived"],
            "/api/label_history" => &["sample_key", "filename"],
            "/api/name_suggestions" => &["search"],
            "/api/get_session_history" => &["order"],
            _ if gameplay.is_some_and(|(kind, _)| kind == "sessions") => &["archived"],
            _ if gameplay.is_some_and(|(kind, _)| kind == "frames") => &["hand_id", "order"],
            _ => &[],
        };
        if request
            .query
            .keys()
            .any(|key| !allowed.contains(&key.as_str()))
            || request
                .query("search")
                .is_some_and(|s| s.chars().count() > 200)
        {
            return Err(bad("Invalid list query"));
        }
        let id = if request.path == "/api/datasets" {
            "catalog"
        } else if gameplay.is_some() {
            "gameplay"
        } else {
            request
                .header("X-Dataset-ID")
                .ok_or_else(|| bad("X-Dataset-ID is required"))?
        };
        let scope =
            sha256(serde_json::to_string(&json!([id, request.path, request.query]))?.as_bytes());
        let inner = if let Some(cursor) = cursor {
            if cursor.len() > 4096 {
                return Err(bad("Invalid list cursor"));
            }
            let bytes = STANDARD
                .decode(cursor)
                .map_err(|_| bad("Invalid list cursor"))?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| bad("Invalid list cursor"))?;
            if value["scope"] != scope {
                return Err(bad("List cursor does not match resource or query"));
            }
            Some(
                value["next"]
                    .as_str()
                    .ok_or_else(|| bad("Invalid list cursor"))?
                    .to_owned(),
            )
        } else {
            None
        };
        let page = if request.path == "/api/datasets" {
            let include = request.query("include_archived").unwrap_or("0");
            if !["0", "1"].contains(&include) {
                return Err(bad("Invalid archived filter"));
            }
            let catalog = self.registry.list()?;
            let revision = sha256(serde_json::to_string(&catalog)?.as_bytes());
            let offset = if let Some(raw) = inner.as_deref() {
                let (rev, off) = raw
                    .split_once(':')
                    .ok_or_else(|| bad("Invalid catalog cursor"))?;
                if rev != revision {
                    return Err(conflict("Dataset catalog changed; reload the list"));
                }
                off.parse::<usize>()
                    .map_err(|_| bad("Invalid catalog cursor"))?
            } else {
                0
            };
            let filtered: Vec<_> = catalog
                .as_array()
                .ok_or_else(|| bad("Invalid catalog"))?
                .iter()
                .filter(|row| include == "1" || row["archived"] != true)
                .cloned()
                .collect();
            let end = offset
                .checked_add(limit)
                .ok_or_else(|| bad("Invalid catalog cursor"))?
                .min(filtered.len());
            if offset > filtered.len() {
                return Err(bad("Invalid catalog cursor"));
            }
            json!({"items":filtered[offset..end],"total":filtered.len(),"next_cursor":if end<filtered.len(){Some(format!("{revision}:{end}"))}else{None},"meta":{"default_dataset_id":"legacy"}})
        } else if let Some((kind, session)) = gameplay {
            let archived = request.query("archived").unwrap_or("0");
            if !["0", "1"].contains(&archived) {
                return Err(bad("Invalid archived filter"));
            }
            if request.query("hand_id").is_some_and(|s| s.len() > 256) {
                return Err(bad("Invalid hand filter"));
            }
            self.gameplay.list_page(
                kind,
                session,
                request.query("hand_id"),
                request.query("order").unwrap_or("asc"),
                archived == "1",
                inner.as_deref(),
                limit,
            )?
        } else {
            let ctx = self.registry.resolve(id)?;
            let _operation = ctx.lock_operation()?;
            self.registry.resolve(id)?;
            let page = match request.path.as_str() {
                "/api/queue" => queue::page(
                    &ctx,
                    inner.as_deref(),
                    limit.min(100),
                    request.query("order").unwrap_or("newest"),
                )?,
                "/api/queue/review/items" => queue::review_items(
                    &ctx,
                    request.query("run_id").unwrap_or(""),
                    inner.as_deref(),
                    limit.min(100),
                    request.query("search").unwrap_or(""),
                    request.query("filter").unwrap_or("all"),
                )?,
                "/api/get_session_history" => {
                    let order = request.query("order").unwrap_or("recent");
                    if !["recent", "score"].contains(&order) {
                        return Err(bad("Invalid history order"));
                    }
                    capture::auxiliary_page(&ctx, "history", inner.as_deref(), limit, order)?
                }
                "/api/name_suggestions" => capture::auxiliary_page(
                    &ctx,
                    "names",
                    inner.as_deref(),
                    limit,
                    request.query("search").unwrap_or(""),
                )?,
                "/api/label_history" => review::history_page(
                    &ctx,
                    request.query("sample_key"),
                    request.query("filename"),
                    inner.as_deref(),
                    limit,
                )?,
                _ if ai_job.is_some() => {
                    let offset = inner
                        .as_deref()
                        .unwrap_or("0")
                        .parse::<usize>()
                        .map_err(|_| bad("Invalid AI result cursor"))?;
                    let mut result = self.ai_review.results(
                        &ctx,
                        ai_job.expect("job"),
                        offset,
                        limit.min(100),
                    )?;
                    if let Some(next) = result["next_cursor"].as_u64() {
                        result["next_cursor"] = json!(next.to_string());
                    }
                    result
                }
                _ => capture::db_entries_page(
                    &ctx,
                    inner.as_deref(),
                    limit,
                    request.query("search").unwrap_or(""),
                    request.query("keys_only"),
                )?,
            };
            page
        };
        let next = page["next_cursor"]
            .as_str()
            .map(|next| STANDARD.encode(json!({"scope":scope,"next":next}).to_string()));
        let total = page
            .get("total")
            .or_else(|| page.pointer("/summary/total"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let mut response = LabResponse::ok(
            json!({"items":page["items"],"nextCursor":next,"hasMore":next.is_some(),"total":total,"meta":page.get("meta").cloned().unwrap_or_else(|| page.get("summary").map(|summary| json!({"summary":summary,"review_stats":page["review_stats"],"run_id":page["run_id"]})).unwrap_or_else(|| json!({})))}),
        );
        if ai_job.is_some() {
            response
                .headers
                .insert("Cache-Control".into(), "private, no-store".into());
        }
        Ok(response)
    }
    pub fn open(root: PathBuf, tools_root: PathBuf) -> LabResult<Self> {
        Self::open_with_environment(root, tools_root, std::env::vars().collect())
    }
    pub fn open_with_environment(
        root: PathBuf,
        tools_root: PathBuf,
        environment: std::collections::HashMap<String, String>,
    ) -> LabResult<Self> {
        Self::open_with_paths(root.clone(), root.join("config"), tools_root, environment)
    }
    pub fn open_with_paths(
        root: PathBuf,
        config_root: PathBuf,
        tools_root: PathBuf,
        environment: std::collections::HashMap<String, String>,
    ) -> LabResult<Self> {
        crate::storage_paths::ensure_directory(&config_root)?;
        let registry = Arc::new(datasets::DatasetRegistry::new(
            root.join("collector_datasets"),
        )?);
        let selection =
            training::releases::selected_release(&config_root, &root.join("ocr-training"));
        let mut model_environment = environment.clone();
        model_environment
            .entry("OCR_MODEL_RELEASE".into())
            .or_insert_with(|| {
                root.join("ocr-training/release-candidate")
                    .to_string_lossy()
                    .into_owned()
            });
        if let Ok(Some(release)) = &selection {
            model_environment.insert(
                "OCR_MODEL_RELEASE".into(),
                release.to_string_lossy().into_owned(),
            );
        }
        let mut model =
            model::ModelRuntime::with_environment(tools_root.clone(), model_environment)?;
        if let Err(error) = selection {
            model.set_configuration_error(error.message);
        }
        let model = Arc::new(model);
        let ai_review = Arc::new(ai_review::AiReviewManager::new(
            registry.clone(),
            model.clone(),
            config_root.clone(),
        )?);
        let gameplay = Arc::new(gameplay::GameplayService::with_environment(
            root.join("gameplay_recordings"),
            tools_root.clone(),
            config_root.clone(),
            environment.clone(),
        )?);
        let training = training::TrainingManager::new(
            root.clone(),
            tools_root,
            registry.clone(),
            environment.clone(),
        )?
        .with_runtime(model.clone(), config_root.clone());
        let capture = Arc::new(capture::CaptureService::with_paths(
            config_root,
            root.join("screenshots"),
            environment,
        )?);
        Ok(Self {
            registry,
            model,
            ai_review,
            gameplay,
            capture,
            training,
            watch: watch::WatchCoordinator::default(),
            started: now_ms() as f64 / 1000.0,
        })
    }
    pub fn sample_input(
        &self,
        ctx: &Arc<datasets::DatasetContext>,
        data: &Value,
    ) -> LabResult<review::SampleInput> {
        review::sample_input(ctx, data)
    }
    pub fn request(&self, request: LabRequest) -> LabResponse {
        let mut response = match self.dispatch(&request) {
            Ok(response) => response,
            Err(error) => LabResponse::error(error),
        };
        if request.path.starts_with("/api/ai-review/") {
            response
                .headers
                .insert("Cache-Control".into(), "private, no-store".into());
        }
        response
    }
    fn dispatch(&self, request: &LabRequest) -> LabResult<LabResponse> {
        if !["GET", "POST", "PATCH", "DELETE"].contains(&request.method.as_str())
            || !request.path.starts_with("/api/")
            || request.path.contains(['?', '#', '\\', '\0'])
        {
            return Err(bad("Invalid local API request"));
        }
        if let Some(response) = self.ai_review.handle_configuration(request) {
            return response;
        }
        if request.path.starts_with("/api/editor/") {
            return capture::editor(self, request);
        }
        if let Some(response) = self.gameplay.handle(self, request) {
            return response;
        }
        if let Some(response) = self.training.handle(request) {
            return response;
        }
        if request.path == "/api/uptime" && request.method == "GET" {
            return Ok(LabResponse::ok(json!({"uptime":self.started})));
        }
        if request.path == "/api/model_status" && request.method == "GET" {
            return Ok(match self.model.status() {
                Ok(status) => LabResponse::ok(status),
                Err(error) => {
                    LabResponse::json(503, json!({"available":false,"error":error.message}))
                }
            });
        }
        if request.path == "/api/datasets" {
            return match request.method.as_str() {
                "GET" => Ok(LabResponse::ok(
                    json!({"datasets":self.registry.list()?,"default_dataset_id":"legacy"}),
                )),
                "POST" => Ok(LabResponse::json(
                    201,
                    json!({"dataset":self.registry.create(request.body.get("name").and_then(Value::as_str).ok_or_else(||bad("Dataset name must contain 1 to 100 characters"))?)?}),
                )),
                _ => Err(not_found("Unknown route")),
            };
        }
        if let Some(id) = request.path.strip_prefix("/api/datasets/") {
            let changes = if request.method == "DELETE" {
                json!({"archived":true})
            } else if request.method == "PATCH" {
                request.body.clone()
            } else {
                return Err(not_found("Unknown route"));
            };
            if changes["archived"].as_bool() == Some(true) {
                self.watch.stop(id, None)?;
            }
            return Ok(LabResponse::ok(
                json!({"dataset":self.registry.update(id,&changes)?}),
            ));
        }
        let media = request.path.starts_with("/api/db_image/")
            || request.path.starts_with("/api/cap_image/")
            || request.path.starts_with("/api/queue/image/")
            || (request.method == "GET"
                && request.path.starts_with("/api/ai-review/jobs/")
                && request.path.ends_with("/grid"));
        let id = request
            .header("X-Dataset-ID")
            .or_else(|| {
                if media {
                    request.query("dataset_id")
                } else {
                    None
                }
            })
            .ok_or_else(|| bad("X-Dataset-ID is required"))?;
        let ctx = self.registry.resolve(id)?;
        let _operation = if [
            "/api/model_suggestion",
            "/api/sync_status",
            "/api/watch/tick",
        ]
        .contains(&request.path.as_str())
        {
            None
        } else {
            Some(ctx.lock_operation()?)
        };
        if _operation.is_some() {
            self.registry.resolve(id)?;
        }
        if let Some(response) = self.ai_review.handle(self, &ctx, request) {
            return response;
        }
        if let Some(response) = queue::handle(self, &ctx, request) {
            return response;
        }
        if let Some(response) = review::handle(self, &ctx, request) {
            return response;
        }
        if let Some(response) = watch::handle(self, &ctx, request) {
            return response;
        }
        if let Some(response) = capture::handle(self, &ctx, request) {
            return response;
        }
        Err(not_found("Unknown local Lab API route"))
    }
}
pub fn python_json(value: &Value, compact: bool) -> LabResult<String> {
    let raw = serde_json::to_string(value)?;
    let mut ascii = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for c in raw.chars() {
        if c.is_ascii() {
            ascii.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = !quoted;
            } else if !compact && !quoted && (c == ',' || c == ':') {
                ascii.push(' ');
            }
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                ascii.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    Ok(ascii)
}
