use poker_native::lab::{
    datasets::DatasetRegistry,
    migration::{migrate, MigrationPaths},
};
use rusqlite::{params, Connection};
use serde_json::json;
use std::{fs, path::Path};
use tempfile::TempDir;
fn fixture(root: &Path) {
    let directory = root.join("collector_datasets/legacy");
    fs::create_dir_all(directory.join("images")).unwrap();
    fs::create_dir(directory.join("full_captures")).unwrap();
    fs::write(directory.join("images/a.png"), b"original crop bytes").unwrap();
    fs::write(root.join("collector_datasets/datasets.json"),json!([{"id":"legacy","name":"My corpus","archived":false,"custom":{"retained":true}},{"id":"a".repeat(32),"name":"Empty lazy dataset","archived":true}]).to_string()).unwrap();
    let conn = Connection::open(directory.join("data.db")).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT,label TEXT,region_id TEXT);CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT);CREATE TABLE session_history(id INTEGER PRIMARY KEY,data TEXT);CREATE TABLE session_progress(id INTEGER PRIMARY KEY,data TEXT);CREATE TABLE review_events(id INTEGER PRIMARY KEY,value TEXT);CREATE TRIGGER immutable_reviews BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'immutable'); END;INSERT INTO images VALUES(1,'a.png','','seats[0].name');INSERT INTO full_captures VALUES(1,'missing.png');INSERT INTO session_history VALUES(1,'{\"points\":999}');INSERT INTO session_progress VALUES(1,'{\"queue_mode\":\"paged\",\"review_batch\":{\"batch_id\":\"retained\"},\"custom\":true}');INSERT INTO review_events VALUES(1,'preserved');").unwrap();
    drop(conn);
    fs::create_dir_all(root.join("gameplay_recordings")).unwrap();
    let db = Connection::open(root.join("gameplay_recordings/recordings.sqlite3")).unwrap();
    db.execute("CREATE TABLE evidence(id TEXT, original BLOB)", [])
        .unwrap();
    db.execute(
        "INSERT INTO evidence VALUES(?,?)",
        params!["frame", b"pixel evidence".to_vec()],
    )
    .unwrap();
    drop(db);
    fs::create_dir_all(root.join("screenshots")).unwrap();
    fs::write(root.join("screenshots/clip.mp4"), b"video bytes").unwrap();
    fs::create_dir_all(root.join("ocr-training")).unwrap();
    fs::write(
        root.join("ocr-training/do-not-copy"),
        b"retained live models",
    )
    .unwrap();
}
#[test]
fn complete_snapshot_preserves_registry_unknown_schema_progress_gameplay_and_originals() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    fixture(&source);
    let config = temp.path().join("source-config");
    fs::create_dir(&config).unwrap();
    fs::write(
        config.join("region-definer.json"),
        b"{\"round_id\":{\"x\":-5,\"y\":2,\"w\":3,\"h\":4}}",
    )
    .unwrap();
    let original = fs::read(source.join("collector_datasets/legacy/data.db")).unwrap();
    let destination = temp.path().join("owned");
    let config_dest = temp.path().join("owned-config");
    let paths = MigrationPaths {
        source_data: source.clone(),
        source_config: config.clone(),
        destination_data: destination.clone(),
        destination_config: config_dest.clone(),
    };
    let report = migrate(&paths).unwrap();
    assert_eq!(
        original,
        fs::read(source.join("collector_datasets/legacy/data.db")).unwrap()
    );
    assert_eq!(report["datasets"][0]["images"], 1);
    assert_eq!(report["datasets"][0]["missingCaptureCount"], 1);
    assert_eq!(
        fs::read(destination.join("screenshots/clip.mp4")).unwrap(),
        b"video bytes"
    );
    assert_eq!(
        fs::read(config_dest.join("region-definer.json")).unwrap(),
        fs::read(config.join("region-definer.json")).unwrap()
    );
    assert!(!destination.join("ocr-training").exists());
    assert!(destination
        .join("migration-snapshots/collector_datasets/legacy/data.db")
        .is_file());
    let conn = Connection::open(destination.join("collector_datasets/legacy/data.db")).unwrap();
    assert_eq!(
        conn.query_row("SELECT data FROM session_progress", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "{\"queue_mode\":\"paged\",\"review_batch\":{\"batch_id\":\"retained\"},\"custom\":true}"
    );
    assert!(conn.execute("DELETE FROM review_events", []).is_err());
    drop(conn);
    let game =
        Connection::open(destination.join("gameplay_recordings/recordings.sqlite3")).unwrap();
    assert_eq!(
        game.query_row("SELECT original FROM evidence", [], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        b"pixel evidence"
    );
    drop(game);
    let registry = DatasetRegistry::new(destination.join("collector_datasets")).unwrap();
    assert_eq!(
        registry.list().unwrap()[0]["custom"],
        json!({"retained":true})
    );
    registry
        .update("legacy", &json!({"name":"Renamed"}))
        .unwrap();
    assert_eq!(
        registry.list().unwrap()[0]["custom"],
        json!({"retained":true})
    );
    assert_eq!(registry.resolve(&"a".repeat(32)).err().unwrap().status, 409);
    assert!(migrate(&paths).is_err());
}
#[test]
fn nested_config_and_symlink_failure_never_publish_partial_store() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    fixture(&source);
    let config = temp.path().join("config");
    fs::create_dir(&config).unwrap();
    fs::write(config.join("regions.json"), b"{}").unwrap();
    let destination = temp.path().join("nested");
    let paths = MigrationPaths {
        source_data: source.clone(),
        source_config: config.clone(),
        destination_data: destination.clone(),
        destination_config: destination.join("config"),
    };
    migrate(&paths).unwrap();
    assert!(destination.join("config/regions.json").is_file());
    #[cfg(unix)]
    {
        let bad = temp.path().join("bad");
        std::os::unix::fs::symlink(
            source.join("screenshots/clip.mp4"),
            source.join("screenshots/unsafe.mp4"),
        )
        .unwrap();
        let paths = MigrationPaths {
            source_data: source,
            source_config: config,
            destination_data: bad.clone(),
            destination_config: temp.path().join("bad-config"),
        };
        assert!(migrate(&paths).is_err());
        assert!(!bad.exists());
        assert!(!paths.destination_config.exists());
    }
}

