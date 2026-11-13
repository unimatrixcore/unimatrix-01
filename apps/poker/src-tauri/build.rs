fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "lab_request",
            "lab_list_page",
            "launcher_request",
            "get_system_memory_info",
        ]),
    ))
    .expect("failed to build Tauri application")
}
