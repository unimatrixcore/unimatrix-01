//! Persistent local CUDA reader transport. All access is serialized so a reply
//! cannot be mistaken for a different capture's result.
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

static SERVICE_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn configure_service(path: PathBuf) -> Result<(), String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    SERVICE_PATH
        .set(path)
        .map_err(|_| "OCR service already configured".to_owned())
}

const MAX_MESSAGE: usize = 48 * 1024 * 1024;
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();

/// Test-only phase observations never enter the production binary or alter
/// capture identity, cached pixels, reader decisions, or the freshness limit.
#[cfg(test)]
#[derive(Clone, Default, Serialize)]
struct CompositionTiming {
    request_started_monotonic_seconds: Option<f64>,
    request_finished_monotonic_seconds: Option<f64>,
    decode_started_monotonic_seconds: Option<f64>,
    decode_finished_monotonic_seconds: Option<f64>,
    compose_started_monotonic_seconds: Option<f64>,
    compose_finished_monotonic_seconds: Option<f64>,
    request_ms: Option<f64>,
    decode_ms: Option<f64>,
    compose_ms: Option<f64>,
    decoded_from_cache: bool,
}

#[cfg(test)]
std::thread_local! {
    static COMPOSITION_TIMING: std::cell::RefCell<CompositionTiming> =
        std::cell::RefCell::new(CompositionTiming::default());
}

/// Python and Rust both use Linux CLOCK_MONOTONIC, avoiding wall-clock jumps
/// and preserving the capture-start age across the process boundary.
pub fn monotonic_seconds() -> Result<f64, String> {
    #[repr(C)]
    struct Timespec {
        seconds: i64,
        nanoseconds: i64,
    }
    unsafe extern "C" {
        fn clock_gettime(clock: i32, time: *mut Timespec) -> i32;
    }
    let mut ts = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // CLOCK_MONOTONIC is Linux clock number 1; this application targets Linux.
    if unsafe { clock_gettime(1, &mut ts) } != 0 {
        return Err("Cannot read capture clock".into());
    }
    Ok(ts.seconds as f64 + ts.nanoseconds as f64 / 1_000_000_000.)
}

