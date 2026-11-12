#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
use commands::commands as original_commands;
use tauri::Manager;

#[cfg(target_os = "linux")]
#[link(name = "X11")]
unsafe extern "C" {
    fn XInitThreads() -> i32;
}

fn main() {
    #[cfg(target_os = "linux")]
    unsafe {
        XInitThreads();
    }
    tauri::Builder::default()
        .setup(|app| {
            let resource = app
                .path()
                .resource_dir()?
                .join("tools/poker/dev_tools/training/ocr_service.py");
            if resource.is_file() {
                poker_native::assistant::ocr_bridge::configure_service(resource)
                    .map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            original_commands::load_preferences,
            original_commands::save_preferences,
            original_commands::get_monitors,
            original_commands::capture_monitor,
            original_commands::save_debug_screenshot,
            original_commands::detect_table_roi,
            original_commands::extract_regions,
            original_commands::verify_game_fullscreen,
            original_commands::get_game_state,
            original_commands::get_colors,
            original_commands::capture_production_frame,
            original_commands::get_production_state,
            original_commands::stop_production_ocr,
            original_commands::debug_env
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run Poker Assistant");
}
