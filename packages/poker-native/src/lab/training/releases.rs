use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;

fn persist_selection(config: &Path, value: &Value) -> LabResult<()> {
    datasets::plain(config)?;
    let path = config.join("ocr-model.json");
    if fs::symlink_metadata(&path).is_ok() {
        checked(config, &path)?;
    }
    let temporary = config.join(format!(".ocr-model-{}.tmp", uuid()));
    let result = (|| -> LabResult<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        if let Ok(directory) = File::open(config) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(crate) fn selected_release(config: &Path, training: &Path) -> LabResult<Option<PathBuf>> {
    let Some(value) = read_optional_json(&config.join("ocr-model.json"), 65_536)? else {
        return Ok(None);
    };
    let name = value["release"]
        .as_str()
        .ok_or_else(|| unavailable("Saved OCR model selection is invalid"))?;
    if name.len() != 32
        || !name
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(unavailable("Saved OCR model selection is invalid"));
    }
    let root = training.join("releases").join(name);
    checked(&root, &root.join("freeze.json"))?;
    if file_hash(&root.join("freeze.json"))? != value["freeze_sha256"].as_str().unwrap_or("") {
        return Err(unavailable("Saved OCR release manifest has changed"));
    }
    Ok(Some(root))
}

fn checked(root: &Path, path: &Path) -> LabResult<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| bad("OCR artifact is outside its version"))?;
    datasets::plain(root)?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(bad("Invalid OCR artifact path"));
        }
        current.push(part);
        datasets::plain(&current)?;
    }
    if !path.is_file() {
        return Err(unavailable("An OCR model artifact is missing"));
    }
    Ok(())
}

