pub mod commands {
    /// Load the frontend preferences from user configuration, preserving a missing-file signal for migration.
    #[tauri::command]
    pub fn load_preferences() -> Result<Option<String>, String> {
        match std::fs::read_to_string(
            poker_native::assistant::storage_paths::config_dir().join("preferences.json"),
        ) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Validate JSON and atomically replace preferences so an interrupted write cannot truncate them.
    #[tauri::command]
    pub fn save_preferences(value: String) -> Result<(), String> {
        serde_json::from_str::<serde_json::Value>(&value).map_err(|e| e.to_string())?;
        let directory = poker_native::assistant::storage_paths::config_dir();
        poker_native::assistant::storage_paths::ensure_directory(&directory)
            .map_err(|e| e.to_string())?;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let temporary = directory.join(format!(
            "preferences.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        // Create a private staging file, then publish the complete JSON with rename.
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
            file.write_all(value.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, directory.join("preferences.json"))
                .map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_file(&temporary);
        result
    }

    use serde::{Deserialize, Serialize};
    use xcap::Monitor;

    // Struct to send monitor info to the frontend
    #[derive(Serialize, Deserialize)]
    pub struct MonitorInfo {
        pub id: u32,
        pub name: String,
        pub width: u32,
        pub height: u32,
        pub is_primary: bool,
    }

    // Returns list of all monitors with names, sizes, and primary flag.
    // xcap::Monitor::all() is safe — it only enumerates, does not capture pixels.
    #[tauri::command]
    pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
        let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

        let mut monitor_list = Vec::new();
        for (index, monitor) in monitors.iter().enumerate() {
            monitor_list.push(MonitorInfo {
                id: monitor.id().unwrap_or(index as u32),
                name: monitor
                    .name()
                    .unwrap_or_else(|_| format!("Monitor {}", index))
                    .to_string(),
                width: monitor.width().unwrap_or(0),
                height: monitor.height().unwrap_or(0),
                is_primary: monitor.is_primary().unwrap_or(false),
            });
        }

        Ok(monitor_list)
    }

    // Returns key env vars so we can debug capture failures from the UI.
    #[tauri::command]
    pub fn debug_env() -> String {
        let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "<NOT SET>".into());
        let xdg = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "<NOT SET>".into());
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| "<NOT SET>".into());

        // Check whether the Wayland socket actually exists on disk.
        let socket_path = format!("{}/{}", xdg, wayland);
        let socket_exists = std::path::Path::new(&socket_path).exists();

