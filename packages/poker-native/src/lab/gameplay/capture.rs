//! Native screenshot acquisition. Every capture stays bound to the selected
//! monitor or session-scoped window identity; failures never widen the source.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};

const PROTOCOL: &str = "/usr/share/wayland-protocols/staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml";
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 128 * 1024 * 1024;

/// A provider keeps its launch environment immutable across source reloads.
/// The helper build lock never covers capture or the application's UI thread.
pub struct Capture {
    repo: PathBuf,
    environment: HashMap<String, String>,
    build_lock: Mutex<()>,
}

/// Temporary directories use unique names and remove rejected screenshot bytes
/// on every return path, including failures and unwinding.
struct Temporary(PathBuf);
impl Temporary {
    fn new(parent: &Path) -> Result<Self, String> {
        let path = parent.join(format!("poker-native-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&path).map_err(|e| format!("Cannot create capture workspace: {e}"))?;
        Ok(Self(path))
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Capture {
    /// Use the source checkout and supplied environment, rather than process
    /// globals, so an in-place reload cannot mix compositor sessions.
    pub fn new(repo: PathBuf, environment: HashMap<String, String>) -> Self {
        Self {
            repo,
            environment,
            build_lock: Mutex::new(()),
        }
    }

    /// Drain both pipes concurrently: a verbose failing helper must not fill
    /// stderr and deadlock the screenshot request. Time and output are bounded.
    fn run(&self, program: &str, arguments: &[String], seconds: u64) -> Result<Vec<u8>, String> {
        let mut command = Command::new(program);
        command
            .args(arguments)
            .env_clear()
            .envs(&self.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start {program}: {e}"))?;
        let (sender, receiver) = mpsc::channel();
        for (is_error, pipe) in [
            (
                false,
                Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            ),
            (
                true,
                Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
            ),
        ] {
            let sender = sender.clone();
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let result = pipe
                    .take(OUTPUT_LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())
                    .and_then(|_| {
                        if bytes.len() as u64 > OUTPUT_LIMIT {
                            Err("Helper output exceeded its limit".into())
                        } else {
                            Ok(bytes)
                        }
                    });
                let _ = sender.send((is_error, result));
            });
        }
        drop(sender);
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut stdout = None;
        let mut stderr = None;
        let status = loop {
            while let Ok((is_error, result)) = receiver.try_recv() {
                match result {
                    Ok(bytes) => {
                        if is_error {
                            stderr = Some(bytes)
                        } else {
                            stdout = Some(bytes)
                        }
                    }
                    Err(error) => {
                        stop_process(&mut child);
                        return Err(format!("{program}: {error}"));
                    }
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Ok(None) => {
                    stop_process(&mut child);
                    return Err(format!("{program} timed out after {seconds} seconds"));
                }
                Err(error) => {
                    stop_process(&mut child);
                    return Err(format!("Cannot wait for {program}: {error}"));
                }
            }
        };
        // A misbehaving descendant may keep a pipe open after its parent exits.
        // Do not join reader threads indefinitely in that case.
        while stdout.is_none() || stderr.is_none() {
            let (is_error, result) =
                receiver.recv_timeout(Duration::from_secs(1)).map_err(|_| {
                    stop_process(&mut child);
                    format!("{program} did not close its output")
                })?;
            let bytes = result.map_err(|error| {
                stop_process(&mut child);
                format!("{program}: {error}")
            })?;
            if is_error {
                stderr = Some(bytes)
            } else {
                stdout = Some(bytes)
            }
        }
        if !status.success() {
            let message = String::from_utf8_lossy(stderr.as_ref().unwrap())
                .chars()
                .take(300)
                .collect::<String>();
            return Err(format!("{program} failed: {}", message.trim()));
        }
        Ok(stdout.unwrap())
    }

    fn wayland(&self) -> bool {
        self.environment
            .get("WAYLAND_DISPLAY")
            .is_some_and(|s| !s.is_empty())
            || !self
                .environment
                .get("DISPLAY")
                .is_some_and(|s| !s.is_empty())
    }

    /// Monitor enumeration does not capture pixels and does not substitute an
    /// arbitrary display if the saved selection no longer exists.
    fn monitors(&self) -> Result<Vec<Value>, String> {
        if self.wayland() {
            let raw = self.run("hyprctl", &["monitors".into(), "-j".into()], 4)?;
            let data: Vec<Value> = serde_json::from_slice(&raw)
                .map_err(|e| format!("Invalid monitor inventory: {e}"))?;
            Ok(data
                .into_iter()
                .filter_map(|monitor| {
                    let name = monitor["name"].as_str()?;
                    Some(json!({"name":name, "kind":"monitor", "label":name,
                    "width":monitor["width"], "height":monitor["height"]}))
                })
                .collect())
        } else {
            let raw = self.run("xrandr", &["--query".into()], 4)?;
            Ok(parse_xrandr(&String::from_utf8_lossy(&raw)))
        }
    }

    /// Reuse the tiny native Wayland inventory helper. Its content-addressed
    /// cache is compatible with the earlier provider and is built atomically.
    fn inventory_helper(&self) -> Result<PathBuf, String> {
        let _guard = self
            .build_lock
            .lock()
            .map_err(|_| "Window helper build lock failed")?;
        let source = self.repo.join("dev_tools/lib/native/window_sources.c");
        let protocol = Path::new(PROTOCOL);
        let flags = self.run(
            "pkg-config",
            &["--cflags".into(), "--libs".into(), "wayland-client".into()],
            5,
        )?;
        let mut digest = Sha256::new();
        digest.update(fs::read(&source).map_err(|e| format!("Cannot read window helper: {e}"))?);
        digest
            .update(fs::read(protocol).map_err(|e| format!("Cannot read Wayland protocol: {e}"))?);
        digest.update(&flags);
        let hash = format!("{:x}", digest.finalize());
        let cache = crate::lab::model::storage_paths::directory(&self.environment, "cache")
            .join("ocr-window-capture");
        fs::create_dir_all(&cache)
            .map_err(|e| format!("Cannot create window helper cache: {e}"))?;
        let target = cache.join(format!("window-sources-{}", &hash[..20]));
        if target.is_file() {
            return Ok(target);
        }
        let temporary = Temporary::new(&cache)?;
        let header = temporary
            .0
            .join("ext-foreign-toplevel-list-v1-client-protocol.h");
        let code = temporary.0.join("protocol.c");
        let binary = temporary.0.join("window-sources");
        self.run(
            "wayland-scanner",
            &[
                "client-header".into(),
                path_text(protocol)?,
                path_text(&header)?,
            ],
            10,
        )?;
        self.run(
            "wayland-scanner",
            &[
                "private-code".into(),
                path_text(protocol)?,
                path_text(&code)?,
            ],
            10,
        )?;
        let mut arguments = vec![
            "-O2".into(),
            "-Wall".into(),
            "-Wextra".into(),
            "-I".into(),
            path_text(&temporary.0)?,
            path_text(&source)?,
            path_text(&code)?,
            "-o".into(),
            path_text(&binary)?,
        ];
        // pkg-config emits system include/library switches, not user input.
        // Split without a shell so no expansion or command execution is possible.
        arguments.extend(
            String::from_utf8_lossy(&flags)
                .split_whitespace()
                .map(String::from),
        );
        self.run("cc", &arguments, 20)?;
        fs::rename(binary, &target).map_err(|e| format!("Cannot install window helper: {e}"))?;
        Ok(target)
    }

    /// A window token incorporates the compositor socket inode as well as its
    /// identifier and app ID, preventing reuse after logout or compositor restart.
    fn windows(&self) -> Result<HashMap<String, Value>, String> {
        let helper = self.inventory_helper()?;
        let raw = self.run(&path_text(&helper)?, &[], 4)?;
        let data: Value =
            serde_json::from_slice(&raw).map_err(|e| format!("Invalid window inventory: {e}"))?;
        if !["toplevel", "image_copy", "toplevel_source"]
            .iter()
            .all(|key| data["capabilities"][key].as_bool() == Some(true))
        {
            return Err("This compositor does not support window surface capture".into());
        }
        let help = self.run("grim", &["-h".into()], 3)?;
        if !String::from_utf8_lossy(&help).contains("-T ") {
            return Err("Installed grim does not support window capture (-T)".into());
        }
        let windows = data["windows"]
            .as_array()
            .ok_or("Invalid window inventory")?;
        let runtime = self
            .environment
            .get("XDG_RUNTIME_DIR")
            .cloned()
            .unwrap_or_else(|| {
                // SAFETY: getuid takes no arguments, returns the real user ID,
                // and cannot access or modify Rust-owned memory.
                format!("/run/user/{}", unsafe { libc::getuid() })
            });
        let socket = Path::new(&runtime).join(
            self.environment
                .get("WAYLAND_DISPLAY")
                .map(String::as_str)
                .unwrap_or("wayland-0"),
        );
        #[cfg(unix)]
        let socket_id = fs::metadata(socket)
            .map(|stat| format!("{}:{}", stat.dev(), stat.ino()))
            .unwrap_or_default();
        #[cfg(not(unix))]
        let socket_id = String::new();
        let instance = format!(
            "{}:{socket_id}",
            self.environment
                .get("HYPRLAND_INSTANCE_SIGNATURE")
                .map(String::as_str)
                .unwrap_or("")
        );
        Ok(window_snapshot(windows, &instance))
    }

    /// A compositor without window protocols can still offer monitor capture.
    /// Private protocol identifiers never leave this backend.
    pub fn sources(&self) -> Result<Vec<Value>, String> {
        let mut sources = self.monitors()?;
        if self.wayland() {
            if let Ok(windows) = self.windows() {
                sources.extend(windows.into_values().map(|mut value| {
                    value.as_object_mut().unwrap().remove("identifier");
                    value
                }));
            }
        }
        Ok(sources)
    }

    /// Capture exactly the selected source and retain the original encoded PNG.
    /// The caller performs dimension and OCR admission before storing it.
    pub fn capture(&self, source: &str) -> Result<Vec<u8>, String> {
        let temporary = Temporary::new(&crate::lab::model::storage_paths::runtime_dir(
            &self.environment,
        )?)?;
        let destination = temporary.0.join("capture.png");
        if source.starts_with("window:") {
            if !self.wayland() {
                return Err("Window surface capture is unavailable on X11".into());
            }
            let before = self.windows()?.remove(source).ok_or("The selected window is closed or belongs to an earlier desktop session. Choose the window again.")?;
            let identifier = before["identifier"]
                .as_str()
                .ok_or("Invalid window identity")?;
            self.run(
                "grim",
                &["-T".into(), identifier.into(), path_text(&destination)?],
                8,
            )?;
            let after = self
                .windows()?
                .remove(source)
                .ok_or("The selected window closed during capture")?;
            if before["identifier"] != after["identifier"] || before["app_id"] != after["app_id"] {
                return Err("The selected window changed identity during capture".into());
            }
        } else {
            let monitor = self
                .monitors()?
                .into_iter()
                .find(|monitor| monitor["name"] == source)
                .ok_or("Select an available capture source")?;
            if self.wayland() {
                self.run(
                    "grim",
                    &["-o".into(), source.into(), path_text(&destination)?],
                    8,
                )?;
            } else {
                let geometry = format!(
                    "{}x{}{:+}{:+}",
                    monitor["width"].as_u64().unwrap_or(0),
                    monitor["height"].as_u64().unwrap_or(0),
                    monitor["x"].as_i64().unwrap_or(0),
                    monitor["y"].as_i64().unwrap_or(0)
                );
                self.run(
                    "maim",
                    &["-g".into(), geometry, path_text(&destination)?],
                    8,
                )?;
            }
        }
        let file = fs::File::open(destination)
            .map_err(|e| format!("Capture produced no screenshot: {e}"))?;
        let mut bytes = Vec::new();
        file.take(IMAGE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read capture: {e}"))?;
        if bytes.len() as u64 > IMAGE_LIMIT || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Capture did not produce a bounded PNG screenshot".into());
        }
        Ok(bytes)
    }
}

/// Stop the helper's process group on a deadline, then reap the immediate child.
/// This prevents a compiler or capture descendant retaining our pipes forever.
fn stop_process(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // SAFETY: each command starts in its own process group. No pointers are
        // involved and the negative PID addresses only that command's group.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(String::from)
        .ok_or_else(|| "Capture helper path is not UTF-8".into())
}

/// Parse signed X11 monitor offsets as well as primary and rotated displays.
fn parse_xrandr(text: &str) -> Vec<Value> {
    let geometry = regex::Regex::new(r"(\d+)x(\d+)([+-]\d+)([+-]\d+)").unwrap();
    text.lines()
        .filter(|line| line.contains(" connected"))
        .filter_map(|line| {
            let name = line.split_whitespace().next()?;
            let captures = geometry.captures(line)?;
            Some(json!({"name":name,"kind":"monitor","label":name,
            "width":captures[1].parse::<u64>().ok()?, "height":captures[2].parse::<u64>().ok()?,
            "x":captures[3].parse::<i64>().ok()?, "y":captures[4].parse::<i64>().ok()?}))
        })
        .collect()
}

/// Keep token compatibility with existing saved recordings and exclude malformed
/// identifiers before they can become screenshot command arguments.
fn window_snapshot(windows: &[Value], instance: &str) -> HashMap<String, Value> {
    windows.iter().filter_map(|entry| {
        let identifier = entry["identifier"].as_str()?;
        if identifier.is_empty() || identifier.len() > 32 || !identifier.bytes().all(|byte| (32..=126).contains(&byte)) { return None; }
        let app_id = entry.get("app_id").and_then(Value::as_str).unwrap_or("");
        if entry.get("app_id").is_some_and(|value| !value.is_string()) { return None; }
        let title = entry["title"].as_str().unwrap_or("");
        let token = format!("window:{:x}", Sha256::digest(format!("{instance}\0{identifier}\0{app_id}").as_bytes()));
        let label = if !title.is_empty() { title } else if !app_id.is_empty() { app_id } else { "Window" };
        Some((token.clone(), json!({"name":token,"kind":"window","label":label.chars().take(512).collect::<String>(),
            "title":title.chars().take(512).collect::<String>(),"app_id":app_id.chars().take(256).collect::<String>(),
            "width":0,"height":0,"identifier":identifier})))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_inventory_respects_signed_selected_monitor_geometry() {
        let monitors = parse_xrandr("DP-1 connected primary 1920x1080-1920+0 (normal)\nHDMI-1 disconnected\nDP-2 connected 2560x1440+0-1440 (normal)");
        assert_eq!(monitors.len(), 2);
        assert_eq!(monitors[0]["x"], -1920);
        assert_eq!(monitors[1]["y"], -1440);
    }

    #[test]
    fn tokens_bind_to_session_app_and_identifier() {
        let entries = vec![json!({"identifier":"abcd", "app_id":"browser", "title":"Poker"})];
        let before = window_snapshot(&entries, "hypr:1:2");
        let token = before.keys().next().unwrap();
        assert_eq!(
            token,
            "window:b068973c83bcd22b3935d1f546d92ef801a02942622224b8f33378e197c3974b"
        );
        assert!(!window_snapshot(&entries, "hypr:1:3").contains_key(token));
        assert!(
            !window_snapshot(&[json!({"identifier":"abcd","app_id":"other"})], "hypr:1:2")
                .contains_key(token)
        );
        assert_eq!(before[token]["label"], "Poker");
    }

    #[test]
    fn invalid_protocol_identifiers_are_rejected() {
        let entries = vec![
            json!({"identifier":""}),
            json!({"identifier":"a\nb"}),
            json!({"identifier":"é"}),
            json!({"identifier":"a".repeat(33)}),
            json!({"identifier":"good", "app_id":null}),
        ];
        assert!(window_snapshot(&entries, "session").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn capture_uses_only_the_requested_monitor_and_preserves_png() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Temporary::new(&std::env::temp_dir()).unwrap();
        let hyprctl = directory.0.join("hyprctl");
        fs::write(
            &hyprctl,
            "#!/bin/sh\nprintf '%s' '[{\"name\":\"DP-1\",\"width\":1920,\"height\":1080}]'\n",
        )
        .unwrap();
        fs::set_permissions(&hyprctl, fs::Permissions::from_mode(0o700)).unwrap();
        let grim = directory.0.join("grim");
        fs::write(&grim, "#!/bin/sh\n[ \"$1\" = '-o' ] && [ \"$2\" = 'DP-1' ] || exit 9\nprintf '\\211PNG\\r\\n\\032\\nfixture' > \"$3\"\n").unwrap();
        fs::set_permissions(&grim, fs::Permissions::from_mode(0o700)).unwrap();
        let environment = HashMap::from([
            ("PATH".into(), directory.0.to_str().unwrap().into()),
            ("WAYLAND_DISPLAY".into(), "fake-wayland".into()),
        ]);
        let capture = Capture::new(directory.0.clone(), environment);
        assert_eq!(
            capture.capture("DP-1").unwrap(),
            b"\x89PNG\r\n\x1a\nfixture"
        );
        assert!(capture
            .capture("missing-monitor")
            .unwrap_err()
            .contains("available capture source"));
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_helpers_are_killed_and_reaped() {
        let capture = Capture::new(PathBuf::new(), std::env::vars().collect());
        let started = Instant::now();
        let error = capture
            .run("/bin/sh", &["-c".into(), "exec /bin/sleep 10".into()], 0)
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn temporary_capture_files_are_removed_on_error() {
        let directory = Temporary::new(&std::env::temp_dir()).unwrap();
        let path = directory.0.clone();
        fs::write(path.join("capture.png"), b"rejected").unwrap();
        drop(directory);
        assert!(!path.exists());
    }
}