#[test]
fn existing_source_registry_opens_without_marker_or_progress_normalization() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("poker");
    fixture(&data);
    let directory = data.join("collector_datasets/legacy");
    let conn = Connection::open(directory.join("data.db")).unwrap();
    conn.execute_batch("ALTER TABLE images ADD COLUMN phash TEXT;ALTER TABLE images ADD COLUMN source_id INTEGER;ALTER TABLE images ADD COLUMN timestamp INTEGER;CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);ALTER TABLE full_captures ADD COLUMN monitor TEXT;ALTER TABLE full_captures ADD COLUMN timestamp INTEGER;ALTER TABLE full_captures ADD COLUMN regions_hash TEXT;ALTER TABLE session_history ADD COLUMN timestamp INTEGER;").unwrap();
    let original: String = conn
        .query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM review_events", [], |r| r.get(0))
        .unwrap();
    drop(conn);
    let registry = DatasetRegistry::new(data.join("collector_datasets")).unwrap();
    assert!(!data.join("collector_datasets/.poker-lab-managed").exists());
    let ctx = registry.resolve("legacy").unwrap();
    let db = ctx.connection().unwrap();
    assert_eq!(
        db.query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        original
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM review_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        events
    );
    assert!(db.execute("DELETE FROM review_events", []).is_err());
    assert!(!directory.join("legacy-snapshot.db").exists());
    assert!(!data.join("collector_datasets/.poker-lab-managed").exists());
}