struct Bridge {
    child: Child,
    input: Arc<Mutex<ChildStdin>>,
    output: mpsc::Receiver<Result<Value, String>>,
}
impl Bridge {
    /// Start both models once. Readiness is required before taking a capture,
    /// so model initialization time never produces a misleading fresh frame.
    fn start() -> Result<Self, String> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
        let python = std::env::var_os("POKER_OCR_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::assistant::storage_paths::data_dir()
                    .join("ocr-training/desktop-gpu/bin/python")
            });
        let release = std::env::var_os("POKER_OCR_RELEASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::assistant::storage_paths::data_dir().join("ocr-training/release-candidate")
            });
        let service = std::env::var_os("POKER_OCR_SERVICE")
            .map(PathBuf::from)
            .or_else(|| SERVICE_PATH.get().cloned())
            .unwrap_or_else(|| root.join("dev_tools/training/ocr_service.py"));
        // Absolute overrides allow a packaged runtime to move away from the
        // source checkout baked into this development build.
        let service = service
            .canonicalize()
            .map_err(|e| format!("Invalid OCR service path: {e}"))?;
        let release = release
            .canonicalize()
            .map_err(|e| format!("Invalid OCR release path: {e}. Migrate legacy storage with python3 dev_tools/migrate_storage.py --repo <checkout>"))?;
        let working_dir = service.parent().ok_or("Missing OCR service directory")?;
        let mut child = Command::new(python)
            // Keep sidecar imports from writing __pycache__ beside source files.
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .arg(&service)
            .arg("--release")
            .arg(release)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Cannot start CUDA OCR service: {e}"))?;
        let input = Arc::new(Mutex::new(child.stdin.take().ok_or("Missing OCR stdin")?));
        let stdout = child.stdout.take().ok_or("Missing OCR stdout")?;
        let (sender, output) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                // A bounded line prevents a corrupt sidecar flooding host memory.
                let result = reader
                    .by_ref()
                    .take((MAX_MESSAGE + 1) as u64)
                    .read_until(b'\n', &mut line);
                let message = match result {
                    Ok(0) => Err("OCR service closed its output".into()),
                    Ok(_) if line.len() > MAX_MESSAGE => Err("OCR response exceeds limit".into()),
                    Ok(_) => serde_json::from_slice(&line)
                        .map_err(|e| format!("Invalid OCR response: {e}")),
                    Err(e) => Err(format!("OCR read failed: {e}")),
                };
                let failed = message.is_err();
                if sender.send(message).is_err() || failed {
                    break;
                }
            }
        });
        let mut bridge = Self {
            child,
            input,
            output,
        };
        let ready = bridge.receive(Duration::from_secs(60))?;
        if ready.get("ready") != Some(&Value::Bool(true)) {
            return Err(format!("CUDA OCR initialization failed: {ready}"));
        }
        let regions: Value = serde_json::from_str(&crate::assistant::storage_paths::config_string(
            "regions.json",
            include_str!("../../assets/regions.json"),
        )?)
        .map_err(|e| e.to_string())?;
        let colors: Value = serde_json::from_str(&crate::assistant::storage_paths::config_string(
            "colors.json",
            include_str!("../../assets/colors.json"),
        )?)
        .map_err(|e| e.to_string())?;
        if ready.get("protocol").and_then(Value::as_u64) != Some(1)
            || ready.get("regions") != Some(&regions)
            || ready.get("colors") != Some(&colors)
        {
            return Err("OCR service protocol/configuration differs from this app build".into());
        }
        Ok(bridge)
    }

    /// Each message has a bounded send and receive deadline. A blocked pipe
    /// cannot freeze the app indefinitely; the manager drops and kills it.
    fn request(&mut self, message: Value) -> Result<Value, String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > MAX_MESSAGE {
            return Err("OCR request exceeds limit".into());
        }
        let input = self.input.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = input
                .lock()
                .map_err(|_| "OCR input lock poisoned".to_string())
                .and_then(|mut stream| {
                    stream
                        .write_all(&bytes)
                        .and_then(|_| stream.flush())
                        .map_err(|e| format!("OCR write failed: {e}"))
                });
            let _ = sender.send(result);
        });
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "OCR request timed out".to_string())??;
        let response = self.receive(Duration::from_secs(2))?;
        if response.get("ok") != Some(&Value::Bool(true)) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("OCR request rejected")
                .into());
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Missing OCR result".into())
    }
    /// Receiving a parsed message is separated from writing for startup proof.
    fn receive(&mut self, timeout: Duration) -> Result<Value, String> {
        self.output
            .recv_timeout(timeout)
            .map_err(|_| "OCR response timed out".to_string())?
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Manager {
    bridge: Option<Bridge>,
    monitor: Option<String>,
    sequence: u64,
    pixels: VecDeque<(String, Vec<u8>, Option<Arc<image::DynamicImage>>)>,
}
impl Manager {
    /// A monitor change is a new capture authority, never a continuation of
    /// temporal agreement from the old monitor.
    fn prepare(&mut self, monitor: &str) -> Result<(), String> {
        if self.monitor.as_deref() != Some(monitor) {
            self.bridge = None;
            self.pixels.clear();
            self.monitor = Some(monitor.into());
        }
        if self.bridge.is_none() {
            self.bridge = Some(Bridge::start()?);
        }
        Ok(())
    }
    fn request(&mut self, message: Value) -> Result<Value, String> {
        let result = self
            .bridge
            .as_mut()
            .ok_or("OCR service is not running")?
            .request(message);
        if result.is_err() {
            self.bridge = None;
            self.pixels.clear();
        }
        result
    }
}

/// Capture response is intended only for the debug image. OCR stays in the
/// native process/sidecar path rather than round-tripping pixels through JS.
#[derive(Serialize)]
pub struct CaptureResponse {
    pub capture_id: String,
    pub screenshot_bytes: Vec<u8>,
}
#[derive(Serialize)]
pub struct ProductionState {
    pub state: String,
    pub reason: String,
    pub capture_age_ms: Option<f64>,
    pub frame_id: Option<String>,
    pub game_state: Option<crate::assistant::vision::GameState>,
    pub ocr_regions: Value,
}
impl ProductionState {
    fn unknown(reason: impl Into<String>) -> Self {
        Self {
            state: "unknown".into(),
            reason: reason.into(),
            capture_age_ms: None,
            frame_id: None,
            game_state: None,
            ocr_regions: json!({}),
        }
    }
}

/// Grab a lossless frame with an explicit deadline while draining stdout, so a
/// full PNG pipe cannot deadlock the child before it exits.
fn capture_png(mut command: Command) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Cannot start capture: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing capture stdout")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_MESSAGE + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Monitor capture timed out".to_string());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "Capture reader failed")?
        .map_err(|e| e.to_string())?;
    if !status?.success() {
        return Err("Monitor capture failed".into());
    }
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE {
        return Err("Invalid capture size".into());
    }
    Ok(bytes)
}

/// Capture identity and monotonic age are assigned before grim starts. Never
/// restamp an old PNG as if inference had captured it just now.
pub fn capture(monitor: &str, command: Command) -> Result<CaptureResponse, String> {
    let mut manager = MANAGER
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "OCR manager lock poisoned")?;
    manager.prepare(monitor)?;
    let captured_at = monotonic_seconds()?;
    let bytes = match capture_png(command) {
        Ok(bytes) => bytes,
        Err(error) => {
            manager.bridge = None;
            manager.pixels.clear();
            return Err(error);
        }
    };
    manager.sequence += 1;
    let capture_id = format!(
        "{}-{}-{:.9}",
        std::process::id(),
        manager.sequence,
        captured_at
    );
    // Share immutable decoded storage only for byte-identical PNGs. Genuine
    // capture identities and timestamps remain distinct for temporal policy.
    let decoded = manager
        .pixels
        .back()
        .filter(|(_, previous, _)| previous == &bytes)
        .and_then(|(_, _, decoded)| decoded.clone());
    manager
        .pixels
        .push_back((capture_id.clone(), bytes.clone(), decoded));
    while manager.pixels.len() > 4 {
        manager.pixels.pop_front();
    }
    manager.request(json!({"op":"submit","capture_id":capture_id,"captured_at":captured_at,"png_base64":base64::engine::general_purpose::STANDARD.encode(&bytes)}))?;
    Ok(CaptureResponse {
        capture_id,
        screenshot_bytes: bytes,
    })
}

