use poker_native::lab::{datasets::atomic_json, sha256, LabRequest, LabService};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
};

const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
struct Fixture {
    root: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            root: tempfile::tempdir().unwrap(),
        };
        let root = fixture.root.path();
        let script = root.join("tools/dev_tools/training/collector_inference.py");
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(script,r#"import argparse,json,sys,os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--release');p.add_argument('--device');p.add_argument('--batch-size');a=p.parse_args()
root=Path(a.release)
if (root/'models/general/model.onnx').read_bytes()==b'broken':
 print('{"ready":false}',flush=True);sys.exit(1)
print('{"ready":true}',flush=True)
for line in sys.stdin:
 r=json.loads(line);print(json.dumps({'ok':True,'predictions':[{'text':'fixture','pid':os.getpid(),'release':str(root)} for _ in r['items']]}),flush=True)
"#).unwrap();
        let baseline = root.join("baseline");
        let mut freeze = json!({"weights":{},"characters_sha256":{}});
        for role in ["general", "names"] {
            let dir = baseline.join("models").join(role);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("model.onnx"), b"baseline").unwrap();
            fs::write(dir.join("characters.json"), b"[]").unwrap();
            freeze["weights"][role] = json!(sha256(b"baseline"));
            freeze["characters_sha256"][role] = json!(sha256(b"[]"));
        }
        atomic_json(&baseline.join("freeze.json"), &freeze).unwrap();
        atomic_json(
            &baseline.join("runtime.json"),
            &json!({"general_model":"models/general","name_model":"models/names"}),
        )
        .unwrap();
        fixture
    }
    fn run(&self) -> PathBuf {
        self.root.path().join("data/ocr-training/lab-runs").join(ID)
    }
    fn service(&self) -> LabService {
        let root = self.root.path();
        LabService::open_with_paths(
            root.join("data"),
            root.join("config"),
            root.join("tools"),
            HashMap::from([
                ("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into()),
                (
                    "OCR_MODEL_RELEASE".into(),
                    root.join("baseline").to_string_lossy().into_owned(),
                ),
            ]),
        )
        .unwrap()
    }
    fn version(&self, weights: &[u8]) {
        let run = self.run();
        let bundle = run.join("bundle");
        fs::create_dir_all(&bundle).unwrap();
        let mut artifacts = json!({});
        let mut models = json!({});
        for role in ["general", "names"] {
            let dir = bundle.join(role).join("portable");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("model.onnx"), weights).unwrap();
            fs::write(dir.join("characters.json"), b"[]").unwrap();
            artifacts[role] = json!({"portable/model.onnx":sha256(weights),"portable/characters.json":sha256(b"[]")});
            models[role] =
                json!({"sha256":{"model.onnx":sha256(weights),"characters.json":sha256(b"[]")}});
        }
        let selection = json!({"role":"names","selected_checkpoint_sha256":sha256(b"incoming")});
        fs::write(bundle.join("names/selected.pdparams"), b"incoming").unwrap();
        atomic_json(&bundle.join("names/model-selection.json"), &selection).unwrap();
        fs::create_dir_all(bundle.join("names/checkpoints")).unwrap();
        fs::write(
            bundle.join("names/checkpoints/best_accuracy.pdparams"),
            b"worse final",
        )
        .unwrap();
        artifacts["names"]["selected.pdparams"] = json!(sha256(b"incoming"));
        artifacts["names"]["model-selection.json"] = json!(sha256(
            &fs::read(bundle.join("names/model-selection.json")).unwrap()
        ));
        fs::write(bundle.join("test.jsonl"), b"test\n").unwrap();
        let mut rows = Vec::new();
        for role in ["general", "names"] {
            for condition in ["identity", "brightness_minus30", "jpeg80", "scale60"] {
                rows.push(json!({"role":role,"condition":condition,"category":"all","samples":10,"exact_match":0.9,"baseline_exact_match":1.0,"regressions":1,"improved":0,"processing_errors":0}));
            }
        }
        let benchmark = json!({"samples":20,"exact_match":0.9,"baseline_exact_match":1.0,"cer":0.01,"p95_ms":1.0,"regressions":2,"improved":0,"processing_errors":0,"results":rows});
        atomic_json(&run.join("run.json"),&json!({"id":ID,"created_at":1,"status":"completed","kind":"training","version":1,"display_name":"Version 1"})).unwrap();
        atomic_json(&run.join("benchmark.json"), &benchmark).unwrap();
        atomic_json(&run.join("version.json"),&json!({"id":ID,"artifacts":artifacts,"test_sha256":sha256(b"test\n"),"benchmark":benchmark})).unwrap();
        fs::create_dir_all(run.join("benchmarks/candidate")).unwrap();
        atomic_json(
            &run.join("benchmarks/candidate/protocol.json"),
            &json!({"manifest_sha256":sha256(b"test\n"),"models":models}),
        )
        .unwrap();
    }
}
fn request(
    service: &LabService,
    method: &str,
    path: &str,
    body: Value,
) -> poker_native::lab::LabResponse {
    service.request(LabRequest {
        method: method.into(),
        path: path.into(),
        body,
        query: BTreeMap::new(),
        headers: BTreeMap::new(),
    })
}
fn activate(service: &LabService) -> poker_native::lab::LabResponse {
    request(
        service,
        "POST",
        "/api/training/activate",
        json!({"id":ID,"acknowledge_regressions":true}),
    )
}
#[test]
fn catalog_activation_persists_pair_and_baseline_rollback() {
    let fixture = Fixture::new();
    let service = fixture.service();
    fixture.version(b"candidate");
    let catalog = request(&service, "GET", "/api/training/versions", Value::Null);
    assert_eq!(catalog.status, 200, "{}", catalog.body);
    assert_eq!(catalog.body["versions"][1]["eligible"], true);
    assert_eq!(catalog.body["versions"][1]["regressions"], 8);
    assert_eq!(
        request(&service, "POST", "/api/training/activate", json!({"id":ID})).status,
        409
    );
    let before = service.model.predict(b"png", "pot").unwrap();
    let result = activate(&service);
    assert_eq!(result.status, 200, "{}", result.body);
    assert_eq!(result.body["active_release"]["id"], ID);
    let after = service.model.predict(b"png", "pot").unwrap();
    assert_ne!(before["pid"], after["pid"]);
    assert_eq!(
        fs::read(
            fixture
                .run()
                .join("bundle/names/checkpoints/best_accuracy.pdparams")
        )
        .unwrap(),
        b"worse final"
    );
    drop(service);
    let service = fixture.service();
    assert_eq!(
        request(&service, "GET", "/api/training/active", Value::Null).body["active_release"]["id"],
        ID
    );
    assert_eq!(
        service.model.predict(b"png", "pot").unwrap()["release"],
        after["release"]
    );
    let rollback = request(
        &service,
        "POST",
        "/api/training/activate",
        json!({"id":"baseline"}),
    );
    assert_eq!(rollback.status, 200, "{}", rollback.body);
    assert_eq!(rollback.body["active_release"]["id"], "baseline");
}
#[test]
fn failed_load_or_persistence_keeps_original_worker_and_selection() {
    let fixture = Fixture::new();
    let service = fixture.service();
    fixture.version(b"broken");
    let before = service.model.predict(b"png", "pot").unwrap();
    assert_eq!(activate(&service).status, 503);
    assert_eq!(
        service.model.predict(b"png", "pot").unwrap()["pid"],
        before["pid"]
    );
    assert!(!fixture.root.path().join("config/ocr-model.json").exists());
    fixture.version(b"candidate");
    fs::create_dir(fixture.root.path().join("config/ocr-model.json")).unwrap();
    assert!(activate(&service).status >= 400);
    assert_eq!(
        service.model.predict(b"png", "pot").unwrap()["pid"],
        before["pid"]
    );
}
#[test]
fn rejects_unknown_incomplete_tampered_and_unbenchmarked_pairs() {
    let fixture = Fixture::new();
    let service = fixture.service();
    fixture.version(b"candidate");
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training/activate",
            json!({"id":"../escape"})
        )
        .status,
        404
    );
    fs::write(
        fixture.run().join("bundle/names/portable/model.onnx"),
        b"tampered",
    )
    .unwrap();
    assert_eq!(activate(&service).status, 409);
    fixture.version(b"candidate");
    fs::write(
        fixture.run().join("bundle/names/selected.pdparams"),
        b"wrong selected",
    )
    .unwrap();
    assert_eq!(activate(&service).status, 409);
    fixture.version(b"candidate");
    let path = fixture.run().join("bundle/names/model-selection.json");
    atomic_json(
        &path,
        &json!({"role":"names","selected_checkpoint_sha256":"wrong"}),
    )
    .unwrap();
    let mut version: Value =
        serde_json::from_slice(&fs::read(fixture.run().join("version.json")).unwrap()).unwrap();
    version["artifacts"]["names"]["model-selection.json"] = json!(sha256(&fs::read(path).unwrap()));
    atomic_json(&fixture.run().join("version.json"), &version).unwrap();
    assert_eq!(activate(&service).status, 409);
    fixture.version(b"candidate");
    fs::remove_file(fixture.run().join("benchmark.json")).unwrap();
    assert!(activate(&service).status >= 400);
    fixture.version(b"candidate");
    atomic_json(&fixture.run().join("run.json"),&json!({"id":ID,"created_at":1,"status":"training","pid":std::process::id(),"kind":"training"})).unwrap();
    assert_eq!(activate(&service).status, 409);
    assert!(!fixture.root.path().join("config/ocr-model.json").exists());
}

