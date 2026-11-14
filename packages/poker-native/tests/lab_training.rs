use poker_native::lab::{datasets::atomic_json, LabRequest, LabResponse, LabService};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn request(service: &LabService, method: &str, path: &str, body: Value) -> LabResponse {
    service.request(LabRequest {
        method: method.into(),
        path: path.into(),
        body,
        query: BTreeMap::new(),
        headers: BTreeMap::new(),
    })
}

fn fixture(root: &Path, configured: bool) -> LabService {
    let tools = root.join("tools");
    fs::create_dir_all(tools.join("dev_tools/training")).unwrap();
    if configured {
        let baseline = root.join("data/ocr-training/named-continuation/final");
        for name in [
            "manifest.jsonl",
            "dictionary.txt",
            "general/train.yml",
            "names/train.yml",
            "general/checkpoints/best_accuracy.pdparams",
        ] {
            let path = baseline.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"fixture").unwrap();
        }
        fs::write(
            tools.join("dev_tools/training/lab_training_job.py"),
            r#"import argparse, json, os, signal, time
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--request')
a = p.parse_args()
root = Path(a.request).parent
value = json.loads((root / 'run.json').read_text())
value.update(pid=os.getpid(), status='training', stage='Fixture running')
temp = root / 'fixture-status.tmp'
temp.write_text(json.dumps(value))
temp.replace(root / 'run.json')
def stop(signum, frame):
    value.update(status='interrupted', stage='Stopped')
    temp.write_text(json.dumps(value))
    temp.replace(root / 'run.json')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
time.sleep(60)
"#,
        )
        .unwrap();
    }
    LabService::open_with_environment(
        root.join("data"),
        tools,
        HashMap::from([
            ("HOME".into(), root.to_string_lossy().into_owned()),
            (
                "OCR_MODEL_PYTHON".into(),
                root.join("missing-model-python")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "OCR_TRAINING_PYTHON".into(),
                if configured {
                    "/usr/bin/python3".into()
                } else {
                    root.join("missing-training-python")
                        .to_string_lossy()
                        .into_owned()
                },
            ),
        ]),
    )
    .unwrap()
}

fn write_run(root: &Path, id: &str, status: &str, created_at: i64, pid: Option<u32>) -> PathBuf {
    let dir = root.join("data/ocr-training/lab-runs").join(id);
    fs::create_dir_all(&dir).unwrap();
    let mut value = json!({"id":id,"created_at":created_at,"collections":["legacy"],"epochs":6,"status":status,"stage":status});
    if let Some(pid) = pid {
        value["pid"] = json!(pid);
    }
    atomic_json(&dir.join("run.json"), &value).unwrap();
    dir
}

#[test]
fn training_setup_failure_does_not_prevent_collection_access() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let response = request(&service, "GET", "/api/training", Value::Null);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["setup"]["ready"], false);
    assert!(response.body["setup"]["error"]
        .as_str()
        .unwrap()
        .contains("OCR training Python"));
    assert_eq!(response.headers["Cache-Control"], "private, no-store");
    assert_eq!(
        request(&service, "GET", "/api/datasets", Value::Null).status,
        200
    );
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training",
            json!({"collections":["legacy"]})
        )
        .status,
        503
    );
}

#[test]
fn training_request_rejects_unsafe_or_ambiguous_selections() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    for body in [
        json!({"collections":[]}),
        json!({"collections":["legacy","legacy"]}),
        json!({"collections":["legacy"],"epochs":0}),
        json!({"collections":["legacy"],"epochs":101}),
        json!({"collections":["legacy"],"epochs":1.5}),
        json!({"collections":["legacy"],"command":"malicious"}),
    ] {
        assert_eq!(
            request(&service, "POST", "/api/training", body.clone()).status,
            400,
            "{body}"
        );
    }
    for id in ["../escape", "missing", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
        assert_eq!(
            request(
                &service,
                "POST",
                "/api/training",
                json!({"collections":[id]})
            )
            .status,
            404
        );
    }
    let created = request(
        &service,
        "POST",
        "/api/datasets",
        json!({"name":"Archived"}),
    );
    let id = created.body["dataset"]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &service,
            "DELETE",
            &format!("/api/datasets/{id}"),
            Value::Null
        )
        .status,
        200
    );
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training",
            json!({"collections":[id]})
        )
        .status,
        409
    );
}