/// Poll independently of inference. On any error or unavailable provenance,
/// return no game state; the frontend must clear previously displayed values.
pub fn latest(username: &str) -> Result<ProductionState, String> {
    let mut manager = MANAGER
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "OCR manager lock poisoned")?;
    let result = compose_latest(&mut manager, username);
    if result.is_err() {
        manager.bridge = None;
        manager.pixels.clear();
    }
    result
}

/// A malformed response or composition failure tears down the session rather
/// than preserving its temporal authority for a later poll.
fn compose_latest(manager: &mut Manager, username: &str) -> Result<ProductionState, String> {
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| *timing.borrow_mut() = CompositionTiming::default());
    if manager.bridge.is_none() {
        return Ok(ProductionState::unknown("OCR service is not running"));
    }
    #[cfg(test)]
    let request_started = Instant::now();
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| {
        timing.borrow_mut().request_started_monotonic_seconds = monotonic_seconds().ok();
    });
    let result = manager.request(json!({"op":"latest"}))?;
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| {
        let mut timing = timing.borrow_mut();
        timing.request_finished_monotonic_seconds = monotonic_seconds().ok();
        timing.request_ms = Some(request_started.elapsed().as_secs_f64() * 1000.);
    });
    if result.get("state").and_then(Value::as_str) != Some("available") {
        return Ok(ProductionState::unknown(
            result
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unavailable"),
        ));
    }
    let value = result.get("value").ok_or("Missing reader result")?;
    let Some(source_id) = source_identity(value) else {
        return Ok(ProductionState::unknown("Missing pixel provenance"));
    };
    let Some((_, pixels, decoded)) = manager.pixels.iter_mut().find(|(id, _, _)| id == source_id)
    else {
        return Ok(ProductionState::unknown("Source pixels expired"));
    };
    let captured_at = result
        .get("captured_at")
        .and_then(Value::as_f64)
        .ok_or("Missing capture time")?;
    let age = (monotonic_seconds()? - captured_at) * 1000.;
    if !(0.0..=1000.0).contains(&age) {
        return Ok(ProductionState::unknown("stale"));
    }
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| timing.borrow_mut().decoded_from_cache = decoded.is_some());
    if decoded.is_none() {
        #[cfg(test)]
        let decode_started = Instant::now();
        #[cfg(test)]
        COMPOSITION_TIMING.with(|timing| {
            timing.borrow_mut().decode_started_monotonic_seconds = monotonic_seconds().ok();
        });
        *decoded = Some(Arc::new(
            image::load_from_memory(pixels).map_err(|e| format!("Invalid source pixels: {e}"))?,
        ));
        #[cfg(test)]
        COMPOSITION_TIMING.with(|timing| {
            let mut timing = timing.borrow_mut();
            timing.decode_finished_monotonic_seconds = monotonic_seconds().ok();
            timing.decode_ms = Some(decode_started.elapsed().as_secs_f64() * 1000.);
        });
    }
    #[cfg(test)]
    let compose_started = Instant::now();
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| {
        timing.borrow_mut().compose_started_monotonic_seconds = monotonic_seconds().ok();
    });
    let state = crate::assistant::vision::compose_validated_image(
        decoded.as_ref().ok_or("Missing decoded source pixels")?,
        value,
        username,
    )?;
    #[cfg(test)]
    COMPOSITION_TIMING.with(|timing| {
        let mut timing = timing.borrow_mut();
        timing.compose_finished_monotonic_seconds = monotonic_seconds().ok();
        timing.compose_ms = Some(compose_started.elapsed().as_secs_f64() * 1000.);
    });
    // Composition itself consumes time, so enforce freshness again before IPC.
    let age = (monotonic_seconds()? - captured_at) * 1000.;
    if age > 1000. {
        return Ok(ProductionState::unknown("stale"));
    }
    Ok(ProductionState {
        state: "available".into(),
        reason: "validated".into(),
        capture_age_ms: Some(age),
        frame_id: Some(source_id.into()),
        game_state: Some(state),
        ocr_regions: value.get("regions").cloned().unwrap_or_else(|| json!({})),
    })
}

/// Select the newer pixel-validated image when present; worker sequence IDs
/// are deliberately not accepted as source-pixel identities.
fn source_identity(value: &Value) -> Option<&str> {
    value
        .get("validated_against_capture_id")
        .or_else(|| value.get("frame_id"))?
        .as_str()
}