#[test]
fn corrupt_saved_selection_keeps_app_usable_and_can_be_repaired_explicitly() {
    let fixture = Fixture::new();
    let service = fixture.service();
    drop(service);
    fs::write(
        fixture.root.path().join("config/ocr-model.json"),
        b"corrupt",
    )
    .unwrap();
    let service = fixture.service();
    assert!(service.model.status().is_err());
    assert_eq!(
        request(&service, "GET", "/api/training/active", Value::Null).body["active_release"]
            ["configured"],
        false
    );
    assert_eq!(
        request(&service, "GET", "/api/datasets", Value::Null).status,
        200
    );
    let result = request(
        &service,
        "POST",
        "/api/training/activate",
        json!({"id":"baseline"}),
    );
    assert_eq!(result.status, 200, "{}", result.body);
    assert_eq!(service.model.status().unwrap()["state"], "ready");
}

#[test]
fn baseline_catalog_uses_only_matching_measured_benchmark_predictions() {
    let fixture = Fixture::new();
    let service = fixture.service();
    fixture.version(b"candidate");
    let root = fixture.run();
    let rows:Vec<Value>=(0..20).map(|i|json!({"sample_id":format!("sample:{i}"),"label":"x","category":if i<10 {"bank"}else{"name"},"split":"test","pixel_sha256":sha256(format!("pixels:{i}").as_bytes()),"file_sha256":sha256(format!("file:{i}").as_bytes())})).collect();
    let manifest = rows
        .iter()
        .map(|r| serde_json::to_string(r).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(root.join("bundle/test.jsonl"), &manifest).unwrap();
    let mut version: Value =
        serde_json::from_slice(&fs::read(root.join("version.json")).unwrap()).unwrap();
    version["test_sha256"] = json!(sha256(manifest.as_bytes()));
    atomic_json(&root.join("version.json"), &version).unwrap();
    let protocol_path = root.join("benchmarks/candidate/protocol.json");
    let mut protocol: Value = serde_json::from_slice(&fs::read(&protocol_path).unwrap()).unwrap();
    protocol["manifest_sha256"] = version["test_sha256"].clone();
    atomic_json(&protocol_path, &protocol).unwrap();
    for role in ["general", "names"] {
        protocol["models"][role]["sha256"]["model.onnx"] = json!(sha256(b"baseline"));
    }
    protocol["samples"] = json!(20);
    fs::create_dir_all(root.join("benchmarks/baseline")).unwrap();
    atomic_json(&root.join("benchmarks/baseline/protocol.json"), &protocol).unwrap();
    for condition in ["identity", "brightness_minus30", "jpeg80", "scale60"] {
        let directory = root.join("benchmarks/baseline").join(condition);
        fs::create_dir_all(&directory).unwrap();
        let predictions: Vec<_> = rows
            .iter()
            .map(|row| {
                let mut value = row.clone();
                value["condition"] = json!(condition);
                value["model_role"] = json!(if row["category"] == "name" {
                    "names"
                } else {
                    "general"
                });
                value["raw_prediction"] = json!("x");
                value["raw_exact"] = json!(true);
                value["inference_ms"] = json!(2.5);
                serde_json::to_string(&value).unwrap()
            })
            .collect();
        fs::write(directory.join("predictions.jsonl"), predictions.join("\n")).unwrap();
    }
    let response = request(&service, "GET", "/api/training/versions", Value::Null);
    assert_eq!(response.status, 200, "{}", response.body);
    let original = &response.body["versions"][0];
    assert_eq!(original["benchmark_source_id"], ID);
    assert_eq!(original["benchmark"]["samples"], 20);
    assert_eq!(original["benchmark"]["exact_match"], 1.0);
    assert_eq!(original["benchmark"]["p95_ms"], 2.5);
    assert_eq!(original["benchmark"]["cer"], 0.0);
    protocol["models"]["names"]["sha256"]["model.onnx"] = json!(sha256(b"different"));
    atomic_json(&root.join("benchmarks/baseline/protocol.json"), &protocol).unwrap();
    assert!(
        request(&service, "GET", "/api/training/versions", Value::Null).body["versions"][0]
            .get("benchmark")
            .is_none()
    );
}