#[test]
fn durable_history_recovers_dead_supervisors_but_keeps_recent_launches() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    write_run(root.path(), &"a".repeat(32), "completed", 1, None);
    write_run(
        root.path(),
        &"b".repeat(32),
        "training",
        2,
        Some(std::process::id()),
    );
    write_run(
        root.path(),
        &"c".repeat(32),
        "queued",
        poker_native::lab::now_ms(),
        None,
    );
    let result = request(&service, "GET", "/api/training", Value::Null);
    let runs = result.body["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[0]["status"], "queued");
    assert_eq!(runs[1]["status"], "interrupted");
    assert_eq!(runs[2]["status"], "completed");
    drop(service);
    let reopened = fixture(root.path(), false);
    let result = request(&reopened, "GET", "/api/training", Value::Null);
    assert_eq!(result.body["runs"][1]["status"], "interrupted");
}

#[test]
fn active_run_blocks_a_second_native_service_and_stops_only_its_supervisor() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let archived = request(
        &service,
        "POST",
        "/api/datasets",
        json!({"name":"Archived reservation source"}),
    );
    let archived_id = archived.body["dataset"]["id"].as_str().unwrap();
    service.registry.resolve(archived_id).unwrap();
    request(
        &service,
        "DELETE",
        &format!("/api/datasets/{archived_id}"),
        Value::Null,
    );
    let started = request(
        &service,
        "POST",
        "/api/training",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(started.status, 201, "{}", started.body);
    let id = started.body["run"]["id"].as_str().unwrap();
    let another = fixture(root.path(), true);
    assert_eq!(
        request(
            &another,
            "POST",
            "/api/training",
            json!({"collections":["legacy"]})
        )
        .status,
        409
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = request(&service, "GET", "/api/training", Value::Null);
        if state.body["runs"][0]["status"] == "training" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fixture supervisor did not start: {}",
            state.body
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let request_data: Value = serde_json::from_slice(
        &fs::read(
            root.path()
                .join("data/ocr-training/lab-runs")
                .join(id)
                .join("request.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(request_data["collections"][0]["id"], "legacy");
    let reservations = request_data["reservation_collections"].as_array().unwrap();
    assert!(reservations.iter().any(|row| row["id"] == "legacy"));
    assert!(reservations.iter().any(|row| row["id"] == archived_id));
    assert_eq!(request_data["collections"].as_array().unwrap().len(), 1);
    assert_eq!(request_data["epochs"], 6);
    let stopped = request(
        &another,
        "POST",
        &format!("/api/training/{id}/cancel"),
        json!({}),
    );
    assert_eq!(stopped.status, 200, "{}", stopped.body);
    assert_eq!(stopped.body["run"]["stage"], "Stopping");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = request(&service, "GET", "/api/training", Value::Null);
        if state.body["runs"][0]["status"] == "interrupted" {
            break;
        }
        assert!(Instant::now() < deadline, "fixture supervisor did not stop");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        request(
            &another,
            "POST",
            &format!("/api/training/{id}/cancel"),
            json!({})
        )
        .status,
        409
    );
}

#[test]
fn status_pid_cannot_be_used_to_signal_an_unrelated_process() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let id = "d".repeat(32);
    write_run(
        root.path(),
        &id,
        "training",
        poker_native::lab::now_ms(),
        Some(std::process::id()),
    );
    let result = request(
        &service,
        "POST",
        &format!("/api/training/{id}/cancel"),
        Value::Null,
    );
    assert_eq!(result.status, 409);
    assert!(result.body["error"]
        .as_str()
        .unwrap()
        .contains("no longer running"));
    let dir = root.path().join("data/ocr-training/lab-runs").join(&id);
    let mut run: Value = serde_json::from_slice(&fs::read(dir.join("run.json")).unwrap()).unwrap();
    run["kind"] = json!("analysis");
    run["pid"] = Value::Null;
    atomic_json(&dir.join("run.json"), &run).unwrap();
    atomic_json(
        &dir.join("supervisor.json"),
        &json!({"pid":std::process::id()}),
    )
    .unwrap();
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/cancel"),
            Value::Null
        )
        .status,
        409
    );
}