/// Dropping the managed subprocess revokes all cached outputs and agreement.
pub fn stop() -> Result<(), String> {
    let mut manager = MANAGER
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "OCR manager lock poisoned")?;
    manager.bridge = None;
    manager.pixels.clear();
    manager.monitor = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // The ignored GPU tests share the process-managed sidecar and must serialize.
    static GPU_TEST_LOCK: Mutex<()> = Mutex::new(());
    #[test]
    fn current_pixel_identity_takes_precedence() {
        let value = json!({"frame_id":"A","validated_against_capture_id":"B"});
        assert_eq!(source_identity(&value), Some("B"));
        assert_eq!(source_identity(&json!({"frame_id":"A"})), Some("A"));
        assert_eq!(source_identity(&json!({})), None);
    }
    #[test]
    fn monotonic_clock_advances() {
        let a = monotonic_seconds().unwrap();
        let b = monotonic_seconds().unwrap();
        assert!(b >= a);
        assert!(a > 0.);
    }

    /// Isolate CPU decode and composition using a sealed, already captured
    /// source and its exact same-request reader reply. This starts no sidecar,
    /// creates no new capture identity, and makes no end-to-end freshness claim.
    #[test]
    #[ignore = "requires explicit archived input/profile and a new timing report path"]
    fn archived_decode_compose_timing() {
        let root = PathBuf::from(
            std::env::var_os("POKER_OCR_TIMING_INPUT").expect("Explicit archived input required"),
        );
        let destination = PathBuf::from(
            std::env::var_os("POKER_OCR_TIMING_REPORT").expect("New diagnostic report required"),
        );
        assert!(root.is_absolute() && destination.is_absolute());
        assert!(!destination.exists(), "Preserve previous timing evidence");
        let profile = std::env::var("POKER_OCR_TIMING_PROFILE").unwrap();
        assert!(matches!(profile.as_str(), "debug" | "release"));
        assert_eq!(cfg!(debug_assertions), profile == "debug");
        let public: Value =
            serde_json::from_slice(&std::fs::read(root.join("native-publication.json")).unwrap())
                .unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        let captures: Vec<Value> = std::fs::read_to_string(root.join("captures.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let mut sources = std::collections::BTreeSet::new();
        let mut measurements = Vec::new();
        let replies = std::fs::read_to_string(root.join("private/poll-states.jsonl")).unwrap();
        for line in replies.lines() {
            let row: Value = serde_json::from_str(line).unwrap();
            let raw = &row["raw_service_reply"];
            if raw["state"] != "available" {
                continue;
            }
            let value = &raw["value"];
            let source_id = source_identity(value).expect("Exact source identity required");
            if !sources.insert(source_id.to_owned()) {
                continue;
            }
            assert_eq!(
                value["configuration_fingerprint"],
                manifest["freeze"]["configuration_fingerprint"]
            );
            let source = public["captures"]
                .as_array()
                .unwrap()
                .iter()
                .find(|source| source["capture_id"] == source_id)
                .expect("Reader source must be one of the actual archived captures");
            let filename = source["source_filename"].as_str().unwrap();
            assert!(filename.starts_with("sources/") && !filename.contains(".."));
            let capture = captures
                .iter()
                .find(|capture| capture["source_id"] == source_id)
                .unwrap();
            let bytes = std::fs::read(root.join(filename)).unwrap();
            assert_eq!(bytes.len() as u64, source["png_bytes"].as_u64().unwrap());

            // Disk reading and JSON parsing are outside the timers: production
            // already owns these exact PNG bytes and parsed reader decisions.
            let decode_start_clock = monotonic_seconds().unwrap();
            let decode_start = Instant::now();
            let image = image::load_from_memory(&bytes).unwrap();
            let decode_ms = decode_start.elapsed().as_secs_f64() * 1000.;
            let decode_end_clock = monotonic_seconds().unwrap();
            let compose_start = Instant::now();
            let game =
                crate::assistant::vision::compose_validated_image(&image, value, "").unwrap();
            let compose_ms = compose_start.elapsed().as_secs_f64() * 1000.;
            let compose_end_clock = monotonic_seconds().unwrap();
            assert!(game.game_id.is_some());
            let mut repeat_compose_ms = Vec::new();
            for _ in 0..3 {
                let repeat_start = Instant::now();
                let repeated =
                    crate::assistant::vision::compose_validated_image(&image, value, "").unwrap();
                repeat_compose_ms.push(repeat_start.elapsed().as_secs_f64() * 1000.);
                assert_eq!(repeated.game_id, game.game_id);
                assert_eq!(repeated.in_play_seats, game.in_play_seats);
            }
            measurements.push(json!({
                "source_id":source_id,"source_filename":filename,
                "source_sha256":capture["sha256"],"png_bytes":bytes.len(),
                "configuration_fingerprint":value["configuration_fingerprint"],
                "decode_ms":decode_ms,"compose_ms":compose_ms,
                "repeat_compose_ms":repeat_compose_ms,
                "decode_started_monotonic_seconds":decode_start_clock,
                "decode_finished_monotonic_seconds":decode_end_clock,
                "compose_finished_monotonic_seconds":compose_end_clock,
                "admitted_seats":game.in_play_seats.len(),
                "observed_turn_seat":game.active_seat
            }));
        }
        assert!(!measurements.is_empty());
        let report = json!({
            "scope":"CPU-only archived exact-source phase timing; no sidecar, neural inference, capture, fabricated acquisition time, or freshness qualification.",
            "profile":profile,"debug_assertions":cfg!(debug_assertions),
            "input":root,"measurements":measurements,
            "source_checks":"Exact same-request current-source ID, frozen configuration fingerprint, source manifest hash identity and PNG byte length; source-file SHA256 must also be checked by the diagnostic orchestrator.",
            "limitations":"Decode and compose are separately timed on current compiled native code. Reused archived sources are correlated and this CPU control does not establish live publication capacity."
        });
        use std::fs::OpenOptions;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&report).unwrap())
            .unwrap();
        println!(
            "ARCHIVED_CPU_PHASE_TIMING profile={profile} sources={}",
            sources.len()
        );
    }

    #[test]
    #[ignore = "requires local frozen models and desktop CUDA access"]
    fn archived_gpu_bridge_acceptance() {
        let _exclusive = GPU_TEST_LOCK.lock().unwrap();
        stop().unwrap();
        let path = crate::assistant::storage_paths::data_dir()
            .join("ocr-training/release-candidate/sealed-captures/cap_1785699828118.png");
        let mut timings = Vec::new();
        let mut final_state = None;
        for index in 0..4 {
            let start = Instant::now();
            let mut command = Command::new("cat");
            command.arg(&path);
            let capture = capture("archived-gpu-test", command).unwrap();
            let capture_ms = start.elapsed().as_secs_f64() * 1000.;
            assert!(!capture.screenshot_bytes.is_empty());
            // Archived-pixel replay tests transport and composition only. These
            // generated identities are not independent optical observations.
            std::thread::sleep(Duration::from_millis(150));
            let poll = Instant::now();
            let state = latest("Player 6").unwrap();
            timings.push(json!({"index":index,"capture_ms":capture_ms,"poll_ms":poll.elapsed().as_secs_f64()*1000.,"state":state.state,"age_ms":state.capture_age_ms}));
            if state.state == "available" {
                final_state = state.game_state;
            }
            let elapsed = start.elapsed();
            if elapsed < Duration::from_millis(500) {
                std::thread::sleep(Duration::from_millis(500) - elapsed);
            }
        }
        let game = final_state.expect("No confirmed native game state");
        assert_eq!(game.game_id.as_deref(), Some("#75805752"));
        assert_eq!(
            game.seat_banks.get(&2).map(String::as_str),
            Some("G 398.1 BB")
        );
        assert_eq!(
            game.seat_usernames.get(&2).map(String::as_str),
            // Source-pixel review confirmed the literal anonymous-name space;
            // the historical fixture had silently removed it.
            Some("Player 6")
        );
        assert_eq!(game.my_seat_index, Some(2));
        assert_eq!(game.community_cards.len(), 5);
        for (index, rank) in ["J", "4", "3", "7"].iter().enumerate() {
            assert!(game.community_cards[index]
                .as_ref()
                .is_some_and(|card| card.starts_with(rank)));
        }
        assert!(game.community_cards[4].is_none());
        stop().unwrap();
        assert!(latest("Player 6").unwrap().game_state.is_none());
        println!(
            "NATIVE_BRIDGE_REPLAY {}",
            serde_json::to_string(&timings).unwrap()
        );
    }
    #[test]
    #[ignore = "requires local frozen models and desktop CUDA access"]
    fn archived_changing_gpu_bridge_acceptance() {
        let _exclusive = GPU_TEST_LOCK.lock().unwrap();
        stop().unwrap();
        let replay: Value = serde_json::from_slice(
            &std::fs::read(
                crate::assistant::storage_paths::data_dir()
                    .join("ocr-training/production-v11/reader-replay-dual-gpu.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let sources = replay["frames"].as_array().unwrap();
        assert_eq!(sources.len(), 7);
        MANAGER
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .prepare("archived-changing-gpu-test")
            .unwrap();
        let mut captures = Vec::new();
        let mut polls = Vec::new();
        let start = Instant::now();
        // Repeated polling between captures matters: inference may complete
        // after an early poll but before the next500ms acquisition deadline.
        let mut poll_state = |source_index: usize, index: usize| {
            let poll = Instant::now();
            let state = latest("").unwrap();
            if let Some(age) = state.capture_age_ms {
                assert!((0.0..=1000.0).contains(&age));
            }
            let accepted = state
                .ocr_regions
                .as_object()
                .map(|regions| {
                    regions
                        .values()
                        .filter(|r| {
                            matches!(r["decision"]["state"].as_str(), Some("text" | "blank"))
                        })
                        .count()
                })
                .unwrap_or(0);
            polls.push(json!({"after_submission":index,"source_id":sources[source_index]["source_id"],"at_ms":poll.duration_since(start).as_secs_f64()*1000.,"poll_ms":poll.elapsed().as_secs_f64()*1000.,"state":state.state,"reason":state.reason,"published_frame_id":state.frame_id,"age_ms":state.capture_age_ms,"accepted_regions":accepted,"game_id":state.game_state.as_ref().and_then(|g|g.game_id.as_deref())}));
        };
        for (source_index, source) in sources.iter().enumerate() {
            let filename = source["source_filename"].as_str().unwrap();
            assert_eq!(
                std::path::Path::new(filename).file_name().unwrap(),
                filename
            );
            let path = crate::assistant::storage_paths::data_dir()
                .join("collector_datasets/legacy/full_captures")
                .join(filename);
            for observation in 0..3 {
                let index = source_index * 3 + observation;
                let target = Duration::from_millis(index as u64 * 500);
                if start.elapsed() < target {
                    std::thread::sleep(target - start.elapsed());
                }
                let acquired = Instant::now();
                let mut command = Command::new("cat");
                command.arg(&path);
                let capture = capture("archived-changing-gpu-test", command).unwrap();
                assert!(!capture.screenshot_bytes.is_empty());
                captures.push(json!({"index":index,"source_id":source["source_id"],"source_filename":filename,"observation":observation,"capture_start_ms":acquired.duration_since(start).as_secs_f64()*1000.,"capture_ms":acquired.elapsed().as_secs_f64()*1000.,"capture_id":capture.capture_id}));
                let next = Duration::from_millis((index + 1) as u64 * 500);
                while start.elapsed() < next {
                    poll_state(source_index, index);
                    if start.elapsed() < next {
                        std::thread::sleep(Duration::from_millis(100).min(next - start.elapsed()));
                    }
                }
            }
        }
        let expiry_deadline = Duration::from_millis(21 * 500 + 1100);
        while start.elapsed() < expiry_deadline {
            poll_state(6, 20);
            std::thread::sleep(Duration::from_millis(100));
        }
        stop().unwrap();
        let available = polls.iter().filter(|r| r["state"] == "available").count();
        let maximum_age = polls
            .iter()
            .filter_map(|r| r["age_ms"].as_f64())
            .fold(0.0_f64, f64::max);
        let report = json!({"source_frames":sources.len(),"submitted":captures.len(),"target_period_ms":500,"target_poll_period_ms":100,"available_polls":available,"unknown_polls":polls.len()-available,"maximum_published_age_ms":maximum_age,"stale_publications":polls.iter().filter(|r|r["age_ms"].as_f64().is_some_and(|age|age>1000.)).count(),"seconds":start.elapsed().as_secs_f64(),"limitations":"Archived changing full-frame pixels with generated acquisition identities/times via cat. This tests native transport, actual CUDA inference, temporal admission, exact-source color composition and TTL. No live capture or accuracy claim; sources and labels were previously used in development. Capture and poll IPC serialize as in the app; expensive debug composition may delay acquisition, with actual capture starts recorded.","captures":captures,"polls":polls});
        // Keep a new qualification run's evidence separate from historical
        // release reports; this override affects only this ignored replay test.
        let report_path = std::env::var_os("POKER_OCR_BRIDGE_REPORT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::assistant::storage_paths::data_dir()
                    .join("ocr-training/release-candidate/native-changing-frame-acceptance.json")
            });
        std::fs::write(report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!(
            "NATIVE_CHANGING_BRIDGE_REPLAY {}",
            serde_json::to_string(&report).unwrap()
        );
        assert!(
            available > 0,
            "No bounded native state publications under changing replay"
        );
    }

    /// Explicitly opted-in optical capture probe. Text stays in private artifacts;
    /// public observations contain only provenance, counts, and elapsed times.
    #[test]
    #[ignore = "requires explicit DP-2 capture opt-in, frozen CUDA models, and new artifact directory"]
    fn live_dp2_native_capture_publication() {
        use std::collections::BTreeMap;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let _exclusive = GPU_TEST_LOCK.lock().unwrap();
        let output = PathBuf::from(
            std::env::var_os("POKER_OCR_LIVE_OUTPUT")
                .expect("POKER_OCR_LIVE_OUTPUT must explicitly name a new artifact directory"),
        );
        assert!(
            output.is_absolute(),
            "An absolute artifact destination is required"
        );
        assert_eq!(
            std::env::var("POKER_OCR_LIVE_MONITOR").as_deref(),
            Ok("DP-2")
        );
        assert!(std::env::var_os("POKER_OCR_RELEASE").is_some());
        assert!(std::env::var_os("POKER_OCR_PYTHON").is_some());
        // Refuse reuse so older images/predictions cannot contaminate this run.
        std::fs::create_dir(&output).expect("Use a new live evidence directory");
        std::fs::create_dir(output.join("sources")).unwrap();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(output.join("private"))
            .unwrap();
        let mut private = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(output.join("private/poll-states.jsonl"))
            .unwrap();
        stop().unwrap();
        // Model startup precedes acquisition so it never restamps old pixels.
        MANAGER
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .prepare("DP-2")
            .unwrap();
        // Passively copy the same replies already received by the app. This
        // test-only relay issues no additional requests and changes no runtime
        // implementation; it makes protocol versus composition time visible.
        let (observed_sender, observed_replies) = mpsc::channel();
        {
            let mut manager = MANAGER.get_or_init(Default::default).lock().unwrap();
            let bridge = manager.bridge.as_mut().unwrap();
            let (forward_sender, forward_receiver) = mpsc::sync_channel(1);
            let original = std::mem::replace(&mut bridge.output, forward_receiver);
            std::thread::spawn(move || {
                while let Ok(message) = original.recv() {
                    if let Ok(value) = &message {
                        let _ = observed_sender.send((Instant::now(), value.clone()));
                    }
                    if forward_sender.send(message).is_err() {
                        break;
                    }
                }
            });
        }
        let start = Instant::now();
        let mut captures = Vec::new();
        let mut polls = Vec::new();
        let mut errors = Vec::new();
        let mut newest: Option<String> = None;
        let mut times = BTreeMap::<String, f64>::new();
        let mut maximum_dropped = 0_u64;
        // One genuine app latest() call per poll. The passive tap preserves
        // that call's processed and current IDs without doubling IPC workload.
        let mut poll_state = |index: usize,
                              newest: &Option<String>,
                              times: &BTreeMap<String, f64>| {
            let poll_start = Instant::now();
            let poll_started_monotonic_seconds = monotonic_seconds().unwrap();
            let composed = latest("");
            let composition_finished = Instant::now();
            let poll_finished_monotonic_seconds = monotonic_seconds().unwrap();
            let subphase_timing = COMPOSITION_TIMING.with(|timing| timing.borrow().clone());
            let replies: Vec<_> = observed_replies.try_iter().collect();
            let protocol_reply = replies.last();
            let raw = protocol_reply.and_then(|(_, reply)| reply.get("result"));
            let mut record = json!({"after_submission":index,"newest_submitted_capture_id":newest,
                    "at_ms":poll_start.duration_since(start).as_secs_f64()*1000.,
                    "poll_started_monotonic_seconds":poll_started_monotonic_seconds,
                    "poll_finished_monotonic_seconds":poll_finished_monotonic_seconds,
                    "native_subphase_timing":subphase_timing});
            if let Some(raw) = raw {
                maximum_dropped = maximum_dropped.max(raw["dropped_count"].as_u64().unwrap_or(0));
                let processed = raw["value"]["frame_id"].as_str().or_else(|| {
                    raw["captured_at"].as_f64().and_then(|captured| {
                        times
                            .iter()
                            .find(|(_, time)| (**time - captured).abs() < 0.00000001)
                            .map(|(id, _)| id.as_str())
                    })
                });
                let source = source_identity(&raw["value"]);
                record["raw_state"] = raw["state"].clone();
                record["raw_reason"] = raw["reason"].clone();
                record["processed_worker_sequence"] = raw["frame_id"].clone();
                record["submitted_worker_sequence"] = raw["submitted_frame_id"].clone();
                record["processed_capture_id"] = json!(processed);
                record["validated_against_capture_id"] = json!(source);
                record["processed_capture_started_monotonic_seconds"] = raw["captured_at"].clone();
                record["source_capture_started_monotonic_seconds"] =
                    json!(source.and_then(|id| times.get(id)));
                record["dropped_count"] = raw["dropped_count"].clone();
            } else {
                record["raw_error"] = json!("No matching protocol reply observed");
            }
            let private_composed = match &composed {
                Ok(state) => serde_json::to_value(state).unwrap(),
                Err(error) => json!({"error":error}),
            };
            if let Ok(state) = &composed {
                let mut counts = BTreeMap::<String, usize>::new();
                if let Some(regions) = state.ocr_regions.as_object() {
                    for region in regions.values() {
                        *counts
                            .entry(
                                region["decision"]["state"]
                                    .as_str()
                                    .unwrap_or("missing")
                                    .into(),
                            )
                            .or_default() += 1;
                    }
                }
                record["state"] = json!(state.state);
                record["reason"] = json!(state.reason);
                record["published_capture_id"] = json!(state.frame_id);
                record["published_age_ms"] = json!(state.capture_age_ms);
                record["published_region_decision_counts"] = json!(counts);
            } else {
                record["state"] = json!("error");
                record["error"] = json!(composed.as_ref().err());
            }
            if let Some((received, _)) = protocol_reply {
                record["protocol_ms"] =
                    json!(received.saturating_duration_since(poll_start).as_secs_f64() * 1000.);
                record["composition_after_protocol_ms"] = json!(
                    composition_finished
                        .saturating_duration_since(*received)
                        .as_secs_f64()
                        * 1000.
                );
            }
            let private_raw = raw
                .cloned()
                .unwrap_or_else(|| json!({"error":"missing_protocol_reply"}));
            writeln!(
                private,
                "{}",
                json!({"public_poll_index":polls.len(),"raw_service_reply":private_raw,
                    "native_publication":private_composed})
            )
            .unwrap();
            record["poll_ms"] = json!(
                composition_finished
                    .duration_since(poll_start)
                    .as_secs_f64()
                    * 1000.
            );
            record["instrumented_poll_with_artifact_ms"] =
                json!(poll_start.elapsed().as_secs_f64() * 1000.);
            polls.push(record);
        };
        for index in 0..20_usize {
            let target = Duration::from_millis(index as u64 * 500);
            if start.elapsed() < target {
                std::thread::sleep(target - start.elapsed());
            }
            let acquired = Instant::now();
            // Precisely the app's lossless, cursor-free grim arguments. This
            // test never sends mouse, keyboard, browser, or game input.
            let mut command = Command::new("grim");
            command
                .env(
                    "WAYLAND_DISPLAY",
                    std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-1".into()),
                )
                .env(
                    "XDG_RUNTIME_DIR",
                    std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/run/user/1000".into()),
                )
                .args(["-o", "DP-2", "-t", "png", "-l", "1", "-"]);
            match capture("DP-2",command) {
                    Ok(capture)=>{
                        // The ID contains the actual Rust CLOCK_MONOTONIC sample
                        // assigned before grim, rather than this file-write time.
                        let captured_at:f64=capture.capture_id.rsplit('-').next().unwrap().parse().unwrap();
                        let filename=format!("sources/frame-{index:03}.png");
                        std::fs::write(output.join(&filename),&capture.screenshot_bytes).unwrap();
                        times.insert(capture.capture_id.clone(),captured_at);
                        newest=Some(capture.capture_id.clone());
                        captures.push(json!({"index":index,"source_filename":filename,"capture_id":capture.capture_id,
                            "capture_started_monotonic_seconds":captured_at,"capture_start_ms":acquired.duration_since(start).as_secs_f64()*1000.,
                            "capture_ms":acquired.elapsed().as_secs_f64()*1000.,"png_bytes":capture.screenshot_bytes.len()}));
                    },
                    Err(error)=>errors.push(json!({"index":index,"error":error,"at_ms":acquired.duration_since(start).as_secs_f64()*1000.})),
                }
            let next = Duration::from_millis((index as u64 + 1) * 500);
            while start.elapsed() < next {
                poll_state(index, &newest, &times);
                if start.elapsed() < next {
                    std::thread::sleep(Duration::from_millis(100).min(next - start.elapsed()));
                }
            }
        }
        // Continue polling beyond the last capture's TTL, retaining actual
        // expiry reasons instead of inferring stale behavior from the clock.
        let drain_end = start.elapsed() + Duration::from_millis(1100);
        while start.elapsed() < drain_end {
            poll_state(19, &newest, &times);
            if start.elapsed() < drain_end {
                std::thread::sleep(Duration::from_millis(100).min(drain_end - start.elapsed()));
            }
        }
        drop(poll_state);
        private.flush().unwrap();
        stop().unwrap();
        let available = polls.iter().filter(|p| p["state"] == "available").count();
        let unknown = polls.iter().filter(|p| p["state"] == "unknown").count();
        let stale = polls
            .iter()
            .filter(|p| {
                p["published_age_ms"]
                    .as_f64()
                    .is_some_and(|age| age > 1000.)
            })
            .count();
        let mut reasons = BTreeMap::<String, usize>::new();
        for poll in &polls {
            *reasons
                .entry(poll["reason"].as_str().unwrap_or("error").into())
                .or_default() += 1;
        }
        let report = json!({"schema_version":1,"monitor":"DP-2","capture_command":["grim","-o","DP-2","-t","png","-l","1","-"],
                "release":std::env::var("POKER_OCR_RELEASE").unwrap(),"python":std::env::var("POKER_OCR_PYTHON").unwrap(),
                "submitted":captures.len(),"target_captures":20,"target_period_ms":500,"target_poll_period_ms":100,
                "drain_ms":1100,"seconds":start.elapsed().as_secs_f64(),"available_polls":available,"unknown_polls":unknown,
                "poll_errors":polls.len()-available-unknown,"maximum_dropped_count":maximum_dropped,"stale_publications":stale,"reason_counts":reasons,
                "placement":{"current_session_operator_placement":"unavailable: native ready handshake has no placement field",
                    "scope":"Provider registration is not operator placement. Consult separate frozen-model placement evidence."},
                "limitations":"Real native optical capture/submit/compose with one latest request per poll. Test-only passive response relay copies existing replies and adds no protocol requests. No truth labels, text accuracy, game input, or production promotion. Public metadata contains no recognized text.",
                "captures":captures,"polls":polls,"capture_errors":errors});
        std::fs::write(
            output.join("native-publication.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        // Counts alone may enter logs, including failure logs. Sources and raw
        // replies are preserved for an independent later review.
        println!(
            "LIVE_NATIVE_CAPTURE submitted={} available_polls={} unknown_polls={} capture_errors={}",
            captures.len(),
            available,
            unknown,
            errors.len()
        );
        assert_eq!(
            captures.len(),
            20,
            "Capture failures; inspect public evidence"
        );
        assert_eq!(stale, 0, "Native publication exceeded freshness bound");
        assert!(
            available > 0,
            "No native publication; inspect public evidence"
        );
    }
}
