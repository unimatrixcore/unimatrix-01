use super::datasets::{self, DatasetRow};
use super::{bad, conflict, now_ms, uuid, LabResult};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct MigrationPaths {
    pub source_data: PathBuf,
    pub source_config: PathBuf,
    pub destination_data: PathBuf,
    pub destination_config: PathBuf,
}
fn absolute(path: &Path) -> LabResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(bad(
            "Migration paths must be absolute without parent traversal",
        ));
    }
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            datasets::plain(ancestor)?;
        }
    }
    Ok(())
}
fn private_dir(path: &Path) -> LabResult<()> {
    let existed = path.exists();
    if existed {
        datasets::plain(path)?;
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !existed {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}
fn snapshot_database(source: &Path, destination: &Path) -> LabResult<()> {
    let original = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut copy = Connection::open(destination)?;
    let backup = Backup::new(&original, &mut copy)?;
    backup.run_to_completion(256, Duration::from_millis(2), None)?;
    drop(backup);
    let check: String = copy.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(conflict(format!(
            "SQLite snapshot failed integrity check: {}",
            source.display()
        )));
    }
    Ok(())
}
fn tree(
    source: &Path,
    destination: &Path,
    snapshots: &Path,
    relative: &Path,
    databases: &mut Vec<String>,
) -> LabResult<()> {
    datasets::plain(source)?;
    let meta = fs::symlink_metadata(source)?;
    if meta.is_dir() {
        private_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| bad("Non-UTF8 migration filename"))?;
            if name.ends_with("-wal") || name.ends_with("-shm") {
                let original = source.join(
                    name.strip_suffix("-wal")
                        .or_else(|| name.strip_suffix("-shm"))
                        .unwrap_or(name),
                );
                if original.is_file() {
                    continue;
                }
            }
            tree(
                &entry.path(),
                &destination.join(name),
                snapshots,
                &relative.join(name),
                databases,
            )?;
        }
    } else if meta.is_file() {
        if source
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| matches!(ext, "db" | "sqlite" | "sqlite3"))
        {
            snapshot_database(source, destination)?;
            let backup = snapshots.join(relative);
            private_dir(
                backup
                    .parent()
                    .ok_or_else(|| bad("Invalid snapshot path"))?,
            )?;
            fs::copy(destination, &backup)?;
            databases.push(relative.to_string_lossy().into_owned());
        } else {
            fs::copy(source, destination)?;
        }
    } else {
        return Err(bad(format!(
            "Unsupported migration file type: {}",
            source.display()
        )));
    }
    Ok(())
}
fn missing(directory: &Path, table: &str, folder: &str) -> LabResult<Vec<String>> {
    let database = directory.join("data.db");
    if !database.exists() {
        return Ok(vec![]);
    }
    let conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let names: Vec<String> = conn
        .prepare(&format!("SELECT filename FROM {table}"))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut missing = Vec::new();
    for name in names {
        datasets::safe_filename(&name)?;
        let path = directory.join(folder).join(&name);
        if path.exists() {
            datasets::plain(&path)?;
            if !path.is_file() {
                return Err(bad("Referenced dataset path is not a file"));
            }
        } else {
            missing.push(name);
        }
    }
    Ok(missing)
}
fn dataset_report(root: &Path) -> LabResult<Vec<Value>> {
    let manifest = root.join("datasets.json");
    let rows: Vec<DatasetRow> = if manifest.exists() {
        serde_json::from_slice(&fs::read(manifest)?)?
    } else {
        vec![]
    };
    let mut reports = Vec::new();
    for row in rows {
        if row.id != "legacy"
            && (row.id.len() != 32
                || !row
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        {
            return Err(bad("Unknown dataset identity in imported registry"));
        }
        let directory = root.join(&row.id);
        let database = directory.join("data.db");
        let (mut images, mut captures, mut history) = (0i64, 0i64, 0i64);
        if database.exists() {
            let conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            images = conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
            captures = conn.query_row("SELECT COUNT(*) FROM full_captures", [], |r| r.get(0))?;
            history = conn.query_row("SELECT COUNT(*) FROM session_history", [], |r| r.get(0))?;
        }
        let missing_images = missing(&directory, "images", "images")?;
        let missing_captures = missing(&directory, "full_captures", "full_captures")?;
        reports.push(json!({"id":row.id,"name":row.name,"archived":row.archived,"images":images,"captures":captures,"history":history,"missingImages":missing_images,"missingCaptures":missing_captures,"missingImageCount":missing_images.len(),"missingCaptureCount":missing_captures.len()}));
    }
    Ok(reports)
}
pub fn migrate(paths: &MigrationPaths) -> LabResult<Value> {
    for path in [
        &paths.source_data,
        &paths.source_config,
        &paths.destination_data,
        &paths.destination_config,
    ] {
        absolute(path)?;
    }
    if !paths.source_data.is_dir() {
        return Err(bad("Source Poker data directory does not exist"));
    }
    for destination in [&paths.destination_data, &paths.destination_config] {
        if destination.exists() {
            return Err(conflict(format!("Migration destination already exists; existing stores are never merged or overwritten: {}",destination.display())));
        }
    }
    let selected = [
        ("collector_datasets", "collector_datasets"),
        ("gameplay_recordings", "gameplay_recordings"),
        ("screenshots", "screenshots"),
        ("webview", "webview"),
    ];
    for (source, _) in selected {
        let source = paths.source_data.join(source);
        if paths.destination_data.starts_with(&source)
            || paths.destination_config.starts_with(&source)
        {
            return Err(bad(
                "Migration destination must be outside every source store",
            ));
        }
    }
    if paths.source_config.exists()
        && (paths.destination_data.starts_with(&paths.source_config)
            || paths.destination_config.starts_with(&paths.source_config))
    {
        return Err(bad(
            "Migration destination must be outside source configuration",
        ));
    }
    if paths.destination_config == paths.destination_data {
        return Err(bad("Data and config destinations must be distinct"));
    }
    let config_inside = paths
        .destination_config
        .strip_prefix(&paths.destination_data)
        .ok()
        .filter(|p| !p.as_os_str().is_empty());
    private_dir(
        paths
            .destination_data
            .parent()
            .ok_or_else(|| bad("Invalid destination data path"))?,
    )?;
    if config_inside.is_none() {
        private_dir(
            paths
                .destination_config
                .parent()
                .ok_or_else(|| bad("Invalid destination config path"))?,
        )?;
    }
    let id = uuid();
    let stage = paths
        .destination_data
        .with_extension(format!("migrate-{id}"));
    let config_stage = config_inside.map(|p| stage.join(p)).unwrap_or_else(|| {
        paths
            .destination_config
            .with_extension(format!("migrate-{id}"))
    });
    private_dir(&stage)?;
    let mut published_config = false;
    let result = (|| -> LabResult<Value> {
        let snapshots = stage.join("migration-snapshots");
        let mut databases = Vec::new();
        let mut copied = Vec::new();
        for (source, target) in selected {
            let source = paths.source_data.join(source);
            if source.exists() {
                tree(
                    &source,
                    &stage.join(target),
                    &snapshots,
                    Path::new(target),
                    &mut databases,
                )?;
                copied.push(target);
            }
        }
        let registry = stage.join("collector_datasets");
        private_dir(&registry)?;
        fs::write(
            registry.join(".poker-lab-managed"),
            b"unimatrix-poker-lab-v1\n",
        )?;
        if !registry.join("datasets.json").exists() {
            datasets::atomic_json(
                &registry.join("datasets.json"),
                &json!([{"id":"legacy","name":"Legacy corpus","archived":false}]),
            )?;
        }
        if paths.source_config.exists() {
            tree(
                &paths.source_config,
                &config_stage,
                &snapshots,
                Path::new("configuration"),
                &mut databases,
            )?;
        } else {
            private_dir(&config_stage)?;
        }
        let datasets = dataset_report(&registry)?;
        let report = json!({"id":id,"migratedAt":now_ms(),"sourceData":paths.source_data,"sourceConfig":paths.source_config,"destinationData":paths.destination_data,"destinationConfig":paths.destination_config,"copiedStores":copied,"databaseSnapshots":databases,"datasets":datasets,"retainedModelRuntime":paths.source_data.join("ocr-training"),"originalsUntouched":true});
        datasets::atomic_json(&stage.join("migration-report.json"), &report)?;
        for destination in [&paths.destination_data, &paths.destination_config] {
            if destination.exists() {
                return Err(conflict(
                    "Migration destination appeared while staging; nothing will be overwritten",
                ));
            }
        }
        if config_inside.is_none() {
            fs::rename(&config_stage, &paths.destination_config)?;
            published_config = true;
        }
        if let Err(error) = fs::rename(&stage, &paths.destination_data) {
            if published_config {
                let _ = fs::rename(&paths.destination_config, &config_stage);
                published_config = false;
            }
            return Err(error.into());
        }
        Ok(report)
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    if config_stage.exists() {
        let _ = fs::remove_dir_all(config_stage);
    }
    if result.is_err() && published_config {
        let _ = fs::remove_dir_all(&paths.destination_config);
    }
    result
}