#[test]
fn version_numbers_survive_restart_and_analysis_does_not_consume_them() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let first = "1".repeat(32);
    let draft = "2".repeat(32);
    let third = "3".repeat(32);
    write_run(root.path(), &first, "completed", 1, None);
    let directory = write_run(root.path(), &draft, "completed", 2, None);
    let mut analysis: Value =
        serde_json::from_slice(&fs::read(directory.join("run.json")).unwrap()).unwrap();
    analysis["kind"] = json!("analysis");
    atomic_json(&directory.join("run.json"), &analysis).unwrap();
    write_run(root.path(), &third, "failed", 3, None);
    let state = request(&service, "GET", "/api/training", Value::Null);
    assert_eq!(state.status, 200, "{}", state.body);
    assert_eq!(state.body["runs"][0]["version"], 2);
    assert_eq!(state.body["runs"][0]["display_name"], "Version 2");
    assert_eq!(state.body["runs"][1]["version"], 1);
    assert_eq!(state.body["analyses"].as_array().unwrap().len(), 1);
    assert!(state.body["analyses"][0]["version"].is_null());
    drop(service);
    let reopened = fixture(root.path(), false);
    let state = request(&reopened, "GET", "/api/training", Value::Null);
    assert_eq!(state.body["runs"][0]["display_name"], "Version 2");
}

#[test]
fn analysis_is_separate_from_training_gate_and_snapshot_request_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let analysis = request(
        &service,
        "POST",
        "/api/training/analyze",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(analysis.status, 202, "{}", analysis.body);
    assert_eq!(analysis.body["run"]["kind"], "analysis");
    assert!(analysis.body["run"]["version"].is_null());
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training/analyze",
            json!({"collections":["legacy"]})
        )
        .status,
        409
    );
    let training = request(
        &service,
        "POST",
        "/api/training",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(training.status, 201, "{}", training.body);
    assert_eq!(training.body["run"]["version"], 1);
    let ids = [
        analysis.body["run"]["id"].as_str().unwrap(),
        training.body["run"]["id"].as_str().unwrap(),
    ];
    for (id, mode) in ids.iter().zip(["analyze", "train"]) {
        let path = root.path().join("data/ocr-training/lab-runs").join(id);
        let data: Value =
            serde_json::from_slice(&fs::read(path.join("request.json")).unwrap()).unwrap();
        assert_eq!(data["mode"], mode);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let detail = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
            if detail.body["run"]["pid"].is_u64() {
                break;
            }
            assert!(Instant::now() < deadline, "fixture did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            request(
                &service,
                "POST",
                &format!("/api/training/{id}/cancel"),
                Value::Null
            )
            .status,
            200
        );
    }
}

