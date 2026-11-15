use crate::lab::{sha256, LabResult};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const CURRENT: &[u8] = include_bytes!("../../../assets/gameplay-regions.json");
pub fn bootstrap(config: &Path) -> LabResult<()> {
    crate::storage_paths::ensure_directory(config)?;
    crate::storage_paths::seed_file(&config.join("gameplay-regions.json"), CURRENT)
        .map_err(crate::lab::bad)?;
    let active = config.join("gameplay-regions.json");
    let bytes = fs::read(&active)?;
    let previous: Value = serde_json::from_slice(&bytes)?;
    let bundled: Value = serde_json::from_slice(CURRENT)?;
    if previous["source"] == bundled["source"] && previous["id"] != bundled["id"] {
        let archive = config.join("region-archive");
        crate::storage_paths::ensure_directory(&archive)?;
        crate::storage_paths::seed_file(
            &archive.join(format!("gameplay-{}.json", sha256(&bytes))),
            &bytes,
        )
        .map_err(crate::lab::bad)?;
        let temporary = config.join(format!(".gameplay-profile-{}.tmp", crate::lab::uuid()));
        fs::write(&temporary, CURRENT)?;
        fs::rename(temporary, &active)?;
    }
    let old = config.join("regions.json");
    if old.is_file() {
        let bytes = fs::read(&old)?;
        let hash = sha256(&bytes);
        let archive = config.join("region-archive");
        crate::storage_paths::ensure_directory(&archive)?;
        crate::storage_paths::seed_file(&archive.join(format!("legacy-{hash}.json")), &bytes)
            .map_err(crate::lab::bad)?;
        let manifest = json!({"active":"gameplay-regions.json","archived_source":"regions.json","archived_sha256":hash,"preserved_recording_snapshots":true});
        crate::storage_paths::seed_file(
            &archive.join(format!("legacy-{hash}.manifest.json")),
            manifest.to_string().as_bytes(),
        )
        .map_err(crate::lab::bad)?;
        fs::remove_file(old)?;
    }
    Ok(())
}
