#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use poker_native::lab::{LabRequest, LabResponse, LabService};
use std::{path::PathBuf, sync::Arc};
use tauri::{http, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(unix)]
static EXIT_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn request_exit(_: libc::c_int) {
    EXIT_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn local_navigation(url: &tauri::Url) -> bool {
    (url.scheme() == "pokerlab" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("pokerlab.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(5180))
}

#[tauri::command]
async fn lab_request(
    request: LabRequest,
    state: State<'_, Arc<LabService>>,
    window: WebviewWindow,
) -> Result<LabResponse, String> {
    let url = window.url().map_err(|error| error.to_string())?;
    if window.label() != "main" || !local_navigation(&url) {
        return Err("Native commands are available only to the local app window".into());
    }
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.request(request))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn launcher_request(
    operation: String,
    selection: Option<String>,
    window: WebviewWindow,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|error| error.to_string())?;
    if window.label() != "main" || !local_navigation(&url) {
        return Err("Launcher commands are available only to the local app window".into());
    }
    let args = match (operation.as_str(), selection) {
        ("status", None) => vec!["--status".to_owned()],
        ("select", Some(value))
            if value.len() <= 4096
                && (value == "latest" || PathBuf::from(&value).is_absolute()) =>
        {
            vec!["--select".to_owned(), value]
        }
        _ => return Err("Invalid launcher request".into()),
    };
    let required_path = |name: &str| -> Result<PathBuf, String> {
        let path = std::env::var_os(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("{name} is unavailable"))?;
        if !path.is_absolute() {
            return Err(format!("{name} must be absolute"));
        }
        Ok(path)
    };
    let node = required_path("POKER_LAB_LAUNCHER_NODE")?;
    let script = required_path("POKER_LAB_LAUNCHER_PATH")?;
    let git_dir = required_path("POKER_LAB_GIT_DIR")?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new(node)
            .arg(script)
            .arg("--git-dir")
            .arg(git_dir)
            .args(args)
            .output()
            .map_err(|error| format!("Cannot run Poker Lab launcher: {error}"))?;
        if !output.status.success() {
            return Err("Poker Lab launcher request failed".into());
        }
        if output.stdout.len() > 1_048_576 {
            return Err("Poker Lab launcher response is too large".into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Invalid Poker Lab launcher response: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn media_request(request: &http::Request<Vec<u8>>) -> LabRequest {
    let uri = request.uri();
    let query = tauri::Url::parse(&format!(
        "http://localhost{}",
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
    ))
    .map(|url| url.query_pairs().into_owned().collect())
    .unwrap_or_default();
    let headers = request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_owned()))
        })
        .collect();
    LabRequest {
        method: request.method().to_string(),
        path: uri.path().to_owned(),
        query,
        headers,
        body: serde_json::Value::Null,
    }
}

fn media_response(response: LabResponse) -> Result<http::Response<Vec<u8>>, String> {
    let body = if matches!(response.status, 204 | 205 | 304) {
        Vec::new()
    } else {
        match response.body_base64 {
            Some(body) => STANDARD.decode(body).map_err(|error| error.to_string())?,
            None => serde_json::to_vec(&response.body).map_err(|error| error.to_string())?,
        }
    };
    let mut builder = http::Response::builder().status(response.status);
    for (name, value) in response.headers {
        builder = builder.header(name, value);
    }
    builder.body(body).map_err(|error| error.to_string())
}

fn failure(status: u16, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

fn main() {
    #[cfg(unix)]
    for signal in [libc::SIGINT, libc::SIGTERM] {
        // The handler only stores an atomic flag; all Tauri work stays outside the signal handler.
        if unsafe { libc::signal(signal, request_exit as *const () as libc::sighandler_t) }
            == libc::SIG_ERR
        {
            panic!(
                "Cannot install shutdown signal handler: {}",
                std::io::Error::last_os_error()
            );
        }
    }
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("pokerlab", |context, request, responder| {
            let handle = context.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let path = request.uri().path();
                let response = if path.starts_with("/api/") {
                    let service = handle.state::<Arc<LabService>>();
                    media_response(service.request(media_request(&request)))
                        .unwrap_or_else(|error| failure(500, &error))
                } else {
                    let asset_path = if path == "/"
                        || ["/collection", "/gameplay", "/review", "/statistics"].contains(&path)
                    {
                        "/index.html"
                    } else {
                        path
                    };
                    match handle.asset_resolver().get(asset_path.to_owned()) {
                        Some(asset) => {
                            let mut builder = http::Response::builder()
                                .status(200)
                                .header("Content-Type", asset.mime_type);
                            if let Some(csp) = asset.csp_header {
                                builder = builder.header("Content-Security-Policy", csp);
                            }
                            builder
                                .body(asset.bytes)
                                .unwrap_or_else(|_| failure(500, "Invalid asset response"))
                        }
                        None => failure(404, "Asset not found"),
                    }
                };
                responder.respond(response);
            });
        })
        .setup(|app| {
            let data = std::env::var_os("POKER_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(poker_native::storage_paths::data_dir);
            let config = std::env::var_os("POKER_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(poker_native::storage_paths::config_dir);
            let tools = std::env::var_os("POKER_LAB_TOOLS_ROOT")
                .map(PathBuf::from)
                .unwrap_or(app.path().resource_dir()?.join("tools/poker"));
            let profile = data.join("webview/poker-lab");
            poker_native::storage_paths::ensure_directory(&profile)?;
            let service =
                LabService::open_with_paths(data, config, tools, std::env::vars().collect())
                    .map_err(|error| std::io::Error::other(error.message))?;
            app.manage(Arc::new(service));
            let page = if std::env::args().any(|arg| arg == "--regions") {
                "regions.html"
            } else {
                "collection"
            };
            let url = if cfg!(debug_assertions) && std::env::var_os("POKER_LAB_BUNDLED").is_none() {
                format!("http://localhost:5180/{page}")
            } else {
                format!("pokerlab://localhost/{page}")
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url.parse()?))
                .data_directory(profile)
                .title("Poker Lab")
                .inner_size(1440.0, 960.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .decorations(false)
                .on_navigation(local_navigation)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![lab_request, launcher_request])
        .build(tauri::generate_context!())
        .expect("Failed to build Poker Lab");
    #[cfg(unix)]
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || loop {
            if EXIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                handle.exit(0);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
    }
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let service = handle.state::<Arc<LabService>>();
            service.gameplay.shutdown();
            service.model.shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_origins_are_trusted() {
        assert!(local_navigation(
            &"pokerlab://localhost/collection".parse().unwrap()
        ));
        assert!(!local_navigation(
            &"pokerlab://evil.test/collection".parse().unwrap()
        ));
        assert!(!local_navigation(&"https://evil.test/".parse().unwrap()));
    }

    #[test]
    fn media_forwards_query_and_range_and_decodes_response() {
        let request = http::Request::builder()
            .uri("pokerlab://localhost/api/video?dataset_id=example%20one")
            .header("Range", "bytes=2-4")
            .body(Vec::new())
            .unwrap();
        let request = media_request(&request);
        assert_eq!(request.path, "/api/video");
        assert_eq!(request.query.get("dataset_id").unwrap(), "example one");
        assert_eq!(request.header("range"), Some("bytes=2-4"));
        let mut response = LabResponse::binary(b"abc", "video/mp4");
        response.status = 206;
        response
            .headers
            .insert("Content-Range".into(), "bytes 2-4/10".into());
        let response = media_response(response).unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-4/10");
        assert_eq!(response.body(), b"abc");
    }
}