#[test]
fn detailed_reports_use_fixed_paths_and_bounded_log_tails() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let id = "4".repeat(32);
    let dir = write_run(root.path(), &id, "completed", 1, None);
    fs::create_dir(dir.join("bundle")).unwrap();
    atomic_json(
        &dir.join("bundle/audit.json"),
        &json!({"counts":{"train":4}}),
    )
    .unwrap();
    atomic_json(
        &dir.join("readiness.json"),
        &json!({"ready":true,"accepted":4}),
    )
    .unwrap();
    atomic_json(
        &dir.join("version.json"),
        &json!({"artifacts":{"general":{"sha256":"frozen"}}}),
    )
    .unwrap();
    atomic_json(
        &dir.join("workers.json"),
        &json!([{"role":"general","state":"completed","host":"local"}]),
    )
    .unwrap();
    fs::write(
        dir.join("supervisor.log"),
        format!("{}END", "a".repeat(30_000)),
    )
    .unwrap();
    let details = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
    assert_eq!(details.status, 200, "{}", details.body);
    assert_eq!(details.body["run"]["display_name"], "Version 1");
    assert_eq!(details.body["analysis"]["ready"], true);
    assert_eq!(details.body["audit"]["counts"]["train"], 4);
    assert_eq!(details.body["workers"][0]["state"], "completed");
    let tail = details.body["logs"]["supervisor"].as_str().unwrap();
    assert_eq!(tail.len(), 8192);
    assert!(tail.ends_with("END"));
    let mut stored: Value =
        serde_json::from_slice(&fs::read(dir.join("run.json")).unwrap()).unwrap();
    stored["analysis"] = json!({"ready":false,"blockers":["A newer live check"]});
    atomic_json(&dir.join("run.json"), &stored).unwrap();
    let latest = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
    assert_eq!(latest.body["analysis"]["ready"], false);
    assert_eq!(
        request(&service, "GET", "/api/training/../../escape", Value::Null).status,
        404
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path().join("outside.log"), dir.join("general.log"))
            .unwrap();
        fs::write(root.path().join("outside.log"), "private source").unwrap();
        let result = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
        assert_eq!(result.status, 400);
        assert!(!result.body.to_string().contains("private source"));
    }
}

#[test]
fn preparation_progress_is_bounded_validated_and_available_in_state_and_details() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let id = "77777777777777777777777777777777";
    let dir = write_run(root.path(), id, "completed", 1, None);
    let progress =
        json!({"stage":"deduplicating","completed":7,"total":12,"collection_name":"Live Review"});
    atomic_json(&dir.join("data-progress.json"), &progress).unwrap();
    assert_eq!(
        request(&service, "GET", "/api/training", Value::Null).body["runs"][0]["data_progress"],
        progress
    );
    assert_eq!(
        request(&service, "GET", &format!("/api/training/{id}"), Value::Null).body["run"]
            ["data_progress"],
        progress
    );
    for invalid in [
        json!({"stage":"shell-command"}),
        json!({"stage":"reading","completed":-1}),
        json!({"stage":"reading","completed":12,"total":7}),
        json!({"stage":"reading","unexpected":true}),
    ] {
        atomic_json(&dir.join("data-progress.json"), &invalid).unwrap();
        let response = request(&service, "GET", "/api/training", Value::Null);
        assert_eq!(response.status, 200);
        assert!(response.body["runs"][0].get("data_progress").is_none());
    }
    fs::write(dir.join("data-progress.json"), "x".repeat(16_385)).unwrap();
    assert_eq!(
        request(&service, "GET", "/api/training", Value::Null).status,
        200
    );
}

#[test]
fn queued_analysis_cancellation_releases_its_gate_without_stopping_training() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let training = request(
        &service,
        "POST",
        "/api/training",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(training.status, 201);
    let training_id = training.body["run"]["id"].as_str().unwrap();
    let analysis = request(
        &service,
        "POST",
        "/api/training/analyze",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(analysis.status, 202);
    let analysis_id = analysis.body["run"]["id"].as_str().unwrap();
    let cancelled = request(
        &service,
        "POST",
        &format!("/api/training/{analysis_id}/cancel"),
        json!({}),
    );
    assert_eq!(cancelled.status, 200, "{}", cancelled.body);
    assert_eq!(cancelled.body["run"]["status"], "interrupted");
    let next = request(
        &service,
        "POST",
        "/api/training/analyze",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(next.status, 202, "{}", next.body);
    let state = request(&service, "GET", "/api/training", Value::Null);
    assert!(matches!(
        state.body["runs"][0]["status"].as_str(),
        Some("queued" | "training")
    ));
    let next_id = next.body["run"]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{next_id}/cancel"),
            json!({})
        )
        .status,
        200
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let detail = request(
            &service,
            "GET",
            &format!("/api/training/{training_id}"),
            Value::Null,
        );
        if detail.body["run"]["pid"].is_u64() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{training_id}/cancel"),
            json!({})
        )
        .status,
        200
    );
}

