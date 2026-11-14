use base64::{engine::general_purpose::STANDARD, Engine};
use poker_native::lab::{datasets::atomic_json, sha256, LabRequest, LabResponse, LabService};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
};
const ID: &str = "abcabcabcabcabcabcabcabcabcabcab";
struct Fixture {
    root: tempfile::TempDir,
    service: LabService,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let service = LabService::open_with_paths(
            root.path().join("data"),
            root.path().join("config"),
            root.path().join("tools"),
            HashMap::from([("HOME".into(), root.path().to_string_lossy().into_owned())]),
        )
        .unwrap();
        let dir = root.path().join("data/ocr-training/lab-runs").join(ID);
        fs::create_dir_all(dir.join("bundle/images")).unwrap();
        atomic_json(&dir.join("run.json"),&json!({"id":ID,"created_at":1,"collections":["legacy"],"epochs":6,"status":"completed","stage":"Done"})).unwrap();
        Self { root, service, dir }
    }
    fn request(&self, path: &str, query: &[(&str, &str)], etag: Option<&str>) -> LabResponse {
        self.service.request(LabRequest {
            method: "GET".into(),
            path: path.into(),
            query: query
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            headers: etag
                .map(|v| BTreeMap::from([("If-None-Match".into(), v.into())]))
                .unwrap_or_default(),
            body: Value::Null,
        })
    }
    fn details(&self) -> Value {
        let result = self.request(&format!("/api/training/{ID}"), &[], None);
        assert_eq!(result.status, 200, "{}", result.body);
        result.body["telemetry"].clone()
    }
    fn manifest(&self, rows: &[Value]) {
        fs::write(
            self.dir.join("bundle/manifest.jsonl"),
            rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
    }
    fn image(&self, id: &str, label: &str) -> (Value, Vec<u8>) {
        let bytes = poker_native::media::png(&image::DynamicImage::new_rgb8(4, 3)).unwrap();
        let hash = sha256(&bytes);
        let relative = format!("images/{hash}.png");
        fs::write(self.dir.join("bundle").join(&relative), &bytes).unwrap();
        (
            json!({"sample_id":id,"dataset_id":"legacy","category":"name","label":label,"image_path":relative,"file_sha256":hash}),
            bytes,
        )
    }
    fn sample(&self, id: &str) -> LabResponse {
        self.request(
            "/api/training/sample",
            &[("run", ID), ("sample_id", id)],
            None,
        )
    }
}
fn prediction(id: &str, condition: &str, prediction: &str) -> Value {
    json!({"sample_id":id,"condition":condition,"model_role":"names","category":"name","split":"test","label":"Alice","raw_prediction":prediction,"raw_exact":prediction=="Alice"})
}
#[test]
fn histories_deduplicate_stage_steps_and_bound_finite_points_without_inventing_legacy_data() {
    let f = Fixture::new();
    assert_eq!(f.details(), json!({"histories":[],"samples":[]}));
    let mut log = String::from("malformed log\n");
    for stage in 0..8 {
        for step in 0..170 {
            log += &format!(
                "POKER_TRAINING_PROGRESS {}\n",
                json!({"role":"general","stage_id":format!("stage-{stage}"),"step":step,"loss":1.0,"epoch":1})
            );
        }
    }
    log += &format!(
        "POKER_TRAINING_PROGRESS {}\n",
        json!({"role":"general","stage_id":"stage-0","step":169,"loss":0.25,"epoch":2})
    );
    log+="POKER_TRAINING_PROGRESS {\"role\":\"general\",\"stage_id\":\"stage-0\",\"step\":170,\"loss\":\"NaN\"}\n";
    log += "POKER_TRAINING_PROGRESS {\"role\":\"general\",\"step\":999,\"loss\":0.0}";
    fs::write(f.dir.join("general.log"), log).unwrap();
    let result = f.details();
    let histories = result["histories"].as_array().unwrap();
    assert_eq!(histories.len(), 6);
    let points = histories[0]["points"].as_array().unwrap();
    assert_eq!(points.len(), 160);
    assert_eq!(points[0]["step"], 10);
    assert_eq!(points.last().unwrap()["loss"], 0.25);
    assert_eq!(points.last().unwrap()["epoch"], 2);
}
#[test]
fn benchmarks_pair_complete_records_by_sample_and_condition_and_never_use_other_pass_log_counts() {
    let f = Fixture::new();
    let (row, _) = f.image("case:1", "Alice");
    f.manifest(&[row]);
    for pass in ["baseline", "candidate"] {
        fs::create_dir_all(f.dir.join("benchmarks").join(pass).join("identity")).unwrap();
        atomic_json(
            &f.dir.join("benchmarks").join(pass).join("protocol.json"),
            &json!({"samples":10,"conditions":["identity","jpeg80"]}),
        )
        .unwrap();
    }
    let baseline = [
        prediction("case:2", "identity", "Bob"),
        prediction("case:1", "identity", "Alice"),
    ];
    fs::write(
        f.dir.join("benchmarks/baseline/identity/predictions.jsonl"),
        baseline
            .iter()
            .map(|v| format!("{v}\n"))
            .collect::<String>(),
    )
    .unwrap();
    fs::write(
        f.dir
            .join("benchmarks/candidate/identity/predictions.jsonl"),
        format!(
            "{}\n{}\n{{\"sample_id\":\"partial\"",
            prediction("case:1", "identity", "A1ice"),
            prediction("wrong-condition", "jpeg80", "Alice")
        ),
    )
    .unwrap();
    fs::write(
        f.dir.join("benchmark.log"),
        "{\"condition\":\"identity\",\"processed\":500,\"total\":1000}\n",
    )
    .unwrap();
    let result = f.details();
    let benchmark = &result["benchmark"];
    assert_eq!(benchmark["pass"], "candidate");
    assert_eq!(benchmark["processed"], 1);
    assert_eq!(benchmark["total"], 10);
    let cases = benchmark["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0]["sample_id"], "case:1");
    assert_eq!(cases[0]["baseline_prediction"], "Alice");
    assert_eq!(cases[0]["candidate_prediction"], "A1ice");
    assert_eq!(cases[0]["baseline_exact"], true);
    assert_eq!(cases[0]["candidate_exact"], false);
    assert!(cases[0]["image_url"]
        .as_str()
        .unwrap()
        .starts_with("/api/training/sample?"));
    fs::write(
        f.dir.join("benchmarks/baseline/identity/predictions.jsonl"),
        format!("{}\n", prediction("different", "identity", "Alice")),
    )
    .unwrap();
    assert!(f.details()["benchmark"]["cases"][0]["baseline_prediction"].is_null());
    let mut changed_truth = prediction("case:1", "identity", "Eve");
    changed_truth["label"] = json!("Eve");
    changed_truth["raw_exact"] = json!(true);
    fs::write(
        f.dir.join("benchmarks/baseline/identity/predictions.jsonl"),
        format!("{changed_truth}\n"),
    )
    .unwrap();
    let result = f.details();
    assert!(result["benchmark"]["cases"][0]["baseline_prediction"].is_null());
    assert!(result["benchmark"]["cases"][0]["baseline_exact"].is_null());
}
#[test]
fn previews_are_frozen_hash_verified_cacheable_and_invalidate_manifest_index() {
    let f = Fixture::new();
    let (row, bytes) = f.image("sample/[1]?", "Alice");
    f.manifest(&[row.clone()]);
    let result = f.sample("sample/[1]?");
    assert_eq!(result.status, 200, "{}", result.body);
    assert_eq!(STANDARD.decode(result.body_base64.unwrap()).unwrap(), bytes);
    let etag = result.headers["ETag"].clone();
    assert_eq!(
        f.request(
            "/api/training/sample",
            &[("run", ID), ("sample_id", "sample/[1]?")],
            Some(&etag)
        )
        .status,
        304
    );
    let mut replaced = row.clone();
    replaced["sample_id"] = json!("changed");
    f.manifest(&[replaced]);
    assert_eq!(f.sample("sample/[1]?").status, 404);
    assert_eq!(f.sample("changed").status, 200);
    fs::write(
        f.dir
            .join("bundle")
            .join(row["image_path"].as_str().unwrap()),
        b"tampered",
    )
    .unwrap();
    assert_eq!(f.sample("changed").status, 409);
}
#[test]
fn frozen_previews_reject_escape_symlinks_ambiguity_and_unknown_runs() {
    let f = Fixture::new();
    let (mut row, bytes) = f.image("sample", "Alice");
    fs::write(f.root.path().join("outside.png"), &bytes).unwrap();
    row["image_path"] = json!("../../../../outside.png");
    f.manifest(&[row.clone()]);
    assert_eq!(f.sample("sample").status, 400);
    row["image_path"] = json!(f.root.path().join("outside.png"));
    f.manifest(&[row.clone()]);
    assert_eq!(f.sample("sample").status, 400);
    #[cfg(unix)]
    {
        let path = f.dir.join("bundle/images/link.png");
        std::os::unix::fs::symlink(f.root.path().join("outside.png"), &path).unwrap();
        row["image_path"] = json!("images/link.png");
        f.manifest(&[row.clone()]);
        assert_eq!(f.sample("sample").status, 400);
    }
    let (row, _) = f.image("duplicate", "Alice");
    f.manifest(&[row.clone(), row]);
    assert_eq!(f.sample("duplicate").status, 409);
    assert_eq!(
        f.request(
            "/api/training/sample",
            &[("run", "../outside"), ("sample_id", "sample")],
            None
        )
        .status,
        404
    );
}
#[test]
fn sample_and_case_counts_remain_bounded() {
    let f = Fixture::new();
    let (template, _) = f.image("sample", "Alice");
    let rows: Vec<_> = (0..40)
        .map(|n| {
            let mut row = template.clone();
            row["sample_id"] = json!(format!("sample:{n}"));
            row
        })
        .collect();
    f.manifest(&rows);
    let path = f.dir.join("benchmarks/candidate/identity");
    fs::create_dir_all(&path).unwrap();
    atomic_json(
        &path.parent().unwrap().join("protocol.json"),
        &json!({"samples":40,"conditions":["identity"]}),
    )
    .unwrap();
    fs::write(
        path.join("predictions.jsonl"),
        (0..40)
            .map(|n| {
                format!(
                    "{}\n",
                    prediction(&format!("sample:{n}"), "identity", "Alice")
                )
            })
            .collect::<String>(),
    )
    .unwrap();
    let result = f.details();
    assert_eq!(result["samples"].as_array().unwrap().len(), 4);
    assert_eq!(result["benchmark"]["cases"].as_array().unwrap().len(), 16);
    assert_eq!(result["benchmark"]["processed"], 40);
}

#[test]
fn benchmark_evidence_balances_roles_and_prioritizes_only_comparable_completed_changes() {
    for general_first in [true, false] {
        let f = Fixture::new();
        let mut baseline = Vec::new();
        let mut candidate = Vec::new();
        let roles = if general_first {
            ["general", "names"]
        } else {
            ["names", "general"]
        };
        for role in roles {
            for n in 0..30 {
                let id = format!("{role}:{n}");
                let mut before =
                    prediction(&id, "identity", if n == 2 { "A1ice" } else { "Alice" });
                let mut after = prediction(&id, "identity", if n < 2 { "A1ice" } else { "Alice" });
                for row in [&mut before, &mut after] {
                    row["model_role"] = json!(role);
                    row["category"] = json!(if role == "names" { "name" } else { "status" });
                }
                if n == 3 {
                    before["label"] = json!("Eve");
                    before["raw_prediction"] = json!("Eve");
                    after["raw_prediction"] = json!("A1ice");
                    after["raw_exact"] = json!(false);
                }
                baseline.push(before);
                candidate.push(after);
            }
        }
        for (pass, rows) in [("baseline", baseline), ("candidate", candidate)] {
            let path = f.dir.join("benchmarks").join(pass).join("identity");
            fs::create_dir_all(&path).unwrap();
            atomic_json(
                &path.parent().unwrap().join("protocol.json"),
                &json!({"samples":60,"conditions":["identity"]}),
            )
            .unwrap();
            fs::write(
                path.join("predictions.jsonl"),
                rows.iter()
                    .map(|row| format!("{row}\n"))
                    .collect::<String>(),
            )
            .unwrap();
        }
        let value = f.details();
        let cases = value["benchmark"]["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 16);
        for role in ["general", "names"] {
            assert_eq!(cases.iter().filter(|case| case["role"] == role).count(), 8);
            for n in 0..3 {
                assert!(cases
                    .iter()
                    .any(|case| case["sample_id"] == format!("{role}:{n}")));
            }
            assert!(!cases
                .iter()
                .any(|case| case["sample_id"] == format!("{role}:3")));
        }
        // An unfinished pass shows genuine recent observations in each role, without
        // presenting the older changed cases as the current stream.
        atomic_json(
            &f.dir.join("benchmarks/candidate/protocol.json"),
            &json!({"samples":61,"conditions":["identity"]}),
        )
        .unwrap();
        let value = f.details();
        let cases = value["benchmark"]["cases"].as_array().unwrap();
        for role in ["general", "names"] {
            assert_eq!(cases.iter().filter(|case| case["role"] == role).count(), 8);
            assert!(cases
                .iter()
                .any(|case| case["sample_id"] == format!("{role}:29")));
            assert!(!cases
                .iter()
                .any(|case| case["sample_id"] == format!("{role}:0")));
        }
    }
}

#[test]
fn details_condition_selection_is_exact_validated_and_cache_isolated() {
    let f = Fixture::new();
    let path = f.dir.join("benchmarks/candidate");
    fs::create_dir_all(&path).unwrap();
    atomic_json(
        &path.join("protocol.json"),
        &json!({"samples":1,"conditions":["identity","jpeg80","scale60"]}),
    )
    .unwrap();
    for condition in ["identity", "jpeg80"] {
        fs::create_dir_all(path.join(condition)).unwrap();
        fs::write(
            path.join(condition).join("predictions.jsonl"),
            format!("{}\n", prediction(condition, condition, "Alice")),
        )
        .unwrap();
    }
    let route = format!("/api/training/{ID}");
    for condition in ["identity", "jpeg80", "identity", "jpeg80"] {
        let result = f.request(&route, &[("condition", condition)], None);
        assert_eq!(result.status, 200);
        assert_eq!(
            result.body["telemetry"]["benchmark"]["condition"],
            condition
        );
        assert_eq!(
            result.body["telemetry"]["benchmark"]["cases"][0]["sample_id"],
            condition
        );
    }
    assert_eq!(f.details()["benchmark"]["condition"], "jpeg80");
    let absent = f.request(&route, &[("condition", "scale60")], None);
    assert_eq!(absent.status, 200);
    assert!(absent.body["telemetry"].get("benchmark").is_none());
    for condition in ["unknown", "../identity", "", "Identity"] {
        assert_eq!(
            f.request(&route, &[("condition", condition)], None).status,
            400
        );
    }
    assert_eq!(
        f.request(&route, &[("other", "identity")], None).status,
        400
    );
}

#[test]
fn previews_represent_exact_selected_collection_identities_and_invalidate_on_selection_change() {
    let f = Fixture::new();
    let (template, _) = f.image("template", "Alice");
    let mut rows = Vec::new();
    for collection in ["baseline", "unknown", "legacy", "live"] {
        for n in 0..10 {
            let mut row = template.clone();
            row["sample_id"] = json!(format!("{collection}:{n}"));
            row["dataset_id"] = json!(collection);
            rows.push(row);
        }
    }
    f.manifest(&rows);
    let run_path = f.dir.join("run.json");
    let mut run: Value = serde_json::from_slice(&fs::read(&run_path).unwrap()).unwrap();
    run["collections"] = json!(["legacy", "live"]);
    atomic_json(&run_path, &run).unwrap();
    let result = f.details();
    let samples = result["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 8);
    for collection in ["legacy", "live"] {
        assert_eq!(
            samples
                .iter()
                .filter(|row| row["collection_id"] == collection)
                .count(),
            4
        );
    }
    assert!(samples.iter().all(|row| row["sample_id"]
        .as_str()
        .unwrap()
        .starts_with(row["collection_id"].as_str().unwrap())));
    run["collections"] = json!(["live"]);
    atomic_json(&run_path, &run).unwrap();
    let result = f.details();
    assert_eq!(result["samples"].as_array().unwrap().len(), 4);
    assert!(result["samples"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["collection_id"] == "live"));
    let mut unavailable = template;
    unavailable["dataset_id"] = json!("live");
    unavailable["image_path"] = json!("images/missing.png");
    f.manifest(&[unavailable]);
    assert_eq!(f.details()["samples"], json!([]));
}
