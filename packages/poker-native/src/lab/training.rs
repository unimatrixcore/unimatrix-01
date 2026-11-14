use super::{
    bad, conflict, datasets, not_found, now_ms, parse, unavailable, uuid, LabRequest, LabResponse,
    LabResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

const ACTIVE: &[&str] = &["queued", "preparing", "training", "benchmarking"];
pub(crate) mod releases;
mod telemetry;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartTraining {
    collections: Vec<String>,
    #[serde(default = "default_epochs")]
    epochs: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DataStage {
    Reading,
    Validating,
    Deduplicating,
    Reserving,
    Ready,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DataProgress {
    stage: DataStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    collection_name: Option<String>,
}

fn data_progress(dir: &Path) -> Option<Value> {
    let value = read_optional_json(&dir.join("data-progress.json"), 16_384)
        .ok()
        .flatten()?;
    let value: DataProgress = serde_json::from_value(value).ok()?;
    if value.completed.is_some_and(|n| n > 1_000_000_000)
        || value.total.is_some_and(|n| n > 1_000_000_000)
        || value
            .completed
            .zip(value.total)
            .is_some_and(|(done, total)| done > total)
        || value
            .collection_name
            .as_ref()
            .is_some_and(|name| name.encode_utf16().count() > 100)
    {
        return None;
    }
    serde_json::to_value(value).ok()
}

fn default_epochs() -> u32 {
    6
}

pub struct TrainingManager {
    root: PathBuf,
    training_root: PathBuf,
    tools_root: PathBuf,
    python: PathBuf,
    environment: HashMap<String, String>,
    registry: Arc<datasets::DatasetRegistry>,
    operation: Mutex<()>,
    model: Option<Arc<super::model::ModelRuntime>>,
    config_root: Option<PathBuf>,
    telemetry: telemetry::Reader,
}

struct RunLock(File);

#[cfg(unix)]
impl Drop for RunLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

impl TrainingManager {
    pub fn new(
        data_root: PathBuf,
        tools_root: PathBuf,
        registry: Arc<datasets::DatasetRegistry>,
        environment: HashMap<String, String>,
    ) -> LabResult<Self> {
        let training_root = data_root.join("ocr-training");
        let root = training_root.join("lab-runs");
        fs::create_dir_all(&root)?;
        datasets::plain(&root)?;
        let python = environment
            .get("OCR_TRAINING_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let training = training_root.join("desktop-train-gpu/bin/python");
                if training.is_file() {
                    training
                } else {
                    training_root.join("runtime-venv/bin/python")
                }
            });
        Ok(Self {
            root,
            training_root,
            tools_root,
            python,
            environment,
            registry,
            operation: Mutex::new(()),
            model: None,
            config_root: None,
            telemetry: telemetry::Reader::default(),
        })
    }

    pub(crate) fn with_runtime(
        mut self,
        model: Arc<super::model::ModelRuntime>,
        config_root: PathBuf,
    ) -> Self {
        self.model = Some(model);
        self.config_root = Some(config_root);
        self
    }

    fn lock(&self) -> LabResult<RunLock> {
        let path = self.root.join(".lock");
        if path.exists() {
            datasets::plain(&path)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(RunLock(file))
    }

    fn script(&self) -> PathBuf {
        self.tools_root
            .join("dev_tools/training/lab_training_job.py")
    }

    fn supervisor_error(&self) -> Option<String> {
        if !self.python.is_absolute() || !self.python.is_file() {
            return Some("OCR training Python is unavailable. Restore desktop-train-gpu or set OCR_TRAINING_PYTHON to its absolute interpreter path.".into());
        }
        if !self.script().is_file() {
            return Some("The OCR training supervisor is missing from the Poker Lab tools.".into());
        }
        None
    }

    fn setup_error(&self) -> Option<String> {
        if let Some(error) = self.supervisor_error() {
            return Some(error);
        }
        let baseline = self.training_root.join("named-continuation/final");
        for name in [
            "manifest.jsonl",
            "dictionary.txt",
            "general/train.yml",
            "names/train.yml",
            "general/checkpoints/best_accuracy.pdparams",
        ] {
            if !baseline.join(name).is_file() {
                return Some(format!(
                    "OCR training baseline is missing: {}",
                    baseline.join(name).display()
                ));
            }
        }
        None
    }

    fn run_path(&self, id: &str) -> LabResult<PathBuf> {
        if id.len() != 32
            || !id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(not_found("Unknown training run"));
        }
        let path = self.root.join(id);
        if !path.is_dir() {
            return Err(not_found("Unknown training run"));
        }
        datasets::plain(&path)?;
        Ok(path)
    }

    fn read_run(&self, dir: &Path) -> LabResult<Value> {
        let path = dir.join("run.json");
        datasets::plain(&path)?;
        let raw = fs::read(&path)?;
        if raw.len() > 1_048_576 {
            return Err(conflict("Training status exceeds its size bound"));
        }
        let mut run: Value = serde_json::from_slice(&raw)?;
        if !run.is_object()
            || run["id"].as_str() != dir.file_name().and_then(|value| value.to_str())
        {
            return Err(conflict("Training status identity is invalid"));
        }
        if ACTIVE.contains(&run["status"].as_str().unwrap_or("")) {
            let age = now_ms().saturating_sub(
                run["updated_at"]
                    .as_i64()
                    .or_else(|| run["created_at"].as_i64())
                    .unwrap_or(0),
            );
            let alive = run["pid"]
                .as_u64()
                .is_some_and(|pid| supervisor_alive(pid, dir));
            if !alive && age > 30_000 {
                if fs::read(&path)? != raw {
                    return self.read_run(dir);
                }
                run["status"] = json!("interrupted");
                run["stage"] = json!("Interrupted");
                run["error"] = json!("The training supervisor stopped before the run finished. Start a new run; its artifacts are retained.");
                datasets::atomic_json(&path, &run)?;
            }
        }
        run["can_resume"] = json!(resume_ready(dir, &run));
        if let Some(progress) = data_progress(dir) {
            run["data_progress"] = progress;
        } else if let Some(object) = run.as_object_mut() {
            object.remove("data_progress");
        }
        Ok(run)
    }

    fn runs(&self) -> LabResult<Vec<Value>> {
        let mut runs = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str() else { continue };
            if id.len() != 32
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            {
                continue;
            }
            let dir = self.run_path(id)?;
            if dir.join("run.json").is_file() {
                runs.push(self.read_run(&dir)?);
            }
        }
        runs.sort_by_key(|run| {
            (
                run["created_at"].as_i64().unwrap_or(0),
                run["id"].as_str().unwrap_or("").to_owned(),
            )
        });
        let index_path = self.root.join("versions.json");
        let mut versions = read_optional_json(&index_path, 1_048_576)?.unwrap_or_else(|| json!({}));
        if !versions.is_object() {
            return Err(conflict("Training version index is invalid"));
        }
        let mut next = versions
            .as_object()
            .unwrap()
            .values()
            .filter_map(Value::as_u64)
            .chain(runs.iter().filter_map(|run| run["version"].as_u64()))
            .max()
            .unwrap_or(0)
            + 1;
        let mut changed = false;
        for run in &mut runs {
            if run["kind"] == "analysis" {
                run["display_name"] = json!("Data check");
                continue;
            }
            run["kind"] = json!("training");
            let id = run["id"].as_str().unwrap().to_owned();
            let version = if let Some(value) = versions.get(&id).and_then(Value::as_u64) {
                value
            } else {
                let value = run["version"].as_u64().unwrap_or_else(|| {
                    let value = next;
                    next += 1;
                    value
                });
                versions[&id] = json!(value);
                changed = true;
                value
            };
            run["version"] = json!(version);
            run["display_name"] = json!(format!("Version {version}"));
        }
        if changed {
            datasets::atomic_json(&index_path, &versions)?;
        }
        runs.reverse();
        Ok(runs)
    }

    fn start(&self, body: &Value, analysis: bool) -> LabResult<Value> {
        let input: StartTraining = parse(body)?;
        if input.collections.is_empty() || input.collections.len() > 100 {
            return Err(bad("Select between 1 and 100 collections"));
        }
        if !(1..=100).contains(&input.epochs) {
            return Err(bad("Epochs must be between 1 and 100"));
        }
        if input.collections.iter().collect::<BTreeSet<_>>().len() != input.collections.len() {
            return Err(bad("Select each collection only once"));
        }
        let catalog = self.registry.list()?;
        let mut collections = Vec::new();
        for id in &input.collections {
            let ctx = self.registry.resolve(id)?;
            let name = catalog
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["id"] == *id))
                .and_then(|row| row["name"].as_str())
                .unwrap_or(id);
            collections.push(json!({"id": id, "name": name, "directory": ctx.directory}));
        }
        let mut reservation_collections = Vec::new();
        for row in catalog
            .as_array()
            .ok_or_else(|| unavailable("Collection catalog is invalid"))?
        {
            let id = row["id"]
                .as_str()
                .ok_or_else(|| unavailable("Collection identity is invalid"))?;
            datasets::safe_filename(id)?;
            let directory = self.registry.root.join(id);
            let database = directory.join("data.db");
            if database.is_file() {
                datasets::plain(&directory)?;
                datasets::plain(&database)?;
                reservation_collections
                    .push(json!({"id":id,"name":row["name"],"directory":directory}));
            }
        }
        if let Some(error) = if analysis {
            self.supervisor_error()
        } else {
            self.setup_error()
        } {
            return Err(unavailable(error));
        }
        let previous = self.runs()?;
        if previous.iter().any(|run| {
            (run["kind"] == "analysis") == analysis
                && ACTIVE.contains(&run["status"].as_str().unwrap_or(""))
        }) {
            return Err(conflict(if analysis {
                "A collection data check is already active"
            } else {
                "An OCR training run is already active"
            }));
        }
        let id = uuid();
        let dir = self.root.join(&id);
        fs::create_dir(&dir)?;
        let mut run = json!({"id": id,"created_at":now_ms(),"kind":if analysis { "analysis" } else { "training" },"status":"queued","stage":"Queued","collections":input.collections,"epochs":input.epochs});
        if analysis {
            run["display_name"] = json!("Data check");
        } else {
            let version = previous
                .iter()
                .filter_map(|run| run["version"].as_u64())
                .max()
                .unwrap_or(0)
                + 1;
            run["version"] = json!(version);
            run["display_name"] = json!(format!("Version {version}"));
        }
        datasets::atomic_json(&dir.join("run.json"), &run)?;
        datasets::atomic_json(
            &dir.join("request.json"),
            &json!({
                "id": id, "created_at": run["created_at"], "run_dir": dir, "training_root":self.training_root,
                "tools_root": self.tools_root,"collections":collections,"reservation_collections":reservation_collections,"epochs":input.epochs,
                "mode":if analysis { "analyze" } else { "train" }
            }),
        )?;
        self.launch(&dir, run)
    }

    fn launch(&self, dir: &Path, run: Value) -> LabResult<Value> {
        if fs::symlink_metadata(dir.join("supervisor.log")).is_ok() {
            datasets::plain(&dir.join("supervisor.log"))?;
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("supervisor.log"))?;
        let mut command = Command::new(&self.python);
        command
            .arg(self.script())
            .arg("--request")
            .arg(dir.join("request.json"))
            .envs(&self.environment)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        match command.spawn() {
            Ok(mut child) => {
                let saved =
                    datasets::atomic_json(&dir.join("supervisor.json"), &json!({"pid":child.id()}));
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                saved?;
                Ok(run)
            }
            Err(error) => {
                let mut failed = run;
                failed["status"] = json!("failed");
                failed["stage"] = json!("Failed to start");
                failed["error"] = json!(format!("Cannot launch OCR training: {error}"));
                datasets::atomic_json(&dir.join("run.json"), &failed)?;
                Err(unavailable(
                    "Cannot launch OCR training; inspect the run error",
                ))
            }
        }
    }

    fn resume(&self, id: &str) -> LabResult<Value> {
        let dir = self.run_path(id)?;
        let previous = self.runs()?;
        let mut run = previous
            .iter()
            .find(|run| run["id"] == id)
            .cloned()
            .ok_or_else(|| not_found("Unknown training run"))?;
        if !resume_ready(&dir, &run) {
            return Err(conflict(
                "Only failed or interrupted training versions with prepared data can resume",
            ));
        }
        if previous.iter().any(|run| {
            run["kind"] != "analysis" && ACTIVE.contains(&run["status"].as_str().unwrap_or(""))
        }) {
            return Err(conflict("An OCR training run is already active"));
        }
        if let Some(error) = self.supervisor_error() {
            return Err(unavailable(error));
        }
        let request_path = dir.join("request.json");
        let mut request = read_optional_json(&request_path, 1_048_576)?
            .ok_or_else(|| conflict("The original training request is unavailable"))?;
        if !request.is_object()
            || request["id"] != id
            || request["run_dir"].as_str() != dir.to_str()
        {
            return Err(conflict(
                "The original training request identity is invalid",
            ));
        }
        let attempt = uuid();
        let history = dir.join("attempts");
        if history.exists() {
            datasets::plain(&history)?;
        }
        fs::create_dir_all(&history)?;
        datasets::atomic_json(
            &history.join(format!("history-{attempt}.json")),
            &json!({"attempt_id":attempt,"resumed_at":now_ms(),"run":run,"request":request}),
        )?;
        let cancel = dir.join("cancel-requested");
        if fs::symlink_metadata(&cancel).is_ok() {
            datasets::plain(&cancel)?;
            fs::remove_file(cancel)?;
        }
        request["mode"] = json!("resume");
        request["attempt_id"] = json!(attempt);
        datasets::atomic_json(&request_path, &request)?;
        run["attempt_id"] = json!(attempt);
        run["status"] = json!("queued");
        run["stage"] = json!("Resume queued");
        run["updated_at"] = json!(now_ms());
        run["queued_at"] = run["updated_at"].clone();
        run["pid"] = Value::Null;
        run["error"] = Value::Null;
        if let Some(fields) = run.as_object_mut() {
            fields.remove("finished_at");
            fields.remove("failed_stage");
        }
        run["stopped_by_user"] = json!(false);
        run["can_resume"] = json!(false);
        let completed = run["workers"]
            .as_array()
            .map(|workers| {
                workers
                    .iter()
                    .filter(|worker| worker["state"] == "completed")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        run["workers"] = json!(completed);
        datasets::atomic_json(&dir.join("run.json"), &run)?;
        self.launch(&dir, run)
    }

    fn cancel(&self, id: &str) -> LabResult<Value> {
        let dir = self.run_path(id)?;
        let mut run = self.read_run(&dir)?;
        if !ACTIVE.contains(&run["status"].as_str().unwrap_or("")) {
            return Err(conflict("Training run is not active"));
        }
        let analysis = run["kind"] == "analysis";
        let pid = run["pid"]
            .as_u64()
            .or_else(|| {
                if analysis {
                    read_optional_json(&dir.join("supervisor.json"), 16_384)
                        .ok()
                        .flatten()
                        .and_then(|value| value["pid"].as_u64())
                } else {
                    None
                }
            })
            .ok_or_else(|| conflict("Training is starting; try stopping it again shortly"))?;
        if !supervisor_alive(pid, &dir) {
            return Err(conflict("Training supervisor is no longer running"));
        }
        fs::write(datasets::file(&dir, "cancel-requested")?, b"stop\n")?;
        #[cfg(unix)]
        if unsafe { libc::kill(-(pid as i32), libc::SIGTERM) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        run["stage"] = json!("Stopping");
        if analysis {
            for _ in 0..100 {
                if !supervisor_alive(pid, &dir) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            #[cfg(unix)]
            if supervisor_alive(pid, &dir) {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            for _ in 0..100 {
                if !supervisor_alive(pid, &dir) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !supervisor_alive(pid, &dir) {
                run = self.read_run(&dir)?;
                run["status"] = json!("interrupted");
                run["stage"] = json!("Stopped");
                run["error"] = Value::Null;
                run["stopped_by_user"] = json!(true);
                run["updated_at"] = json!(now_ms());
                run["finished_at"] = run["updated_at"].clone();
                datasets::atomic_json(&dir.join("run.json"), &run)?;
            }
        }
        Ok(run)
    }

    fn collection_counts(&self) -> LabResult<Vec<Value>> {
        let catalog = self.registry.list()?;
        let reservations = read_optional_json(
            &self.training_root.join("split-reservations.json"),
            32 * 1024 * 1024,
        )?;
        let mut output = Vec::new();
        for row in catalog
            .as_array()
            .ok_or_else(|| conflict("Collection catalog is invalid"))?
        {
            if row["archived"] == true {
                continue;
            }
            let id = row["id"]
                .as_str()
                .ok_or_else(|| conflict("Collection identity is invalid"))?;
            let ctx = self.registry.resolve(id)?;
            let connection = ctx.connection()?;
            let saved: i64 =
                connection.query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))?;
            let has_queue: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='queue_items')", [], |row| row.get(0))?;
            let (queued, reviewed, pending): (i64, i64, i64) = if has_queue {
                connection.query_row("SELECT COUNT(*),COALESCE(SUM(reviewed=1),0),COALESCE(SUM(reviewed=0),0) FROM queue_items WHERE active=1 AND discarded=0",[],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?
            } else {
                (0, 0, 0)
            };
            let mut counts = json!({"id":id,"name":row["name"],"saved":saved,"queued":queued,
                "reviewed_queue":reviewed,"pending":pending,"total":null,"reviewed":null,
                "revision":collection_revision(&ctx.directory)?});
            if let Some(heldout) = reservations
                .as_ref()
                .and_then(|ledger| ledger["collections"].get(id))
            {
                if heldout["reserved"].is_u64()
                    && heldout["validation"].is_u64()
                    && heldout["test"].is_u64()
                {
                    counts["reserved"] = heldout["reserved"].clone();
                    counts["reservations"] = json!({"reserved":heldout["reserved"],"validation":heldout["validation"],"test":heldout["test"],"reasons":heldout.get("reasons").cloned().unwrap_or_else(||json!([]))});
                }
            }
            output.push(counts);
        }
        Ok(output)
    }

    fn analysis_protocol(&self) -> LabResult<String> {
        let mut content = crate::labels::CONTRACT_BYTES.to_vec();
        for name in [
            "lab_training_data.py",
            "export_reviewed_dataset.py",
            "prepare_named_collection_training.py",
            "lab_training_curriculum.py",
        ] {
            content.extend_from_slice(name.as_bytes());
            let path = self.tools_root.join("dev_tools/training").join(name);
            if path.exists() {
                datasets::plain(&path)?;
                let mut raw = Vec::new();
                File::open(&path)?.take(1_048_577).read_to_end(&mut raw)?;
                if raw.len() > 1_048_576 {
                    return Err(conflict("Training analysis helper exceeds its size bound"));
                }
                content.extend_from_slice(&(raw.len() as u64).to_le_bytes());
                content.extend_from_slice(&raw);
            } else {
                content.extend_from_slice(b"missing");
            }
        }
        Ok(super::sha256(&content))
    }

    fn active_release(&self) -> Value {
        if let Some(model) = &self.model {
            if let Err(error) = model.release_path() {
                return json!({"configured":false,"error":error.message});
            }
        }
        let root = self
            .model
            .as_ref()
            .and_then(|model| model.release_path().ok())
            .unwrap_or_else(|| self.base_release());
        let result = (|| -> LabResult<Value> {
            let freeze = read_optional_json(&root.join("freeze.json"), 1_048_576)?
                .ok_or_else(|| unavailable("The active OCR release freeze is unavailable"))?;
            Ok(
                json!({"configured":true,"id":freeze.get("id").cloned().unwrap_or_else(||json!("baseline")),"display_name":freeze.get("display_name").cloned().unwrap_or_else(||json!("Original active models")),"path":root,"general_sha256":freeze["weights"]["general"],
                "names_sha256":freeze["weights"]["names"],"freeze_sha256":super::sha256(&fs::read(root.join("freeze.json"))?)}),
            )
        })();
        result.unwrap_or_else(|error| json!({"configured":false,"path":root,"general_sha256":null,"names_sha256":null,"error":error.message}))
    }

    fn details(&self, id: &str, condition: Option<&str>) -> LabResult<Value> {
        let dir = self.run_path(id)?;
        let run = self
            .runs()?
            .into_iter()
            .find(|run| run["id"] == id)
            .ok_or_else(|| not_found("Unknown training run"))?;
        let audit = read_optional_json(&dir.join("bundle/audit.json"), 4_194_304)?;
        let version = read_optional_json(&dir.join("version.json"), 4_194_304)?;
        let analysis = if run["analysis"].is_object() {
            run["analysis"].clone()
        } else {
            read_optional_json(&dir.join("readiness.json"), 1_048_576)?.unwrap_or(Value::Null)
        };
        let workers = read_optional_json(&dir.join("workers.json"), 1_048_576)?
            .unwrap_or_else(|| run["workers"].clone());
        let mut logs = json!({});
        for (key, name) in [
            ("supervisor", "supervisor.log"),
            ("general", "general.log"),
            ("names", "names.log"),
            ("export", "export.log"),
            ("benchmark", "benchmark.log"),
        ] {
            logs[key] = json!(log_tail(&dir.join(name), 8192)?);
        }
        Ok(
            json!({"run":run,"audit":audit,"version":version,"analysis":analysis,"workers":workers,
            "telemetry":self.telemetry.read(&dir, condition),
            "benchmarks":{"candidate":read_optional_json(&dir.join("benchmarks/candidate/summary.json"),4_194_304)?,
                "baseline":read_optional_json(&dir.join("benchmarks/baseline/summary.json"),4_194_304)?},"logs":logs}),
        )
    }

    fn probe(&self) -> LabResult<Value> {
        if !self.python.is_absolute() || !self.python.is_file() || !self.script().is_file() {
            return Err(unavailable(
                "OCR training supervisor and Python are required to inspect the GPUs",
            ));
        }
        let cache = read_optional_json(&self.training_root.join("gpu-status.json"), 1_048_576)?;
        let checked = cache
            .as_ref()
            .and_then(|value| value["checked_at"].as_i64())
            .unwrap_or(0);
        if now_ms().saturating_sub(checked) < 30_000 {
            return Ok(json!({"checking":false}));
        }
        let path = self.root.join("probe.json");
        let previous = read_optional_json(&path, 1024)?;
        if let Some(previous) = previous {
            let started = previous["started_at"].as_i64().unwrap_or(0);
            if started > checked
                && now_ms().saturating_sub(started) < 180_000
                && previous["pid"]
                    .as_u64()
                    .is_some_and(|pid| command_alive(pid, "--probe", &self.training_root))
            {
                return Ok(json!({"checking":true}));
            }
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("gpu-probe.log"))?;
        let mut command = Command::new(&self.python);
        command
            .arg(self.script())
            .arg("--probe")
            .arg(&self.training_root)
            .envs(&self.environment)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn()?;
        datasets::atomic_json(&path, &json!({"started_at":now_ms(),"pid":child.id()}))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(json!({"checking":true}))
    }

    pub fn handle(&self, request: &LabRequest) -> Option<LabResult<LabResponse>> {
        if request.path != "/api/training" && !request.path.starts_with("/api/training/") {
            return None;
        }
        if request.path == "/api/training/active" {
            return Some(if request.method == "GET" {
                let mut response = LabResponse::ok(json!({"active_release":self.active_release()}));
                response
                    .headers
                    .insert("Cache-Control".into(), "private, no-store".into());
                Ok(response)
            } else {
                Err(not_found("Unknown training route"))
            });
        }
        Some((|| {
            let _guard = self
                .operation
                .lock()
                .map_err(|_| conflict("Training manager lock poisoned"))?;
            let _file = self.lock()?;
            let mut response = match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/training/sample") => {
                    if request
                        .query
                        .keys()
                        .any(|key| !matches!(key.as_str(), "run" | "sample_id"))
                    {
                        return Err(bad("Invalid frozen training sample query"));
                    }
                    let run = request
                        .query("run")
                        .ok_or_else(|| bad("Training run is required"))?;
                    let sample = request
                        .query("sample_id")
                        .ok_or_else(|| bad("Frozen sample identity is required"))?;
                    self.telemetry
                        .sample(&self.run_path(run)?, sample, request)?
                }
                ("GET", "/api/training/versions") => LabResponse::ok(self.version_catalog()?),
                ("POST", "/api/training/activate") => {
                    LabResponse::ok(self.activate(&request.body)?)
                }
                ("GET", "/api/training") => {
                    let error = self.setup_error();
                    let setup = match error {
                        Some(error) => json!({"ready":false,"error":error}),
                        None => json!({"ready":true}),
                    };
                    let all = self.runs()?;
                    let runs: Vec<_> = all.iter().filter(|run| run["kind"] != "analysis").collect();
                    let analyses: Vec<_> = all
                        .iter()
                        .filter(|run| run["kind"] == "analysis")
                        .take(20)
                        .collect();
                    LabResponse::ok(json!({"runs":runs,"analyses":analyses,"setup":setup,
                        "analysis_protocol":self.analysis_protocol()?,
                        "collections":self.collection_counts()?,"active_release":self.active_release(),
                        "gpu_status":read_optional_json(&self.training_root.join("gpu-status.json"),1_048_576)?}))
                }
                ("POST", "/api/training") => {
                    LabResponse::json(201, json!({"run":self.start(&request.body, false)?}))
                }
                ("POST", "/api/training/analyze") => {
                    LabResponse::json(202, json!({"run":self.start(&request.body, true)?}))
                }
                ("POST", "/api/training/probe") => {
                    if !request.body.is_null() && request.body != json!({}) {
                        return Err(bad("GPU probe accepts no options"));
                    }
                    LabResponse::json(202, self.probe()?)
                }
                ("GET", path) => {
                    let id = path
                        .strip_prefix("/api/training/")
                        .ok_or_else(|| not_found("Unknown training route"))?;
                    if request.query.keys().any(|key| key != "condition") {
                        return Err(bad("Invalid training details query"));
                    }
                    let condition = request.query("condition");
                    if condition.is_some_and(|value| !telemetry::CONDITIONS.contains(&value)) {
                        return Err(bad("Unknown benchmark condition"));
                    }
                    LabResponse::ok(self.details(id, condition)?)
                }
                ("POST", path) if path.ends_with("/resume") => {
                    if !request.body.is_null() && request.body != json!({}) {
                        return Err(bad("Resume training accepts no options"));
                    }
                    let id = path
                        .strip_prefix("/api/training/")
                        .and_then(|value| value.strip_suffix("/resume"))
                        .ok_or_else(|| not_found("Unknown training route"))?;
                    LabResponse::json(202, json!({"run":self.resume(id)?}))
                }
                ("POST", path) if path.ends_with("/cancel") => {
                    if !request.body.is_null() && request.body != json!({}) {
                        return Err(bad("Stop training accepts no options"));
                    }
                    let id = path
                        .strip_prefix("/api/training/")
                        .and_then(|value| value.strip_suffix("/cancel"))
                        .ok_or_else(|| not_found("Unknown training route"))?;
                    LabResponse::ok(json!({"run":self.cancel(id)?}))
                }
                _ => return Err(not_found("Unknown training route")),
            };
            response
                .headers
                .entry("Cache-Control".into())
                .or_insert_with(|| "private, no-store".into());
            Ok(response)
        })())
    }
}

fn read_optional_json(path: &Path, limit: usize) -> LabResult<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    datasets::plain(path)?;
    let mut file = File::open(path)?;
    let mut raw = Vec::new();
    file.by_ref().take(limit as u64 + 1).read_to_end(&mut raw)?;
    if raw.len() > limit {
        return Err(conflict("Training report exceeds its size bound"));
    }
    Ok(Some(serde_json::from_slice(&raw)?))
}

