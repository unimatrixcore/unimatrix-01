#[path = "gameplay/capture.rs"]
pub(crate) mod capture;
pub use capture::Capture as NativeCapture;
pub mod ai;
#[path = "gameplay/card_crop.rs"]
pub mod card_crop;
#[path = "gameplay/card_fields.rs"]
pub(super) mod card_fields;
#[path = "gameplay/card_glyph.rs"]
pub(super) mod card_glyph;
#[path = "gameplay/colors.rs"]
mod colors;
#[path = "gameplay/crop_mask.rs"]
pub mod crop_mask;
#[path = "gameplay/native.rs"]
mod native;
#[path = "gameplay/panels.rs"]
pub(super) mod panels;
#[path = "gameplay/presence.rs"]
pub mod presence;
pub(super) mod profile;
pub(super) mod regions;
#[path = "gameplay/status.rs"]
pub(super) mod status;
#[path = "gameplay/store.rs"]
pub mod store;
use super::{LabError, LabRequest, LabResponse, LabResult, LabService};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
fn enrich_response_frame(
    request: &LabRequest,
    response: &mut LabResponse,
    enrich: impl FnOnce(&mut serde_json::Value) -> LabResult<()>,
) -> LabResult<()> {
    if let Some(frame) = response.body.get_mut("frame") {
        if let Err(error) = enrich(frame) {
            if request.method == "POST" && request.path.ends_with("/capture") {
                frame["effective_region_error"] = serde_json::json!(error.message);
            } else {
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod response_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn committed_capture_survives_enrichment_failure_once() {
        let root = tempfile::tempdir().unwrap();
        let store = store::Store::new(root.path().join("recordings")).unwrap();
        let session = store
            .create("monitor", 1000, "fixture", &json!({}), "hash")
            .unwrap();
        let id = session["id"].as_str().unwrap();
        let frame = store
            .admit(
                id,
                b"fixture",
                1,
                1,
                "2026-01-01T00:00:00Z",
                &json!({}),
                "hash",
                &json!({}),
                "123",
                &json!({}),
            )
            .unwrap();
        let frame_id = frame["id"].clone();
        let mut response =
            LabResponse::ok(json!({"frame":frame,"session":store.session(id).unwrap()}));
        let mut request = LabRequest {
            method: "POST".into(),
            path: format!("/api/gameplay/sessions/{id}/capture"),
            body: json!({}),
            query: Default::default(),
            headers: Default::default(),
        };
        enrich_response_frame(&request, &mut response, |_| {
            Err(super::super::bad("fixture enrichment failure"))
        })
        .unwrap();
        assert_eq!(response.body["frame"]["id"], frame_id);
        assert_eq!(
            response.body["frame"]["effective_region_error"],
            "fixture enrichment failure"
        );
        assert_eq!(response.body["session"]["frame_count"], 1);
        assert_eq!(store.frames(id, None, 0, 10, "desc").unwrap()["total"], 1);
        request.method = "GET".into();
        assert!(
            enrich_response_frame(&request, &mut response, |_| Err(super::super::bad(
                "failure"
            )))
            .is_err()
        );
    }
}
pub struct GameplayService {
    inner: native::Gameplay,
}
impl GameplayService {
    pub fn new(root: PathBuf) -> LabResult<Self> {
        let repo = std::env::var_os("POKER_LAB_TOOLS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"));
        let config = root.parent().unwrap_or(&root).join("config");
        Self::new_with_paths(root, repo, config)
    }
    pub fn new_with_paths(root: PathBuf, repo: PathBuf, config: PathBuf) -> LabResult<Self> {
        Self::with_environment(root, repo, config, std::env::vars().collect())
    }
    pub fn with_environment(
        root: PathBuf,
        repo: PathBuf,
        config: PathBuf,
        mut environment: HashMap<String, String>,
    ) -> LabResult<Self> {
        environment
            .entry("POKER_GAMEPLAY_ROOT".into())
            .or_insert_with(|| root.to_string_lossy().into_owned());
        let inner = native::Gameplay::with_config_root(repo, &environment, config);
        Ok(Self { inner })
    }
    pub fn list_page(
        &self,
        kind: &str,
        session: Option<&str>,
        hand: Option<&str>,
        order: &str,
        archived: bool,
        cursor: Option<&str>,
        limit: usize,
    ) -> LabResult<serde_json::Value> {
        self.inner
            .list_page(kind, session, hand, order, archived, cursor, limit)
            .map_err(|error| {
                let (status, message) = error
                    .split_once(':')
                    .and_then(|(code, message)| {
                        code.parse::<u16>()
                            .ok()
                            .map(|status| (status, message.to_string()))
                    })
                    .unwrap_or((500, error.clone()));
                LabError { status, message }
            })
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
    ) -> LabResult<serde_json::Value> {
        self.inner
            .list_page_collection(
                kind, session, hand, order, archived, cursor, limit, collection,
            )
            .map_err(|error| {
                let (status, message) = error
                    .split_once(':')
                    .and_then(|(code, message)| {
                        code.parse::<u16>()
                            .ok()
                            .map(|status| (status, message.to_owned()))
                    })
                    .unwrap_or((500, error.clone()));
                LabError { status, message }
            })
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
    pub fn evidence_root(&self) -> LabResult<PathBuf> {
        self.inner
            .store()
            .map(|s| s.root().to_path_buf())
            .map_err(|message| super::bad(message))
    }
    pub fn evidence_store(&self) -> LabResult<&store::Store> {
        self.inner.store().map_err(super::bad)
    }
    pub fn handle(
        &self,
        service: &LabService,
        request: &LabRequest,
    ) -> Option<LabResult<LabResponse>> {
        if request.path != "/api/gameplay" && !request.path.starts_with("/api/gameplay/") {
            return None;
        }
        if request.path.starts_with("/api/gameplay/ai/") {
            return Some(service.gameplay_ai.handle(service, request));
        }
        if request.method == "GET"
            && !["/image", "/preview", "/thumbnail"]
                .iter()
                .any(|suffix| request.path.ends_with(suffix))
        {
            if let Err(error) = service.gameplay_ai.sync_effective_hands(service) {
                return Some(Err(error));
            }
        }
        Some(self.request(request).and_then(|mut response| {
            enrich_response_frame(request, &mut response, |frame| {
                service
                    .gameplay_ai
                    .enrich_frame_at(frame, &self.evidence_root()?)
            })?;
            if let Some(frames) = response
                .body
                .get_mut("frames")
                .and_then(serde_json::Value::as_array_mut)
            {
                service
                    .gameplay_ai
                    .enrich_summaries(frames, &self.evidence_root()?)?;
            }
            let session = response.body["session"]["id"].as_str().map(str::to_owned);
            if let (Some(session), Some(hands)) = (
                session,
                response
                    .body
                    .get_mut("hands")
                    .and_then(serde_json::Value::as_array_mut),
            ) {
                service
                    .gameplay_ai
                    .enrich_hands(hands, &session, &self.evidence_root()?)?;
            }
            Ok(response)
        }))
    }
    pub fn request(&self, request: &LabRequest) -> LabResult<LabResponse> {
        (|| {
            let mut url = url::Url::parse("http://localhost").map_err(|e| LabError {
                status: 400,
                message: e.to_string(),
            })?;
            url.set_path(&request.path);
            if !request.query.is_empty() {
                url.query_pairs_mut().extend_pairs(request.query.iter());
            }
            let mut builder = http::Request::builder()
                .method(request.method.as_str())
                .uri(url.as_str());
            for (key, value) in &request.headers {
                builder = builder.header(key.as_str(), value.as_str());
            }
            let http = builder
                .body(serde_json::to_vec(&request.body)?)
                .map_err(|e| LabError {
                    status: 400,
                    message: e.to_string(),
                })?;
            let response = self.inner.handle(&http);
            let status = response.status().as_u16();
            let headers: BTreeMap<_, _> = response
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
                .collect();
            let is_json = response
                .headers()
                .get("content-type")
                .is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
            let (body, body_base64) = if is_json {
                (serde_json::from_slice(response.body())?, None)
            } else {
                (
                    serde_json::Value::Null,
                    Some(STANDARD.encode(response.body())),
                )
            };
            Ok(LabResponse {
                status,
                headers,
                body,
                body_base64,
            })
        })()
    }
}
impl Drop for GameplayService {
    fn drop(&mut self) {
        self.inner.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};
    use serde_json::{json, Value};
    use std::io::Cursor;
    fn request(path: &str) -> LabRequest {
        LabRequest {
            method: "GET".into(),
            path: path.into(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: Value::Null,
        }
    }
    #[test]
    fn json_and_binary_transport_preserve_native_status_headers_and_pixels() {
        let root = tempfile::tempdir().unwrap();
        let store = store::Store::new(root.path().join("recordings")).unwrap();
        let session = store
            .create(
                "fixture-monitor",
                1000,
                "Fixture",
                &json!({}),
                "configuration-hash",
            )
            .unwrap();
        let mut png = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(8, 4)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let frame = store
            .admit(
                session["id"].as_str().unwrap(),
                &png,
                8,
                4,
                "2026-11-12T00:00:00Z",
                &json!({}),
                "configuration-hash",
                &json!({}),
                "123456",
                &json!({}),
            )
            .unwrap();
        let service = GameplayService::with_environment(
            root.path().join("recordings"),
            root.path().join("tools"),
            root.path().join("config"),
            HashMap::from([("HOME".into(), root.path().to_string_lossy().into_owned())]),
        )
        .unwrap();
        let sessions = service.request(&request("/api/gameplay")).unwrap();
        assert_eq!(sessions.status, 200);
        assert_eq!(sessions.body["sessions"][0]["id"], session["id"]);
        assert!(sessions.body_base64.is_none());
        let before = store.frame(frame["id"].as_str().unwrap(), true).unwrap();
        let detail = service
            .request(&request(&format!(
                "/api/gameplay/frames/{}",
                frame["id"].as_str().unwrap()
            )))
            .unwrap();
        assert_eq!(detail.status, 200);
        assert_eq!(
            detail.body["frame"]["color_state"]["configuration"],
            "unavailable"
        );
        assert_eq!(
            store.frame(frame["id"].as_str().unwrap(), true).unwrap(),
            before
        );
        let image_path = format!(
            "/api/gameplay/frames/{}/image",
            frame["id"].as_str().unwrap()
        );
        let image = service.request(&request(&image_path)).unwrap();
        assert_eq!(image.headers["content-type"], "image/png");
        assert_eq!(
            STANDARD
                .decode(image.body_base64.as_deref().unwrap())
                .unwrap(),
            png
        );
        let mut conditional = request(&image_path);
        conditional
            .headers
            .insert("If-None-Match".into(), image.headers["etag"].clone());
        let cached = service.request(&conditional).unwrap();
        assert_eq!(cached.status, 304);
        assert_eq!(cached.body_base64.as_deref(), Some(""));
        let mut invalid = request("/api/gameplay");
        invalid.query.insert("archived".into(), "wrong".into());
        assert_eq!(service.request(&invalid).unwrap().status, 400);
    }
}

#[path = "gameplay/visible_runs.rs"]
pub mod visible_runs;
