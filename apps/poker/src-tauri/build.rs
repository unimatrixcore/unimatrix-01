fn main() {
    println!("cargo:rerun-if-env-changed=POKER_LAB_NATIVE_SOURCE_FP");
    let fingerprint =
        std::env::var("POKER_LAB_NATIVE_SOURCE_FP").unwrap_or_else(|_| "unverified".into());
    assert!(
        fingerprint == "unverified"
            || (fingerprint.len() == 64
                && fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())),
        "Invalid Poker Lab source fingerprint"
    );
    println!("cargo:rustc-env=POKER_LAB_NATIVE_SOURCE_FP={fingerprint}");
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