fn log_tail(path: &Path, limit: u64) -> LabResult<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    datasets::plain(path)?;
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(limit)))?;
    let mut raw = Vec::new();
    file.take(limit).read_to_end(&mut raw)?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

fn resume_ready(directory: &Path, run: &Value) -> bool {
    if run["kind"] == "analysis"
        || !["failed", "interrupted"].contains(&run["status"].as_str().unwrap_or(""))
    {
        return false;
    }
    for path in [
        directory.join("prepared.json"),
        directory.join("bundle"),
        directory.join("bundle/audit.json"),
    ] {
        if datasets::plain(&path).is_err() {
            return false;
        }
    }
    let stages = directory.join("bundle/stages");
    if stages.exists() && datasets::plain(&stages).is_err() {
        return false;
    }
    let Ok(Some(prepared)) = read_optional_json(&directory.join("prepared.json"), 1_048_576) else {
        return false;
    };
    let Some(pins) = prepared["baseline_pins"].as_object() else {
        return false;
    };
    if pins.len() != 2 || datasets::plain(&directory.join("baseline")).is_err() {
        return false;
    }
    for role in ["general", "names"] {
        let baseline = directory.join("baseline").join(role);
        let Some(hashes) = pins.get(role).and_then(Value::as_object) else {
            return false;
        };
        if hashes.len() != 2
            || prepared[format!("baseline_{role}_model")].as_str() != baseline.to_str()
            || datasets::plain(&baseline).is_err()
        {
            return false;
        }
        for name in ["model.onnx", "characters.json"] {
            let path = baseline.join(name);
            if !hashes.get(name).is_some_and(checkpoint_hash_shape)
                || !path.is_file()
                || datasets::plain(&path).is_err()
            {
                return false;
            }
        }
    }
    ["general", "names", "stages/base", "stages/names-base"]
        .iter()
        .all(|stage| checkpoint_resume_available(&directory.join("bundle").join(stage)))
}

