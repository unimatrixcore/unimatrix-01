//! Bounded, persistent transport to the trained OCR worker, outside the UI loop.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    os::fd::{AsRawFd, RawFd},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_REQUEST: usize = 24 * 1024 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;

pub struct Ocr {
    repo: PathBuf,
    environment: HashMap<String, String>,
    child: Option<Child>,
    pub last_batch_stats: Value,
    cancelled: Arc<AtomicBool>,
    runtime_state: Arc<AtomicU8>,
}

impl Ocr {
    /// Keep configuration only; model loading begins on the first prediction.
    pub fn new(repo: &Path, environment: &HashMap<String, String>) -> Self {
        Self {
            repo: repo.into(),
            environment: environment.clone(),
            child: None,
            last_batch_stats: json!({}),
            cancelled: Arc::new(AtomicBool::new(false)),
            runtime_state: Arc::new(AtomicU8::new(0)),
        }
    }

    /// Shutdown can signal in-flight pipe IO without acquiring the OCR mutex.
    pub fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }
    pub fn runtime_state(&self) -> Arc<AtomicU8> {
        self.runtime_state.clone()
    }
    pub(super) fn start(&mut self) -> Result<(), String> {
        self.ensure_started()
    }
    pub(super) fn share_signals(&mut self, cancelled: Arc<AtomicBool>, state: Arc<AtomicU8>) {
        self.cancelled = cancelled;
        self.runtime_state = state;
        self.runtime_state.store(2, Ordering::Release);
    }

    fn setting(&self, key: &str, fallback: String) -> String {
        self.environment
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .unwrap_or(fallback)
    }

    /// One request contains all crops, avoiding a worker round trip per region.
    pub fn predict_many(&mut self, crops: Vec<(Vec<u8>, String)>) -> Result<Vec<Value>, String> {
        let result = self.predict_inner(crops);
        if result.is_err() {
            self.stop();
        }
        result
    }

    fn predict_inner(&mut self, crops: Vec<(Vec<u8>, String)>) -> Result<Vec<Value>, String> {
        if crops.is_empty() || crops.len() > 192 {
            return Err("Expected 1..192 crops".into());
        }
        let mut bytes = 0usize;
        let count = crops.len();
        let mut items = Vec::with_capacity(count);
        for (png, region) in crops {
            if png.is_empty() || region.is_empty() {
                return Err("Expected crop bytes and region identity".into());
            }
            bytes = bytes
                .checked_add(png.len())
                .ok_or("Batch exceeds input limit")?;
            if bytes > MAX_INPUT || region.len() > 4096 {
                return Err("Batch exceeds input limit".into());
            }
            items.push(json!({"png_base64": STANDARD.encode(png), "region_id": region}));
        }
        let mut payload =
            serde_json::to_vec(&json!({"items": items})).map_err(|e| e.to_string())?;
        payload.push(b'\n');
        if payload.len() > MAX_REQUEST {
            return Err("Model request exceeds input limit".into());
        }
        self.ensure_started()?;
        let child = self.child.as_ref().ok_or("Model worker unavailable")?;
        let input = child
            .stdin
            .as_ref()
            .ok_or("Model input unavailable")?
            .as_raw_fd();
        let output = child
            .stdout
            .as_ref()
            .ok_or("Model output unavailable")?
            .as_raw_fd();
        write_all(input, &payload, Duration::from_secs(5), &self.cancelled)?;
        let result = receive(output, Duration::from_secs(15), &self.cancelled)?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Prediction failed")
                .into());
        }
        let predictions = result
            .get("predictions")
            .and_then(Value::as_array)
            .ok_or("Model returned an incomplete crop batch")?;
        if predictions.len() != count {
            return Err("Model returned an incomplete crop batch".into());
        }
        self.last_batch_stats = result.get("stats").cloned().unwrap_or_else(|| json!({}));
        Ok(predictions.clone())
    }

    /// Reuse the same loaded GPU model until the process fails or is cancelled.
    fn ensure_started(&mut self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("OCR cancelled".into());
        }
        if let Some(child) = self.child.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(());
            }
        }
        self.stop();
        let python = self.setting(
            "OCR_MODEL_PYTHON",
            crate::lab::model::storage_paths::directory(&self.environment, "data")
                .join("ocr-training/desktop-gpu/bin/python")
                .to_string_lossy()
                .into_owned(),
        );
        let release = self.setting(
            "OCR_MODEL_RELEASE",
            crate::lab::model::storage_paths::directory(&self.environment, "data")
                .join("ocr-training/release-candidate")
                .to_string_lossy()
                .into_owned(),
        );
        let device = self.setting("OCR_MODEL_DEVICE", "gpu:0".into());
        let batch = self.setting("OCR_MODEL_BATCH_SIZE", "1".into());
        if !matches!(batch.parse::<usize>(), Ok(1..=8)) {
            return Err("OCR_MODEL_BATCH_SIZE must be between 1 and 8".into());
        }
        let child = Command::new(python)
            .arg("-u")
            .arg(self.repo.join("dev_tools/training/collector_inference.py"))
            .args([
                "--release",
                &release,
                "--device",
                &device,
                "--batch-size",
                &batch,
            ])
            .envs(&self.environment)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Cannot start OCR worker: {e}"))?;
        self.child = Some(child);
        self.runtime_state.store(1, Ordering::Release);
        let child = self.child.as_ref().unwrap();
        let input = child.stdin.as_ref().unwrap().as_raw_fd();
        let output = child.stdout.as_ref().unwrap().as_raw_fd();
        nonblocking(input)?;
        nonblocking(output)?;
        let ready = receive(output, Duration::from_secs(60), &self.cancelled)?;
        if ready.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err("Model worker did not initialize".into());
        }
        self.runtime_state.store(2, Ordering::Release);
        Ok(())
    }

    /// Own the Child until it has been reaped; no PID is exposed for reuse races.
    pub fn is_running(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    pub fn stop(&mut self) {
        self.runtime_state.store(0, Ordering::Release);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Ocr {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Nonblocking descriptors ensure readiness cannot lead to an unbounded read/write.
fn nonblocking(fd: RawFd) -> Result<(), String> {
    // SAFETY: the borrowed descriptor belongs to a live Child pipe.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// Poll in short slices so shutdown interrupts loading, writes, and responses.
fn wait_ready(
    fd: RawFd,
    events: i16,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<(), String> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("OCR cancelled".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Model worker IO timed out".into());
        }
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let millis = remaining.as_millis().clamp(1, 100) as i32;
        // SAFETY: poll receives one valid stack-allocated descriptor.
        let result = unsafe { libc::poll(&mut descriptor, 1, millis) };
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err("Invalid model pipe".into());
            }
            return Ok(());
        }
        if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
}

fn write_all(
    fd: RawFd,
    payload: &[u8],
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut offset = 0;
    while offset < payload.len() {
        wait_ready(fd, libc::POLLOUT, deadline, cancel)?;
        // SAFETY: payload remains alive and its slice bounds are valid.
        let n = unsafe {
            libc::write(
                fd,
                payload[offset..].as_ptr().cast(),
                payload.len() - offset,
            )
        };
        if n > 0 {
            offset += n as usize;
        } else if n == 0 {
            return Err("Model input closed".into());
        } else {
            let e = std::io::Error::last_os_error();
            if !matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ) {
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

fn receive(fd: RawFd, timeout: Duration, cancel: &AtomicBool) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let mut line = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        wait_ready(fd, libc::POLLIN, deadline, cancel)?;
        // SAFETY: buffer is writable for exactly its declared length.
        let n = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
        if n == 0 {
            return Err("Model worker closed its output".into());
        }
        if n < 0 {
            let e = std::io::Error::last_os_error();
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ) {
                continue;
            }
            return Err(e.to_string());
        }
        line.extend_from_slice(&buffer[..n as usize]);
        if line.len() > MAX_RESPONSE {
            return Err("Model response exceeds output limit".into());
        }
        if let Some(end) = line.iter().position(|b| *b == b'\n') {
            if end + 1 != line.len() {
                return Err("Model sent extra response data".into());
            }
            return serde_json::from_slice(&line[..end])
                .map_err(|e| format!("Invalid model response: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static FIXTURE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn fixture(body: &str) -> (PathBuf, Ocr) {
        let root = std::env::temp_dir().join(format!(
            "poker-ocr-test-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("dev_tools/training")).unwrap();
        std::fs::write(root.join("dev_tools/training/collector_inference.py"), body).unwrap();
        let env = HashMap::from([("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into())]);
        let ocr = Ocr::new(&root, &env);
        (root, ocr)
    }
    fn crops() -> Vec<(Vec<u8>, String)> {
        vec![(vec![1, 2], "seat.name".into())]
    }

    #[test]
    fn lazy_start_and_worker_reuse() {
        let (root, mut ocr) = fixture("import json,sys,os\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({'ok':True,'predictions':[{'pid':os.getpid(),'region':x['region_id']} for x in r['items']]}),flush=True)\n");
        assert!(ocr.child.is_none());
        let first = ocr.predict_many(crops()).unwrap();
        let second = ocr.predict_many(crops()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first[0]["region"], "seat.name");
        drop(ocr);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_batch_reaps_worker() {
        let (root, mut ocr) = fixture("import json,sys\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin: print('{\"ok\":true,\"predictions\":[]}',flush=True)\n");
        assert!(ocr
            .predict_many(crops())
            .unwrap_err()
            .contains("incomplete"));
        assert!(ocr.child.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_interrupts_partial_read_and_reaps() {
        let (root, mut ocr) =
            fixture("import sys,time\nsys.stdout.write('{');sys.stdout.flush()\ntime.sleep(30)\n");
        let cancel = ocr.cancellation();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, Ordering::Release);
        });
        let start = Instant::now();
        assert!(ocr.predict_many(crops()).unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(ocr.child.is_none());
        handle.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_empty_input_without_starting() {
        let (root, mut ocr) = fixture("");
        assert!(ocr.predict_many(vec![]).is_err());
        assert!(ocr.child.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