fn file_hash(path: &Path) -> LabResult<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    if size == 0 || size > 512 * 1024 * 1024 {
        return Err(unavailable("OCR artifact size is invalid"));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn pin(root: &Path, path: &Path, expected: &Value, hashes: bool) -> LabResult<()> {
    checked(root, path)?;
    let expected = expected
        .as_str()
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or_else(|| unavailable("OCR model artifact has no valid version hash"))?;
    if hashes && file_hash(path)? != expected {
        return Err(conflict(
            "OCR model artifacts changed after their benchmark",
        ));
    }
    Ok(())
}

pub(super) struct Candidate {
    id: String,
    label: String,
    root: PathBuf,
    models: Value,
    freeze: Value,
    benchmark: Option<Value>,
    regressions: u64,
    improved: u64,
}

fn measured_metrics(rows: &[&Value]) -> LabResult<Value> {
    let mut latency: Vec<f64> = rows
        .iter()
        .map(|r| r["inference_ms"].as_f64().unwrap())
        .collect();
    latency.sort_by(f64::total_cmp);
    let mut edits = 0;
    let mut characters = 0;
    for row in rows {
        let label: Vec<_> = row["label"].as_str().unwrap().chars().collect();
        let text: Vec<_> = row["raw_prediction"].as_str().unwrap().chars().collect();
        if label.len() > 4096 || text.len() > 4096 {
            return Err(conflict("Baseline text exceeds its size limit"));
        }
        characters += label.len();
        let mut previous: Vec<_> = (0..=text.len()).collect();
        for (i, a) in label.iter().enumerate() {
            let mut current = vec![i + 1];
            for (j, b) in text.iter().enumerate() {
                current.push(
                    (previous[j + 1] + 1)
                        .min(current[j] + 1)
                        .min(previous[j] + usize::from(a != b)),
                );
            }
            previous = current;
        }
        edits += previous[text.len()];
    }
    Ok(
        json!({"samples":rows.len(),"exact_match":rows.iter().filter(|r|r["raw_exact"]==true).count() as f64/rows.len() as f64,"cer":edits as f64/characters.max(1) as f64,"p95_ms":latency[((latency.len()-1) as f64*0.95).ceil() as usize],"processing_errors":0,"regressions":0,"improved":0}),
    )
}

fn read_rows(root: &Path, path: &Path) -> LabResult<Vec<Value>> {
    checked(root, path)?;
    let mut raw = String::new();
    File::open(path)?
        .take(32 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)?;
    if raw.len() > 32 * 1024 * 1024 {
        return Err(conflict("Benchmark evidence exceeds its size limit"));
    }
    Ok(raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?)
}

impl TrainingManager {
    fn baseline_benchmark(&self, freeze: &Value, runs: &[Value]) -> Option<(Value, String)> {
        for run in runs.iter().rev() {
            let result = (|| -> LabResult<Value> {
                self.release_candidate(run, false)?;
                let root = self.run_path(run["id"].as_str().unwrap_or(""))?;
                let protocol =
                    read_optional_json(&root.join("benchmarks/baseline/protocol.json"), 8_388_608)?
                        .ok_or_else(|| unavailable("Baseline benchmark protocol is missing"))?;
                let version = read_optional_json(&root.join("version.json"), 8_388_608)?
                    .ok_or_else(|| unavailable("Version evidence is missing"))?;
                if protocol["manifest_sha256"] != version["test_sha256"] {
                    return Err(conflict("Baseline test manifest differs"));
                }
                pin(
                    &root,
                    &root.join("bundle/test.jsonl"),
                    &protocol["manifest_sha256"],
                    true,
                )?;
                let manifest = read_rows(&root, &root.join("bundle/test.jsonl"))?;
                let mut expected_ids = std::collections::BTreeMap::new();
                for row in manifest {
                    let id = row["sample_id"]
                        .as_str()
                        .ok_or_else(|| conflict("Frozen benchmark identity is missing"))?;
                    let role = if row["category"] == "name" {
                        "names"
                    } else {
                        "general"
                    };
                    if row["split"] != "test"
                        || expected_ids
                            .insert(
                                id.to_owned(),
                                json!([
                                    row["label"],
                                    row["category"],
                                    role,
                                    row["pixel_sha256"],
                                    row["file_sha256"]
                                ]),
                            )
                            .is_some()
                    {
                        return Err(conflict("Frozen benchmark manifest is invalid"));
                    }
                }
                for role in ["general", "names"] {
                    for (name, section) in [
                        ("model.onnx", "weights"),
                        ("characters.json", "characters_sha256"),
                    ] {
                        if protocol["models"][role]["sha256"][name] != freeze[section][role] {
                            return Err(conflict("Baseline benchmark belongs to different models"));
                        }
                    }
                }
                let mut results = Vec::new();
                let mut identity = None;
                let mut identities = None;
                for condition in ["identity", "brightness_minus30", "jpeg80", "scale60"] {
                    let path = root
                        .join("benchmarks/baseline")
                        .join(condition)
                        .join("predictions.jsonl");
                    checked(&root, &path)?;
                    let rows = read_rows(&root, &path)?;
                    if rows.is_empty() || Some(rows.len() as u64) != protocol["samples"].as_u64() {
                        return Err(conflict("Baseline benchmark sample count differs"));
                    }
                    let mut ids = std::collections::BTreeMap::new();
                    for row in &rows {
                        let label = row["label"]
                            .as_str()
                            .ok_or_else(|| conflict("Baseline label is invalid"))?;
                        let prediction = row["raw_prediction"]
                            .as_str()
                            .ok_or_else(|| conflict("Baseline prediction is invalid"))?;
                        let role = if row["category"] == "name" {
                            "names"
                        } else {
                            "general"
                        };
                        let id = row["sample_id"]
                            .as_str()
                            .ok_or_else(|| conflict("Baseline sample identity is invalid"))?;
                        if row["condition"] != condition
                            || row["split"] != "test"
                            || row["model_role"] != role
                            || row.get("error").is_some_and(|v| !v.is_null() && v != "")
                            || row["raw_exact"] != json!(label == prediction)
                            || !row["inference_ms"]
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && n >= 0.0)
                        {
                            return Err(conflict("Baseline benchmark row is invalid"));
                        }
                        if ids
                            .insert(
                                id.to_owned(),
                                json!([
                                    row["label"],
                                    row["category"],
                                    row["model_role"],
                                    row["pixel_sha256"],
                                    row["file_sha256"]
                                ]),
                            )
                            .is_some()
                        {
                            return Err(conflict("Baseline sample identities are repeated"));
                        }
                    }
                    if let Some(expected) = &identities {
                        if &ids != expected {
                            return Err(conflict(
                                "Baseline sample identities differ across conditions",
                            ));
                        }
                    } else {
                        if ids != expected_ids {
                            return Err(conflict(
                                "Baseline rows differ from frozen benchmark labels or pixels",
                            ));
                        }
                        identities = Some(ids);
                    }
                    for role in ["general", "names"] {
                        let group: Vec<_> =
                            rows.iter().filter(|r| r["model_role"] == role).collect();
                        if group.is_empty() {
                            return Err(conflict("Baseline role benchmark is empty"));
                        }
                        let mut result = measured_metrics(&group)?;
                        result["role"] = json!(role);
                        result["condition"] = json!(condition);
                        result["category"] = json!("all");
                        results.push(result);
                    }
                    if condition == "identity" {
                        identity = Some(measured_metrics(&rows.iter().collect::<Vec<_>>())?);
                    }
                }
                let mut summary = identity.unwrap();
                if summary["exact_match"] != version["benchmark"]["baseline_exact_match"]
                    || summary["samples"] != version["benchmark"]["samples"]
                {
                    return Err(conflict(
                        "Measured baseline metrics differ from completed comparison",
                    ));
                }
                summary["results"] = json!(results);
                Ok(summary)
            })();
            if let Ok(value) = result {
                return Some((value, run["id"].as_str().unwrap().into()));
            }
        }
        None
    }
    pub(super) fn base_release(&self) -> PathBuf {
        self.environment
            .get("OCR_MODEL_RELEASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.training_root.join("release-candidate"))
    }

    fn release_candidate(&self, run: &Value, hashes: bool) -> LabResult<Candidate> {
        let id = run["id"]
            .as_str()
            .ok_or_else(|| bad("Invalid OCR version"))?;
        let root = self.run_path(id)?;
        if run["status"] != "completed" || run["kind"] == "analysis" {
            return Err(conflict(
                "This OCR version has not completed training and benchmarking",
            ));
        }
        let version = read_optional_json(&root.join("version.json"), 8_388_608)?
            .ok_or_else(|| unavailable("OCR version manifest is missing"))?;
        let benchmark = read_optional_json(&root.join("benchmark.json"), 8_388_608)?
            .ok_or_else(|| unavailable("OCR benchmark is missing"))?;
        if version["id"] != id
            || version["benchmark"] != benchmark
            || benchmark["processing_errors"] != 0
            || benchmark["samples"].as_u64().unwrap_or(0) == 0
        {
            return Err(conflict(
                "OCR benchmark evidence is incomplete or differs from its version",
            ));
        }
        let protocol =
            read_optional_json(&root.join("benchmarks/candidate/protocol.json"), 8_388_608)?
                .ok_or_else(|| unavailable("OCR benchmark protocol is missing"))?;
        if protocol["manifest_sha256"] != version["test_sha256"] {
            return Err(conflict(
                "OCR benchmark test manifest differs from its version",
            ));
        }
        let rows = benchmark["results"]
            .as_array()
            .ok_or_else(|| conflict("OCR role and stress benchmarks are missing"))?;
        let mut regressions = 0;
        let mut improved = 0;
        for role in ["general", "names"] {
            for condition in ["identity", "brightness_minus30", "jpeg80", "scale60"] {
                let matching: Vec<_> = rows
                    .iter()
                    .filter(|row| {
                        row["role"] == role
                            && row["condition"] == condition
                            && row["category"] == "all"
                    })
                    .collect();
                if matching.len() != 1 {
                    return Err(conflict("OCR role and stress benchmarks are incomplete"));
                }
                let row = matching[0];
                if row["samples"].as_u64().unwrap_or(0) == 0
                    || row["processing_errors"] != 0
                    || !["exact_match", "baseline_exact_match"].iter().all(|key| {
                        row[*key]
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                    })
                {
                    return Err(conflict(
                        "OCR benchmark contains invalid results or processing errors",
                    ));
                }
                regressions += row["regressions"]
                    .as_u64()
                    .ok_or_else(|| conflict("OCR regression evidence is missing"))?;
                improved += row["improved"]
                    .as_u64()
                    .ok_or_else(|| conflict("OCR improvement evidence is missing"))?;
            }
        }
        let bundle = root.join("bundle");
        pin(
            &bundle,
            &bundle.join("test.jsonl"),
            &version["test_sha256"],
            hashes,
        )?;
        for role in ["general", "names"] {
            for name in ["model.onnx", "characters.json"] {
                let relative = format!("portable/{name}");
                let expected = &version["artifacts"][role][&relative];
                if protocol["models"][role]["sha256"][name] != *expected {
                    return Err(conflict("OCR exported model differs from its benchmark"));
                }
                pin(
                    &bundle,
                    &bundle.join(role).join(&relative),
                    expected,
                    hashes,
                )?;
            }
            if version["artifacts"][role]
                .get("selected.pdparams")
                .is_some()
            {
                for name in ["selected.pdparams", "model-selection.json"] {
                    pin(
                        &bundle,
                        &bundle.join(role).join(name),
                        &version["artifacts"][role][name],
                        hashes,
                    )?;
                }
                let selected =
                    read_optional_json(&bundle.join(role).join("model-selection.json"), 1_048_576)?
                        .ok_or_else(|| conflict("OCR model selection receipt is missing"))?;
                if selected["role"] != role
                    || selected["selected_checkpoint_sha256"]
                        != version["artifacts"][role]["selected.pdparams"]
                {
                    return Err(conflict("OCR selected checkpoint differs from its receipt"));
                }
            }
        }
        let mut freeze =
            json!({"weights":{},"characters_sha256":{},"id":id,"display_name":run["display_name"]});
        freeze["source"] = json!({"version_id":id,"version_manifest_sha256":file_hash(&root.join("version.json"))?,"benchmark_sha256":file_hash(&root.join("benchmark.json"))?,"benchmark_protocol_sha256":file_hash(&root.join("benchmarks/candidate/protocol.json"))?,"test_sha256":version["test_sha256"],"selected_artifacts":version["artifacts"]});
        for role in ["general", "names"] {
            freeze["weights"][role] = version["artifacts"][role]["portable/model.onnx"].clone();
            freeze["characters_sha256"][role] =
                version["artifacts"][role]["portable/characters.json"].clone();
        }
        Ok(Candidate {
            id: id.into(),
            label: run["display_name"].as_str().unwrap_or("OCR version").into(),
            root: bundle,
            models: json!({"general_model":"models/general","name_model":"models/names"}),
            freeze,
            benchmark: Some(benchmark),
            regressions,
            improved,
        })
    }

    fn baseline_candidate(&self, hashes: bool) -> LabResult<Candidate> {
        let root = self.base_release();
        let freeze = read_optional_json(&root.join("freeze.json"), 1_048_576)?
            .ok_or_else(|| unavailable("Original OCR release freeze is missing"))?;
        let models = read_optional_json(&root.join("runtime.json"), 1_048_576)?
            .ok_or_else(|| unavailable("Original OCR release configuration is missing"))?;
        for (role, key) in [("general", "general_model"), ("names", "name_model")] {
            let relative = models[key]
                .as_str()
                .ok_or_else(|| conflict("Original OCR model path is missing"))?;
            for (name, section) in [
                ("model.onnx", "weights"),
                ("characters.json", "characters_sha256"),
            ] {
                pin(
                    &root,
                    &root.join(relative).join(name),
                    &freeze[section][role],
                    hashes,
                )?;
            }
        }
        Ok(Candidate {
            id: "baseline".into(),
            label: "Original active models".into(),
            root,
            models,
            freeze,
            benchmark: None,
            regressions: 0,
            improved: 0,
        })
    }

    pub(super) fn version_catalog(&self) -> LabResult<Value> {
        let active = self.active_release();
        let mut versions = Vec::new();
        let mut runs = self.runs()?;
        runs.retain(|run| run["kind"] != "analysis");
        let baseline_metrics = self
            .baseline_candidate(false)
            .ok()
            .and_then(|candidate| self.baseline_benchmark(&candidate.freeze, &runs));
        runs.insert(
            0,
            json!({"id":"baseline","display_name":"Original active models","created_at":0}),
        );
        for run in runs {
            let id = run["id"].as_str().unwrap_or("");
            let candidate = if id == "baseline" {
                self.baseline_candidate(false)
            } else {
                self.release_candidate(&run, false)
            };
            let mut entry = json!({"id":id,"display_name":run["display_name"],"created_at":run["created_at"],"active":active["id"]==id,"eligible":candidate.is_ok(),"regressions":0,"improved":0});
            match candidate {
                Ok(value) => {
                    entry["regressions"] = json!(value.regressions);
                    entry["improved"] = json!(value.improved);
                    if let Some(benchmark) = value.benchmark {
                        entry["benchmark"] = benchmark;
                    }
                }
                Err(error) => entry["reason"] = json!(error.message),
            }
            if id == "baseline" {
                if let Some((benchmark, source)) = &baseline_metrics {
                    entry["benchmark"] = benchmark.clone();
                    entry["benchmark_source_id"] = json!(source);
                }
            }
            versions.push(entry);
        }
        Ok(json!({"active_release":active,"versions":versions}))
    }

    pub(super) fn activate(&self, body: &Value) -> LabResult<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Activation {
            id: String,
            #[serde(default)]
            acknowledge_regressions: bool,
        }
        let request: Activation = parse(body)?;
        let model = self
            .model
            .as_ref()
            .ok_or_else(|| unavailable("OCR runtime switching is unavailable"))?;
        let config = self
            .config_root
            .as_ref()
            .ok_or_else(|| unavailable("OCR configuration is unavailable"))?;
        let candidate = if request.id == "baseline" {
            self.baseline_candidate(true)?
        } else {
            self.run_path(&request.id)?;
            let runs = self.runs()?;
            self.release_candidate(
                runs.iter()
                    .find(|run| run["id"] == request.id)
                    .ok_or_else(|| not_found("Unknown OCR version"))?,
                true,
            )?
        };
        if candidate.regressions > 0 && !request.acknowledge_regressions {
            return Err(conflict(
                "Review the benchmark regressions before selecting this version",
            ));
        }
        let releases = self.training_root.join("releases");
        fs::create_dir_all(&releases)?;
        datasets::plain(&releases)?;
        let directory = releases.join(uuid());
        fs::create_dir(&directory)?;
        let staged = (|| -> LabResult<()> {
            for (role, key) in [("general", "general_model"), ("names", "name_model")] {
                let source = if candidate.id == "baseline" {
                    candidate.root.join(candidate.models[key].as_str().unwrap())
                } else {
                    candidate.root.join(role).join("portable")
                };
                let target = directory.join("models").join(role);
                fs::create_dir_all(&target)?;
                for name in ["model.onnx", "characters.json"] {
                    fs::copy(source.join(name), target.join(name))?;
                    File::open(target.join(name))?.sync_all()?;
                    let section = if name == "model.onnx" {
                        "weights"
                    } else {
                        "characters_sha256"
                    };
                    pin(
                        &directory,
                        &target.join(name),
                        &candidate.freeze[section][role],
                        true,
                    )?;
                }
            }
            let mut freeze = candidate.freeze.clone();
            freeze["id"] = json!(candidate.id);
            freeze["display_name"] = json!(candidate.label);
            datasets::atomic_json(&directory.join("freeze.json"), &freeze)?;
            datasets::atomic_json(
                &directory.join("runtime.json"),
                &json!({"general_model":"models/general","name_model":"models/names"}),
            )?;
            let selection = json!({"release":directory.file_name().unwrap().to_string_lossy(),"freeze_sha256":file_hash(&directory.join("freeze.json"))?,"selected_at":now_ms(),"id":candidate.id});
            model.activate_release(directory.clone(), || persist_selection(config, &selection))?;
            Ok(())
        })();
        if staged.is_err() {
            let _ = fs::remove_dir_all(&directory);
        }
        staged?;
        Ok(json!({"active_release":self.active_release()}))
    }
}