fn checkpoint_hash_shape(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn checkpoint_resume_available(stage: &Path) -> bool {
    if !stage.exists() {
        return true;
    }
    if datasets::plain(stage).is_err() {
        return false;
    }
    let Ok(status) = read_optional_json(&stage.join("training-status.json"), 1_048_576) else {
        return false;
    };
    if let Some(status) = status {
        if status["state"] == "completed" {
            let selected = stage.join("checkpoints/best_accuracy.pdparams");
            return selected.is_file() && datasets::plain(&selected).is_ok();
        }
    }
    let checkpoints = stage.join("checkpoints");
    if !checkpoints.exists() {
        return true;
    }
    if datasets::plain(&checkpoints).is_err() {
        return false;
    }
    let Ok(entries) = fs::read_dir(&checkpoints) else {
        return false;
    };
    let Ok(entries) = entries.take(1025).collect::<std::io::Result<Vec<_>>>() else {
        return false;
    };
    if entries.len() > 1024 {
        return false;
    }
    let mut artifacts = false;
    let mut receipted = false;
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return false;
        };
        artifacts |= [".states", ".pdparams", ".pdopt"]
            .iter()
            .any(|suffix| name.ends_with(suffix));
        let Some(prefix) = name.strip_suffix(".resume.json") else {
            continue;
        };
        if prefix != "latest"
            && !prefix
                .strip_prefix("iter_epoch_")
                .is_some_and(|epoch| epoch.parse::<u64>().is_ok())
        {
            continue;
        }
        let Ok(Some(receipt)) = read_optional_json(&entry.path(), 16_384) else {
            continue;
        };
        if receipt["version"] != 1
            || receipt["epoch"].as_u64().is_none()
            || receipt["global_step"].as_u64().is_none()
        {
            continue;
        }
        receipted |= [".pdparams", ".pdopt", ".states"].iter().all(|suffix| {
            let path = checkpoints.join(format!("{prefix}{suffix}"));
            checkpoint_hash_shape(&receipt["sha256"][*suffix])
                && path.is_file()
                && datasets::plain(&path).is_ok()
        });
    }
    !artifacts || receipted
}

