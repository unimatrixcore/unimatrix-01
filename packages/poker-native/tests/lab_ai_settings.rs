use poker_native::lab::{LabRequest, LabResponse, LabService};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn service(root: &Path) -> LabService {
    LabService::open_with_paths(
        root.join("data"),
        root.join("config"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        HashMap::from([
            ("HOME".into(), root.to_string_lossy().into_owned()),
            (
                "OCR_MODEL_PYTHON".into(),
                root.join("unconfigured-python")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]),
    )
    .unwrap()
}

fn request(service: &LabService, method: &str, path: &str, body: Value) -> LabResponse {
    service.request(LabRequest {
        method: method.into(),
        path: path.into(),
        body,
        query: BTreeMap::new(),
        headers: BTreeMap::new(),
    })
}

fn settings(service: &LabService, method: &str, body: Value) -> LabResponse {
    request(service, method, "/api/ai-review/config", body)
}

#[test]
fn api_key_and_model_survive_restart_and_model_edits_preserve_the_key() {
    let root = tempfile::tempdir().unwrap();
    let app = service(root.path());
    let saved = settings(
        &app,
        "POST",
        json!({"api_key":"fixture-persistent-key","model":"gpt-4.1-mini"}),
    );
    assert_eq!(saved.status, 200, "{}", saved.body);
    assert!(!saved.body.to_string().contains("fixture-persistent-key"));
    assert_eq!(saved.headers["Cache-Control"], "private, no-store");
    let file = root.path().join("config/ai-review.json");
    let before: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(before["api_key"], "fixture-persistent-key");
    drop(app);
    let reopened = service(root.path());
    let status = settings(&reopened, "GET", Value::Null);
    assert_eq!(status.body["configured"], true);
    assert_eq!(status.body["model"], "gpt-4.1-mini");
    let changed = settings(&reopened, "POST", json!({"model":"gpt-4.1"}));
    assert_eq!(changed.status, 200);
    let after: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert_eq!(after["api_key"], before["api_key"]);
    drop(reopened);
    assert_eq!(
        settings(&service(root.path()), "GET", Value::Null).body["model"],
        "gpt-4.1"
    );
}

#[test]
fn validation_is_atomic_and_explicit_empty_key_removes_the_saved_credential() {
    let root = tempfile::tempdir().unwrap();
    let app = service(root.path());
    settings(
        &app,
        "POST",
        json!({"api_key":"fixture-original-key","model":"gpt-4.1-mini"}),
    );
    let file = root.path().join("config/ai-review.json");
    let original = fs::read(&file).unwrap();
    let failed = settings(
        &app,
        "POST",
        json!({"api_key":"fixture-replacement-key","model":"../invalid-model"}),
    );
    assert_eq!(failed.status, 400);
    assert!(!failed.body.to_string().contains("fixture-replacement-key"));
    assert_eq!(fs::read(&file).unwrap(), original);
    assert_eq!(
        settings(&app, "GET", Value::Null).body["model"],
        "gpt-4.1-mini"
    );
    assert_eq!(
        settings(&app, "POST", json!({"api_key":"bad\u{0}key"})).status,
        400
    );
    assert_eq!(settings(&app, "POST", json!({"api_key":""})).status, 200);
    let value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert!(value.get("api_key").is_none());
    assert_eq!(value["model"], "gpt-4.1-mini");
    drop(app);
    let reopened = service(root.path());
    let env_configured = std::env::var("OPENAI_API_KEY").is_ok_and(|key| !key.is_empty());
    assert_eq!(
        settings(&reopened, "GET", Value::Null).body["configured"],
        env_configured
    );
}

#[test]
fn global_settings_do_not_resolve_or_lock_a_collection() {
    let root = tempfile::tempdir().unwrap();
    let app = Arc::new(service(root.path()));
    assert_eq!(settings(&app, "GET", Value::Null).status, 200);
    assert!(!root
        .path()
        .join("data/collector_datasets/legacy/data.db")
        .exists());
    assert_eq!(
        settings(&app, "POST", json!({"model":"gpt-4.1-mini"})).status,
        200
    );
    assert!(!root
        .path()
        .join("data/collector_datasets/legacy/data.db")
        .exists());
    let context = app.registry.resolve("legacy").unwrap();
    let lock = context.lock_operation().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let cloned = app.clone();
    let worker =
        std::thread::spawn(move || sender.send(settings(&cloned, "GET", Value::Null)).unwrap());
    let result = receiver.recv_timeout(Duration::from_secs(2));
    drop(lock);
    worker.join().unwrap();
    assert_eq!(result.unwrap().status, 200);
}

#[cfg(unix)]
#[test]
fn private_permissions_and_failed_save_preserve_the_previous_settings() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let app = service(root.path());
    settings(
        &app,
        "POST",
        json!({"api_key":"fixture-old-key","model":"gpt-4.1-mini"}),
    );
    let file = root.path().join("config/ai-review.json");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(root.path().join("config"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let original = fs::read(&file).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let failed = settings(
        &app,
        "POST",
        json!({"api_key":"fixture-new-key","model":"gpt-4.1"}),
    );
    assert_eq!(failed.status, 503);
    assert_eq!(
        settings(&app, "GET", Value::Null).body["model"],
        "gpt-4.1-mini"
    );
    assert_eq!(fs::read(&file).unwrap(), original);
    assert!(!failed.body.to_string().contains("fixture-new-key"));
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    drop(app);
    assert_eq!(
        settings(&service(root.path()), "GET", Value::Null).body["configured"],
        true
    );
}

#[cfg(unix)]
#[test]
fn corrupted_or_linked_storage_is_actionable_and_active_ocr_info_stays_available() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("config")).unwrap();
    let file = root.path().join("config/ai-review.json");
    fs::write(&file, b"{\"api_key\":\"fixture-private-token\",invalid}").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let app = service(root.path());
    let error = settings(&app, "GET", Value::Null);
    assert_eq!(error.status, 503);
    assert!(error.body["error"].as_str().unwrap().contains("save"));
    assert!(!error.body.to_string().contains("fixture-private-token"));
    fs::write(
        root.path()
            .join("data/ocr-training/lab-runs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        b"broken unrelated run",
    )
    .unwrap();
    assert_eq!(
        request(&app, "GET", "/api/training/active", Value::Null).status,
        200
    );
    assert_eq!(
        request(&app, "GET", "/api/datasets", Value::Null).status,
        200
    );
    assert_eq!(
        settings(
            &app,
            "POST",
            json!({"api_key":"fixture-repaired-key","model":"gpt-4.1"})
        )
        .status,
        200
    );
    let outside = root.path().join("outside.json");
    fs::write(&outside, b"outside contents").unwrap();
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&outside, &file).unwrap();
    assert_eq!(
        settings(&app, "POST", json!({"api_key":"fixture-another-key"})).status,
        503
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside contents");
    assert_eq!(
        settings(&service(root.path()), "GET", Value::Null).status,
        503
    );
}

#[cfg(unix)]
#[test]
fn oversized_saved_credentials_fail_without_loading_or_exposing_their_contents() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    drop(service(root.path()));
    let file = root.path().join("config/ai-review.json");
    fs::write(&file, vec![b'x'; 16_385]).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let app = service(root.path());
    let error = settings(&app, "GET", Value::Null);
    assert_eq!(error.status, 503);
    assert!(error.body["error"].as_str().unwrap().contains("size limit"));
    assert!(!error.body.to_string().contains("xxxxxxxx"));
    assert_eq!(
        request(&app, "GET", "/api/training/active", Value::Null).status,
        200
    );
}
