//! Shared persistent ONNX process protocol; inference remains in the trained worker.
#[path = "model/storage_paths.rs"]
pub(crate) mod storage_paths;
#[path = "model/worker.rs"]
pub(crate) mod worker;
use super::{bad, unavailable, LabResult};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
};
struct State {
    ocr: worker::Ocr,
}
struct Configuration {
    release: PathBuf,
    selection_error: Option<String>,
}
pub struct ModelRuntime {
    state: Mutex<State>,
    configuration: Mutex<Configuration>,
    cancelled: Arc<AtomicBool>,
    runtime_state: Arc<AtomicU8>,
    error: Mutex<Option<String>>,
    device: String,
    python: PathBuf,
    tools_root: PathBuf,
    environment: HashMap<String, String>,
    config_error: Option<String>,
}
impl ModelRuntime {
    pub fn new(tools_root: PathBuf) -> LabResult<Self> {
        Self::with_environment(tools_root, std::env::vars().collect())
    }
    pub fn with_environment(
        tools_root: PathBuf,
        mut environment: HashMap<String, String>,
    ) -> LabResult<Self> {
        let training = storage_paths::directory(&environment, "data").join("ocr-training");
        let python = environment
            .get("OCR_MODEL_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| training.join("desktop-gpu/bin/python"));
        let release = environment
            .get("OCR_MODEL_RELEASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| training.join("release-candidate"));
        let batch = environment
            .get("OCR_MODEL_BATCH_SIZE")
            .map(String::as_str)
            .unwrap_or("1");
        let config_error = if matches!(batch.trim().parse::<usize>(), Ok(1..=8)) {
            None
        } else {
            Some("OCR_MODEL_BATCH_SIZE must be between 1 and 8".to_string())
        };
        if config_error.is_none() {
            let normalized = batch.trim().parse::<usize>().unwrap().to_string();
            environment.insert("OCR_MODEL_BATCH_SIZE".into(), normalized);
        }
        let device = environment
            .get("OCR_MODEL_DEVICE")
            .cloned()
            .unwrap_or_else(|| "gpu:0".into());
        let ocr = worker::Ocr::new(&tools_root, &environment);
        let cancelled = ocr.cancellation();
        let runtime_state = ocr.runtime_state();
        Ok(Self {
            state: Mutex::new(State { ocr }),
            configuration: Mutex::new(Configuration {
                release,
                selection_error: None,
            }),
            cancelled,
            runtime_state,
            error: Mutex::new(None),
            device,
            python,
            tools_root,
            environment,
            config_error,
        })
    }
    pub fn status(&self) -> LabResult<Value> {
        if let Some(error) = &self.config_error {
            return Err(unavailable(error.clone()));
        }
        let configured =
            self.python.is_file() && self.release_path()?.join("freeze.json").is_file();
        let running = match self.state.try_lock() {
            Ok(mut state) => {
                state.ocr.is_running() && self.runtime_state.load(Ordering::Acquire) == 2
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                self.runtime_state.load(Ordering::Acquire) == 2
            }
            Err(_) => return Err(unavailable("Model lock poisoned")),
        };
        let error = self
            .error
            .lock()
            .map_err(|_| unavailable("Model error lock poisoned"))?
            .clone();
        Ok(
            json!({"state":if running{"ready"}else if error.is_some(){"error"}else{"idle"},"device":self.device,"error":error,"configured":configured}),
        )
    }
    pub(crate) fn release_path(&self) -> LabResult<PathBuf> {
        let state = self
            .configuration
            .lock()
            .map_err(|_| unavailable("Model lock poisoned"))?;
        if let Some(error) = &state.selection_error {
            return Err(unavailable(error.clone()));
        }
        Ok(state.release.clone())
    }
    pub(crate) fn set_configuration_error(&mut self, error: String) {
        if let Ok(state) = self.configuration.get_mut() {
            state.selection_error = Some(error);
        }
    }
    pub(crate) fn activate_release(
        &self,
        release: PathBuf,
        persist: impl FnOnce() -> LabResult<()>,
    ) -> LabResult<()> {
        if let Some(error) = &self.config_error {
            return Err(unavailable(error.clone()));
        }
        let mut environment = self.environment.clone();
        environment.insert(
            "OCR_MODEL_RELEASE".into(),
            release.to_string_lossy().into_owned(),
        );
        let mut candidate = worker::Ocr::new(&self.tools_root, &environment);
        candidate.start().map_err(unavailable)?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        let image = image::RgbImage::from_fn(32, 32, |x, y| {
            image::Rgb([(x * 7) as u8, (y * 7) as u8, 100])
        });
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|_| unavailable("Cannot prepare OCR activation check"))?;
        candidate
            .predict_many(vec![
                (bytes.get_ref().clone(), "pot".into()),
                (bytes.into_inner(), "seats[0].name".into()),
            ])
            .map_err(unavailable)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("Model lock poisoned"))?;
        let mut error = self
            .error
            .lock()
            .map_err(|_| unavailable("Model error lock poisoned"))?;
        let mut configuration = self
            .configuration
            .lock()
            .map_err(|_| unavailable("Model configuration lock poisoned"))?;
        if self.cancelled.load(Ordering::Acquire) {
            return Err(unavailable("OCR is shutting down"));
        }
        persist()?;
        state.ocr.stop();
        state.ocr = candidate;
        state
            .ocr
            .share_signals(self.cancelled.clone(), self.runtime_state.clone());
        configuration.release = release;
        configuration.selection_error = None;
        *error = None;
        Ok(())
    }
    pub fn predict(&self, png: &[u8], region: &str) -> LabResult<Value> {
        if png.is_empty() || png.len() > 16 * 1024 * 1024 {
            return Err(bad("Expected bounded PNG crop bytes"));
        }
        if region.is_empty() {
            return Err(bad("Region identity is required"));
        }
        Ok(self
            .predict_many(vec![(png.to_vec(), region.to_owned())])?
            .remove(0))
    }
    pub fn predict_many(&self, crops: Vec<(Vec<u8>, String)>) -> LabResult<Vec<Value>> {
        if let Some(error) = &self.config_error {
            return Err(unavailable(error.clone()));
        }
        self.release_path()?;
        if crops.is_empty() || crops.len() > 192 {
            return Err(bad("Expected 1..192 crops"));
        }
        let mut total = 0usize;
        for (png, region) in &crops {
            if png.is_empty() || region.is_empty() {
                return Err(bad("Expected crop bytes and region identity"));
            }
            total = total
                .checked_add(png.len())
                .ok_or_else(|| bad("Batch exceeds input limit"))?;
            if total > 16 * 1024 * 1024 {
                return Err(bad("Batch exceeds input limit"));
            }
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("Model lock poisoned"))?;
        let result = state.ocr.predict_many(crops);
        match result {
            Ok(value) => {
                *self
                    .error
                    .lock()
                    .map_err(|_| unavailable("Model error lock poisoned"))? = None;
                Ok(value)
            }
            Err(message) => {
                *self
                    .error
                    .lock()
                    .map_err(|_| unavailable("Model error lock poisoned"))? = Some(message.clone());
                Err(unavailable(message))
            }
        }
    }
    pub fn last_batch_stats(&self) -> LabResult<Value> {
        Ok(self
            .state
            .lock()
            .map_err(|_| unavailable("Model lock poisoned"))?
            .ocr
            .last_batch_stats
            .clone())
    }
    pub fn close(&self) -> LabResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| unavailable("Model lock poisoned"))?;
        state.ocr.stop();
        Ok(())
    }
    pub fn shutdown(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut state) = self.state.lock() {
            state.ocr.stop();
        }
    }
}
impl Drop for ModelRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime(body: &str) -> (tempfile::TempDir, ModelRuntime) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("dev_tools/training")).unwrap();
        std::fs::write(
            root.path()
                .join("dev_tools/training/collector_inference.py"),
            body,
        )
        .unwrap();
        let model = ModelRuntime::with_environment(
            root.path().into(),
            HashMap::from([
                ("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into()),
                (
                    "OCR_MODEL_RELEASE".into(),
                    root.path()
                        .join("no-release")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ]),
        )
        .unwrap();
        (root, model)
    }
    #[test]
    fn model_status_tracks_lazy_start_error_restart_and_close() {
        let(root,model)=runtime("import json,sys,os\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({'ok':True,'predictions':[{'text':'Alice','pid':os.getpid()} for item in r['items']],'stats':{'requests':1}}),flush=True)\n");
        assert_eq!(model.status().unwrap()["state"], "idle");
        let a = model.predict(b"png", "seats[0].name").unwrap();
        let b = model.predict(b"png", "seats[1].name").unwrap();
        assert_eq!(a["pid"], b["pid"]);
        assert_eq!(model.status().unwrap()["state"], "ready");
        assert_eq!(model.last_batch_stats().unwrap()["requests"], 1);
        model.close().unwrap();
        assert_eq!(model.status().unwrap()["state"], "idle");
        std::fs::write(
            root.path()
                .join("dev_tools/training/collector_inference.py"),
            "print('{\"ready\":false}',flush=True)\n",
        )
        .unwrap();
        assert!(model.predict(b"png", "pot").is_err());
        assert_eq!(model.status().unwrap()["state"], "error");
        assert!(model.status().unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("initialize"));
    }
    #[test]
    fn model_validation_does_not_start_a_worker() {
        let (_root, model) = runtime("");
        assert!(model.predict(b"", "pot").is_err());
        assert!(model.predict(b"png", "").is_err());
        assert!(model.predict_many(vec![]).is_err());
        assert_eq!(model.status().unwrap()["state"], "idle");
        assert_eq!(model.status().unwrap()["configured"], false);
        let invalid = ModelRuntime::with_environment(
            PathBuf::from("/tmp"),
            HashMap::from([("OCR_MODEL_BATCH_SIZE".into(), "9".into())]),
        )
        .unwrap();
        assert!(invalid.status().is_err());
        assert!(invalid.predict(b"png", "pot").is_err());
    }
    #[test]
    fn malformed_or_oversized_worker_output_is_reaped() {
        for body in ["import sys\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin: print('{not json}',flush=True)\n","import sys\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin: print('x'*1048577,flush=True)\n"]{let(_root,model)=runtime(body);assert!(model.predict(b"png","pot").is_err());assert_eq!(model.status().unwrap()["state"],"error");}
    }
    #[test]
    fn status_remains_responsive_while_prediction_waits_and_shutdown_cancels_it() {
        use std::time::{Duration, Instant};
        let(root,model)=runtime("import json,sys,time,pathlib\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin:\n pathlib.Path(__file__).with_suffix('.started').touch()\n time.sleep(30)\n");
        let model = Arc::new(model);
        let worker = model.clone();
        let prediction = std::thread::spawn(move || worker.predict(b"png", "pot"));
        let marker = root
            .path()
            .join("dev_tools/training/collector_inference.started");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(marker.exists());
        let started = Instant::now();
        assert_eq!(model.status().unwrap()["state"], "ready");
        assert!(started.elapsed() < Duration::from_millis(100));
        model.shutdown();
        assert!(prediction
            .join()
            .unwrap()
            .unwrap_err()
            .message
            .contains("cancelled"));
    }
}
