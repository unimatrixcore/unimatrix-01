use poker_native::lab::{LabRequest, LabResponse, LabService};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
fn request(
    service: &LabService,
    method: &str,
    path: &str,
    body: Value,
    dataset: bool,
) -> LabResponse {
    service.request(LabRequest {
        method: method.into(),
        path: path.into(),
        body,
        query: BTreeMap::new(),
        headers: if dataset {
            BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())])
        } else {
            BTreeMap::new()
        },
    })
}
fn service(root: &std::path::Path, extra: HashMap<String, String>) -> LabService {
    let mut env = HashMap::from([
        ("HOME".into(), root.to_string_lossy().into_owned()),
        (
            "OCR_MODEL_PYTHON".into(),
            root.join("unconfigured-python")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "OCR_MODEL_RELEASE".into(),
            root.join("unconfigured-release")
                .to_string_lossy()
                .into_owned(),
        ),
    ]);
    env.extend(extra);
    LabService::open_with_environment(
        root.join("data"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        env,
    )
    .unwrap()
}
#[test]
fn invalid_model_configuration_keeps_datasets_usable_and_preserves_status_shape() {
    let root = tempfile::tempdir().unwrap();
    let service = service(
        root.path(),
        HashMap::from([("OCR_MODEL_BATCH_SIZE".into(), "9".into())]),
    );
    let status = request(&service, "GET", "/api/model_status", Value::Null, false);
    assert_eq!(status.status, 503);
    assert_eq!(status.body["available"], false);
    assert_eq!(
        status.body["error"],
        "OCR_MODEL_BATCH_SIZE must be between 1 and 8"
    );
    let datasets = request(&service, "GET", "/api/datasets", Value::Null, false);
    assert_eq!(datasets.status, 200);
    assert_eq!(datasets.body["default_dataset_id"], "legacy");
}
#[test]
fn idle_model_status_is_lazy_and_wire_compatible() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), HashMap::new());
    let status = request(&service, "GET", "/api/model_status", Value::Null, false);
    assert_eq!(status.status, 200);
    assert_eq!(
        status.body,
        json!({"state":"idle","device":"gpu:0","error":null,"configured":false})
    );
}
#[test]
fn ai_success_and_early_errors_are_private_and_never_echo_credentials() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), HashMap::new());
    let missing = request(&service, "GET", "/api/ai-review/config", Value::Null, false);
    assert_eq!(missing.status, 400);
    assert_eq!(missing.headers["Cache-Control"], "private, no-store");
    let invalid = request(
        &service,
        "POST",
        "/api/ai-review/config",
        json!({"api_key":"bad key"}),
        true,
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.headers["Cache-Control"], "private, no-store");
    let configured = request(
        &service,
        "POST",
        "/api/ai-review/config",
        json!({"api_key":"fixture-secret-token","model":"gpt-4.1"}),
        true,
    );
    assert_eq!(configured.status, 200);
    assert_eq!(configured.body["configured"], true);
    assert_eq!(configured.headers["Cache-Control"], "private, no-store");
    assert!(!configured.body.to_string().contains("fixture-secret-token"));
}
#[test]
fn all_collection_commit_routes_block_while_ai_job_is_active() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), HashMap::new());
    let ctx = service.registry.resolve("legacy").unwrap();
    service.ai_review.ensure(&ctx).unwrap();
    ctx.connection().unwrap().execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at) VALUES('0123456789abcdef0123456789abcdef','legacy','run','queued','fixture',12,1,0,0)",[]).unwrap();
    for path in [
        "/api/queue/review/commit",
        "/api/queue/commit",
        "/api/add_to_db",
    ] {
        let response = request(
            &service,
            "POST",
            path,
            json!({"run_id":"run","sample_keys":[],"entries":[]}),
            true,
        );
        assert_eq!(response.status, 409, "{path}: {}", response.body);
        assert!(response.body["error"]
            .as_str()
            .unwrap()
            .contains("Pause AI review"));
    }
}