fn collection_revision(directory: &Path) -> LabResult<String> {
    let mut stamps = Vec::new();
    for name in ["data.db", "data.db-wal", "images"] {
        let path = directory.join(name);
        match fs::metadata(&path) {
            Ok(metadata) => {
                datasets::plain(&path)?;
                let modified = metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| conflict("Collection timestamp precedes the system epoch"))?;
                stamps.push(json!([
                    name,
                    metadata.len(),
                    modified.as_secs(),
                    modified.subsec_nanos()
                ]));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                stamps.push(json!([name, null]))
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(super::sha256(&serde_json::to_vec(&stamps)?))
}

fn supervisor_alive(pid: u64, dir: &Path) -> bool {
    command_alive(pid, "--request", &dir.join("request.json"))
}

fn command_alive(pid: u64, flag: &str, target: &Path) -> bool {
    if pid == 0 || pid > i32::MAX as u64 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(command) = fs::read(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        let args: Vec<_> = command.split(|byte| *byte == 0).collect();
        args.iter().any(|arg| {
            Path::new(std::ffi::OsStr::from_bytes(arg))
                .file_name()
                .is_some_and(|name| name == "lab_training_job.py")
        }) && args.windows(2).any(|pair| {
            pair[0] == flag.as_bytes() && pair[1] == target.as_os_str().as_encoded_bytes()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (flag, target);
        false
    }
}

#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_names_obey_the_frontend_utf16_boundary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("data-progress.json");
        datasets::atomic_json(
            &path,
            &json!({"stage":"reading","collection_name":"😀".repeat(50)}),
        )
        .unwrap();
        assert!(data_progress(root.path()).is_some());
        datasets::atomic_json(
            &path,
            &json!({"stage":"reading","collection_name":"😀".repeat(51)}),
        )
        .unwrap();
        assert!(data_progress(root.path()).is_none());
    }

    #[test]
    fn resume_admission_requires_original_baseline_pins_and_completed_save_receipts() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path();
        fs::create_dir_all(directory.join("bundle")).unwrap();
        fs::write(directory.join("bundle/audit.json"), "{}").unwrap();
        let run = json!({"kind":"training","status":"interrupted"});
        datasets::atomic_json(&directory.join("prepared.json"), &json!({})).unwrap();
        assert!(!resume_ready(directory, &run));
        let mut prepared = json!({"baseline_pins":{}});
        for role in ["general", "names"] {
            let path = directory.join("baseline").join(role);
            fs::create_dir_all(&path).unwrap();
            prepared[format!("baseline_{role}_model")] = json!(path);
            prepared["baseline_pins"][role] =
                json!({"model.onnx":"a".repeat(64),"characters.json":"b".repeat(64)});
            fs::write(path.join("model.onnx"), "model").unwrap();
            fs::write(path.join("characters.json"), "[]").unwrap();
        }
        datasets::atomic_json(&directory.join("prepared.json"), &prepared).unwrap();
        assert!(resume_ready(directory, &run));
        let stage = directory.join("bundle/general");
        let checkpoints = stage.join("checkpoints");
        fs::create_dir_all(&checkpoints).unwrap();
        for suffix in [".pdparams", ".pdopt", ".states"] {
            fs::write(checkpoints.join(format!("latest{suffix}")), "interrupted").unwrap();
        }
        assert!(!resume_ready(directory, &run));
        let mut receipt = json!({"version":1,"epoch":2,"global_step":100,"sha256":{}});
        for suffix in [".pdparams", ".pdopt", ".states"] {
            receipt["sha256"][suffix] = json!("c".repeat(64));
        }
        datasets::atomic_json(&checkpoints.join("latest.resume.json"), &receipt).unwrap();
        assert!(resume_ready(directory, &run));
        receipt["epoch"] = json!(true);
        datasets::atomic_json(&checkpoints.join("latest.resume.json"), &receipt).unwrap();
        assert!(!resume_ready(directory, &run));
        datasets::atomic_json(
            &stage.join("training-status.json"),
            &json!({"state":"completed"}),
        )
        .unwrap();
        fs::write(
            checkpoints.join("best_accuracy.pdparams"),
            "verified later by worker",
        )
        .unwrap();
        assert!(resume_ready(directory, &run));
        prepared["baseline_pins"]["names"] = json!({});
        datasets::atomic_json(&directory.join("prepared.json"), &prepared).unwrap();
        assert!(!resume_ready(directory, &run));
    }

    #[test]
    fn readiness_tokens_are_stable_and_track_helper_and_collection_changes() {
        let root = tempfile::tempdir().unwrap();
        let tools = root.path().join("tools");
        fs::create_dir_all(tools.join("dev_tools/training")).unwrap();
        let registry = Arc::new(
            datasets::DatasetRegistry::new(root.path().join("collector_datasets")).unwrap(),
        );
        let manager = TrainingManager::new(
            root.path().join("data"),
            tools.clone(),
            registry.clone(),
            HashMap::new(),
        )
        .unwrap();
        let protocol = manager.analysis_protocol().unwrap();
        assert_eq!(protocol, manager.analysis_protocol().unwrap());
        fs::write(
            tools.join("dev_tools/training/lab_training_data.py"),
            b"first protocol\n",
        )
        .unwrap();
        let changed = manager.analysis_protocol().unwrap();
        assert_ne!(protocol, changed);
        assert_eq!(changed, manager.analysis_protocol().unwrap());
        fs::write(
            tools.join("dev_tools/training/export_reviewed_dataset.py"),
            b"export protocol\n",
        )
        .unwrap();
        assert_ne!(changed, manager.analysis_protocol().unwrap());
        for name in [
            "prepare_named_collection_training.py",
            "lab_training_curriculum.py",
        ] {
            let before = manager.analysis_protocol().unwrap();
            fs::write(
                tools.join("dev_tools/training").join(name),
                b"updated readiness dependency\n",
            )
            .unwrap();
            let after = manager.analysis_protocol().unwrap();
            assert_ne!(before, after);
            assert_eq!(after, manager.analysis_protocol().unwrap());
        }
        let first = manager.collection_counts().unwrap()[0]["revision"].clone();
        assert_eq!(first, manager.collection_counts().unwrap()[0]["revision"]);
        let protocol = manager.analysis_protocol().unwrap();
        for _ in 0..3 {
            datasets::atomic_json(
                &manager.training_root.join("split-reservations.json"),
                &json!({"version":1,"tokens":{},"collections":{}}),
            )
            .unwrap();
            assert_eq!(protocol, manager.analysis_protocol().unwrap());
            assert_eq!(first, manager.collection_counts().unwrap()[0]["revision"]);
        }
        let context = registry.resolve("legacy").unwrap();
        context
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO images(filename,label) VALUES('one.png','1')",
                [],
            )
            .unwrap();
        let revised = manager.collection_counts().unwrap()[0]["revision"].clone();
        assert_ne!(first, revised);
        assert_eq!(revised, manager.collection_counts().unwrap()[0]["revision"]);
        fs::write(context.images().join("two.png"), b"new capture").unwrap();
        assert_ne!(revised, manager.collection_counts().unwrap()[0]["revision"]);
    }
}