#[test]
fn training_state_reads_large_reservation_ledger_and_returns_only_compact_counts() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), false);
    let tokens: serde_json::Map<String, Value> = (0..17_000)
        .map(|index| (format!("pixel:status:{index:064x}"), json!("train")))
        .collect();
    let path = root
        .path()
        .join("data/ocr-training/split-reservations.json");
    atomic_json(&path,&json!({"version":1,"tokens":tokens,"collections":{"legacy":{"reserved":37,"validation":11,"test":26,"reasons":[]}}})).unwrap();
    assert!(fs::metadata(path).unwrap().len() > 1_048_576);
    let response = request(&service, "GET", "/api/training", Value::Null);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["collections"][0]["reserved"], 37);
    assert_eq!(response.body["collections"][0]["reservations"]["test"], 26);
    assert!(response.body.to_string().len() < 16_384);
    assert!(response.body.get("tokens").is_none());
}

#[test]
fn state_exposes_cached_gpu_release_and_unambiguous_collection_counts() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let gpu = json!({"checked_at":poker_native::lab::now_ms(),"devices":[{"host":"local","gpu":"Fixture GPU","ready":true}]});
    atomic_json(&root.path().join("data/ocr-training/gpu-status.json"), &gpu).unwrap();
    let release = root.path().join("data/ocr-training/release-candidate");
    fs::create_dir_all(&release).unwrap();
    atomic_json(
        &release.join("freeze.json"),
        &json!({"weights":{"general":"a".repeat(64),"names":"b".repeat(64)}}),
    )
    .unwrap();
    let state = request(&service, "GET", "/api/training", Value::Null);
    assert_eq!(state.status, 200, "{}", state.body);
    assert_eq!(state.body["gpu_status"], gpu);
    assert_eq!(state.body["active_release"]["configured"], true);
    assert_eq!(
        state.body["active_release"]["general_sha256"],
        "a".repeat(64)
    );
    assert_eq!(state.body["collections"][0]["saved"], 0);
    assert_eq!(state.body["collections"][0]["queued"], 0);
    assert!(state.body["collections"][0]["total"].is_null());
    let probe = request(&service, "POST", "/api/training/probe", json!({}));
    assert_eq!(probe.status, 202);
    assert_eq!(probe.body["checking"], false);
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training/probe",
            json!({"host":"other"})
        )
        .status,
        400
    );
}

#[test]
fn analysis_can_report_missing_baseline_and_dead_probe_pid_does_not_block_refresh() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    fs::remove_file(
        root.path()
            .join("data/ocr-training/named-continuation/final/manifest.jsonl"),
    )
    .unwrap();
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training",
            json!({"collections":["legacy"]})
        )
        .status,
        503
    );
    let analysis = request(
        &service,
        "POST",
        "/api/training/analyze",
        json!({"collections":["legacy"]}),
    );
    assert_eq!(analysis.status, 202, "{}", analysis.body);
    let id = analysis.body["run"]["id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
        if state.body["run"]["pid"].is_u64() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/cancel"),
            Value::Null
        )
        .status,
        200
    );
    let marker = root.path().join("data/ocr-training/lab-runs/probe.json");
    atomic_json(
        &marker,
        &json!({"started_at":poker_native::lab::now_ms(),"pid":std::process::id()}),
    )
    .unwrap();
    let probe = request(&service, "POST", "/api/training/probe", Value::Null);
    assert_eq!(probe.status, 202);
    assert_eq!(probe.body["checking"], true);
    let marker: Value = serde_json::from_slice(&fs::read(marker).unwrap()).unwrap();
    assert_ne!(marker["pid"], std::process::id());
}

