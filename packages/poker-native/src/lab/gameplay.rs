#[path = "gameplay/capture.rs"]
pub(crate) mod capture;
pub use capture::Capture as NativeCapture;
#[path = "gameplay/colors.rs"]
mod colors;
#[path = "gameplay/native.rs"]
mod native;
#[path = "gameplay/store.rs"]
mod store;
use super::{LabError, LabRequest, LabResponse, LabResult, LabService};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
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
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
    pub fn handle(
        &self,
        _service: &LabService,
        request: &LabRequest,
    ) -> Option<LabResult<LabResponse>> {
        if request.path != "/api/gameplay" && !request.path.starts_with("/api/gameplay/") {
            return None;
        }
        Some(self.request(request))
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
