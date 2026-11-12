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
    pub watch: watch::WatchCoordinator,
    pub started: f64,
}
impl LabService {
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
        let registry = Arc::new(datasets::DatasetRegistry::new(
            root.join("collector_datasets"),
        )?);
        let model = Arc::new(model::ModelRuntime::with_environment(
            tools_root.clone(),
            environment.clone(),
        )?);
        let ai_review = Arc::new(ai_review::AiReviewManager::new(
            registry.clone(),
            model.clone(),
        )?);
        let gameplay = Arc::new(gameplay::GameplayService::with_environment(
            root.join("gameplay_recordings"),
            tools_root,
            config_root.clone(),
            environment.clone(),
        )?);
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
        if request.path.starts_with("/api/editor/") {
            return capture::editor(self, request);
        }
        if let Some(response) = self.gameplay.handle(self, request) {
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