        format!(
            "WAYLAND_DISPLAY={wayland}\nXDG_RUNTIME_DIR={xdg}\nDISPLAY={display}\nSocket {socket_path} exists={socket_exists}"
        )
    }

    // Build a grim Command pre-loaded with the Wayland env vars we need.
    // tauri dev can drop these from the subprocess environment; we re-inject
    // them from std::env (which got them from the user's shell at launch time).
    fn grim_cmd(monitor_name: &str) -> std::process::Command {
        let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-1".into());
        let xdg = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/run/user/1000".into());

        // Print to the terminal so the developer can see what we're using.
        eprintln!(
            "[poker] grim: WAYLAND_DISPLAY={wayland} XDG_RUNTIME_DIR={xdg} output={monitor_name}"
        );

        let mut cmd = std::process::Command::new("grim");
        cmd.env("WAYLAND_DISPLAY", &wayland)
            .env("XDG_RUNTIME_DIR", &xdg)
            .arg("-o")
            .arg(monitor_name)
            // PNG stays lossless at level 1 while spending less CPU time on
            // compression. Omit -c: the collector excludes the mouse cursor,
            // which otherwise can obscure ranks or amount digits.
            .arg("-t")
            .arg("png")
            .arg("-l")
            .arg("1")
            .arg("-"); // write to stdout
        cmd
    }

    // Capture a monitor by index. Returns raw PNG bytes.
    // Uses grim (Wayland wlr-screencopy) instead of xcap because xcap's
    // X11 SHM path hangs under XWayland even with XInitThreads().
    #[tauri::command]
    pub async fn capture_monitor(monitor_index: usize) -> Result<Vec<u8>, String> {
        // Resolve the name first (xcap list is fast, no pixel grab).
        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        let monitor = monitors
            .get(monitor_index)
            .ok_or_else(|| format!("No monitor at index {}", monitor_index))?;
        let name = monitor
            .name()
            .unwrap_or_else(|_| format!("Monitor {}", monitor_index))
            .to_string();

        tauri::async_runtime::spawn_blocking(move || {
            let output = grim_cmd(&name)
                .output()
                .map_err(|e| format!("Failed to spawn grim (is it installed?): {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                return Err(format!("grim failed: {}", stderr));
            }
            if output.stdout.is_empty() {
                return Err("grim produced no output".into());
            }

            Ok(output.stdout)
        })
        .await
        .map_err(|e| format!("Thread panicked: {}", e))?
    }

    // Save a debug screenshot to disk.
    #[tauri::command]
    pub async fn save_debug_screenshot(
        monitor_index: usize,
        file_path: Option<String>,
    ) -> Result<String, String> {
        // Explicit export paths remain supported; ordinary debug captures are durable data.
        let file_path = file_path.map(std::path::PathBuf::from).unwrap_or_else(|| {
            poker_native::assistant::storage_paths::data_dir()
                .join("captures/debug_poker_monitor.png")
        });
        if let Some(parent) = file_path.parent() {
            poker_native::assistant::storage_paths::ensure_directory(parent)
                .map_err(|e| e.to_string())?;
        }
        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        let monitor = monitors
            .get(monitor_index)
            .ok_or_else(|| format!("No monitor at index {}", monitor_index))?;
        let name = monitor
            .name()
            .unwrap_or_else(|_| format!("Monitor {}", monitor_index))
            .to_string();

        tauri::async_runtime::spawn_blocking(move || {
            // For saving to disk, grim writes directly to the path (no stdout needed).
            let wayland = std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "wayland-1".into());
            let xdg = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/run/user/1000".into());

            let output = std::process::Command::new("grim")
                .env("WAYLAND_DISPLAY", &wayland)
                .env("XDG_RUNTIME_DIR", &xdg)
                .arg("-o")
                .arg(&name)
                .arg(&file_path)
                .output()
                .map_err(|e| format!("Failed to spawn grim: {}", e))?;

            if !output.status.success() {
                return Err(format!(
                    "grim failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }

            Ok(format!("Saved to {}", file_path.display()))
        })
        .await
        .map_err(|e| format!("Thread panicked: {}", e))?
    }

    // detect_table_roi: CPU-heavy image work, offloaded to a thread.
    #[tauri::command]
    pub async fn detect_table_roi(
        screenshot_bytes: Vec<u8>,
    ) -> Result<(Vec<u8>, (u32, u32, u32, u32)), String> {
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::vision::detect_table_roi(&screenshot_bytes)
        })
        .await
        .map_err(|e| format!("Thread panicked during ROI detection: {}", e))?
    }

    #[tauri::command]
    pub async fn extract_regions(
        screenshot_bytes: Vec<u8>,
    ) -> Result<Vec<poker_native::assistant::vision::CroppedRegion>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::vision::extract_regions(&screenshot_bytes)
        })
        .await
        .map_err(|e| format!("Thread panicked during region extraction: {}", e))?
    }

    #[tauri::command]
    pub async fn verify_game_fullscreen(screenshot_bytes: Vec<u8>) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::vision::verify_fullscreen_game(&screenshot_bytes)
        })
        .await
        .map_err(|e| format!("Thread panicked during game verification: {}", e))?
    }

    #[tauri::command]
    pub async fn get_game_state(
        screenshot_bytes: Vec<u8>,
        username: String,
    ) -> Result<poker_native::assistant::vision::GameState, String> {
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::vision::process_game_state(&screenshot_bytes, &username)
        })
        .await
        .map_err(|e| format!("Thread panicked during game state processing: {}", e))?
    }

    /// Submit a native capture to the persistent GPU reader. This command does
    /// not use the old fullscreen OCR gate or wait for neural inference.
    #[tauri::command]
    pub async fn capture_production_frame(
        monitor_index: usize,
    ) -> Result<poker_native::assistant::ocr_bridge::CaptureResponse, String> {
        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {e}"))?;
        let monitor = monitors.get(monitor_index).ok_or("Invalid monitor index")?;
        let name = monitor.name().map_err(|e| e.to_string())?.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::ocr_bridge::capture(&name, grim_cmd(&name))
        })
        .await
        .map_err(|e| format!("Capture worker failed: {e}"))?
    }

    /// Poll independently so new frames can replace pending work while the
    /// recognizer runs. Unknown output contains no retained game-state fields.
    #[tauri::command]
    pub async fn get_production_state(
        username: String,
    ) -> Result<poker_native::assistant::ocr_bridge::ProductionState, String> {
        tauri::async_runtime::spawn_blocking(move || {
            poker_native::assistant::ocr_bridge::latest(&username)
        })
        .await
        .map_err(|e| format!("OCR polling worker failed: {e}"))?
    }

    /// Stop revokes all previous reads, including on monitor changes.
    #[tauri::command]
    pub async fn stop_production_ocr() -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(poker_native::assistant::ocr_bridge::stop)
            .await
            .map_err(|e| format!("OCR shutdown failed: {e}"))?
    }

    #[tauri::command]
    pub fn get_colors() -> Result<poker_native::assistant::vision::ColorConfig, String> {
        let color_str = &poker_native::assistant::storage_paths::config_string(
            "colors.json",
            include_str!("../../../../packages/poker-native/assets/colors.json"),
        )?;
        serde_json::from_str(color_str).map_err(|e| format!("Failed to parse colors.json: {}", e))
    }
}