#[test]
fn resume_preserves_version_and_completed_work_and_archives_prior_attempt() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let id = "5".repeat(32);
    let dir = write_run(root.path(), &id, "failed", 1, None);
    fs::create_dir(dir.join("bundle")).unwrap();
    atomic_json(
        &dir.join("prepared.json"),
        &json!({"bundle":dir.join("bundle")}),
    )
    .unwrap();
    atomic_json(
        &dir.join("bundle/audit.json"),
        &json!({"training_ready":true}),
    )
    .unwrap();
    let original_request =
        json!({"id":id,"run_dir":dir,"mode":"train","collections":[{"id":"legacy"}],"epochs":6});
    atomic_json(&dir.join("request.json"), &original_request).unwrap();
    let mut prior: Value =
        serde_json::from_slice(&fs::read(dir.join("run.json")).unwrap()).unwrap();
    prior["error"] = json!("NumPy AMP failure");
    prior["workers"] =
        json!([{"role":"names","state":"completed"},{"role":"general","state":"failed"}]);
    atomic_json(&dir.join("run.json"), &prior).unwrap();
    fs::write(dir.join("cancel-requested"), "old stop").unwrap();
    let before = request(&service, "GET", "/api/training", Value::Null);
    assert_eq!(before.body["runs"][0]["can_resume"], true);
    let resumed = request(
        &service,
        "POST",
        &format!("/api/training/{id}/resume"),
        json!({}),
    );
    assert_eq!(resumed.status, 202, "{}", resumed.body);
    assert_eq!(resumed.body["run"]["id"], id);
    assert_eq!(resumed.body["run"]["display_name"], "Version 1");
    assert_eq!(resumed.body["run"]["created_at"], 1);
    assert_eq!(resumed.body["run"]["status"], "queued");
    assert_eq!(resumed.body["run"]["error"], Value::Null);
    assert_eq!(resumed.body["run"]["workers"].as_array().unwrap().len(), 1);
    assert_eq!(resumed.body["run"]["workers"][0]["role"], "names");
    assert!(!dir.join("cancel-requested").exists());
    let current_request: Value =
        serde_json::from_slice(&fs::read(dir.join("request.json")).unwrap()).unwrap();
    assert_eq!(current_request["mode"], "resume");
    assert!(current_request["attempt_id"].is_string());
    let history = fs::read_dir(dir.join("attempts"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let history: Value = serde_json::from_slice(&fs::read(history).unwrap()).unwrap();
    assert_eq!(history["run"]["error"], "NumPy AMP failure");
    assert_eq!(history["request"], original_request);
    let immediate = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
    assert_ne!(immediate.body["run"]["status"], "interrupted");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = request(&service, "GET", &format!("/api/training/{id}"), Value::Null);
        if state.body["run"]["pid"].is_u64() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/cancel"),
            Value::Null
        )
        .status,
        200
    );
}

#[test]
fn resume_rejects_options_missing_artifacts_other_kinds_and_active_training() {
    let root = tempfile::tempdir().unwrap();
    let service = fixture(root.path(), true);
    let id = "6".repeat(32);
    let dir = write_run(root.path(), &id, "failed", 1, None);
    assert_eq!(
        request(
            &service,
            "POST",
            "/api/training/not-a-run/resume",
            Value::Null
        )
        .status,
        404
    );
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/resume"),
            json!({"command":"custom"})
        )
        .status,
        400
    );
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/resume"),
            Value::Null
        )
        .status,
        409
    );
    fs::create_dir(dir.join("bundle")).unwrap();
    atomic_json(&dir.join("prepared.json"), &json!({})).unwrap();
    atomic_json(&dir.join("bundle/audit.json"), &json!({})).unwrap();
    atomic_json(&dir.join("request.json"), &json!({"id":id,"run_dir":dir})).unwrap();
    let mut run: Value = serde_json::from_slice(&fs::read(dir.join("run.json")).unwrap()).unwrap();
    run["kind"] = json!("analysis");
    atomic_json(&dir.join("run.json"), &run).unwrap();
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/resume"),
            Value::Null
        )
        .status,
        409
    );
    run["kind"] = json!("training");
    run["status"] = json!("completed");
    atomic_json(&dir.join("run.json"), &run).unwrap();
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/resume"),
            Value::Null
        )
        .status,
        409
    );
    run["status"] = json!("interrupted");
    atomic_json(&dir.join("run.json"), &run).unwrap();
    write_run(
        root.path(),
        &"7".repeat(32),
        "queued",
        poker_native::lab::now_ms(),
        None,
    );
    assert_eq!(
        request(
            &service,
            "POST",
            &format!("/api/training/{id}/resume"),
            Value::Null
        )
        .status,
        409
    );
    assert!(!dir.join("attempts").exists());
}
