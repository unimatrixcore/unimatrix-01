use image::{DynamicImage, ImageFormat};
use poker_native::lab::{
    gameplay::store::Store,
    legacy_benchmark::{apply, plan, SourceSpec},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

fn png() -> Vec<u8> {
    let mut out = Cursor::new(vec![]);
    DynamicImage::new_rgb8(12, 8)
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn fixture(root: &Path) -> SourceSpec {
    fs::create_dir_all(root.join("images")).unwrap();
    fs::create_dir_all(root.join("full_captures")).unwrap();
    let db = Connection::open(root.join("data.db")).unwrap();
    db.execute_batch("CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT,monitor TEXT,timestamp INTEGER,regions_hash TEXT);CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT,phash TEXT,label TEXT,region_id TEXT,source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER);CREATE TABLE queue_items(queue_id INTEGER PRIMARY KEY,source TEXT,game_id TEXT,payload TEXT,crop BLOB);CREATE TABLE label_review_events(id INTEGER PRIMARY KEY,label TEXT,prior_label TEXT);").unwrap();
    for (id, name) in [(1, "first.png"), (2, "sparse.png"), (3, "missing.png")] {
        db.execute(
            "INSERT INTO full_captures VALUES(?,?,'fixture',?,'unknown')",
            params![id, name, 1700000000000i64 + id],
        )
        .unwrap();
    }
    for name in ["first.png", "sparse.png"] {
        fs::write(root.join("full_captures").join(name), png()).unwrap();
    }
    for (id, name, label, region, source) in [
        (1, "round.png", "#123456", "round_id", Some(1)),
        (2, "unattached.png", "Alice", "seats[0].name", None),
        (3, "dangling.png", "12", "seats[0].bet", Some(99)),
    ] {
        db.execute(
            "INSERT INTO images VALUES(?,?,'hash',?,?,?,1700000000000,1,2,3,4)",
            params![id, name, label, region, source],
        )
        .unwrap();
        fs::write(root.join("images").join(name), png()).unwrap();
    }
    db.execute(
        "INSERT INTO queue_items VALUES(1,'sparse.png','#123457','{}',?)",
        [png()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO queue_items VALUES(2,'queue-only.png','#123458','{}',?)",
        [png()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO label_review_events VALUES(1,'corrected','original')",
        [],
    )
    .unwrap();
    fs::write(root.join("images/orphan.png"), png()).unwrap();
    SourceSpec {
        id: "fixture".into(),
        name: "Fixture source".into(),
        directory: root.into(),
    }
}
fn database_snapshot(root: &Path) -> Vec<u8> {
    fs::read(root.join("data.db")).unwrap()
}

#[test]
fn sparse_missing_and_unattached_evidence_is_planned_without_source_writes() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let before = database_snapshot(&spec.directory);
    let first = plan(&[spec.clone()], &[]).unwrap();
    let second = plan(&[spec.clone()], &[]).unwrap();
    assert_eq!(first.batch.frames.len(), 2);
    assert_eq!(first.batch.frames[0].hand_id.as_deref(), None);
    assert_eq!(first.batch.frames[1].hand_id.as_deref(), None);
    assert_eq!(first.batch.frames[1].evidence["crops"], json!([]));
    assert_eq!(first.batch.frames[0].evidence["game_id_verified"], false);
    for reason in [
        "missing_full_frame",
        "crop_without_original_capture",
        "orphan_crop_file",
        "queue_without_original_capture",
        "retained_review_provenance",
    ] {
        assert!(
            first.batch.unresolved.iter().any(|v| v.reason == reason),
            "{reason}"
        );
    }
    assert!(first.batch.frames.iter().all(|v| v.config.is_null()));
    assert_eq!(
        serde_json::to_value(&first.batch).unwrap(),
        serde_json::to_value(&second.batch).unwrap()
    );
    assert_eq!(database_snapshot(&spec.directory), before);
    first.sources[0].assert_unchanged().unwrap();
}

#[test]
fn import_is_native_idempotent_and_preserves_existing_archived_recordings() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let before = database_snapshot(&spec.directory);
    let prepared = plan(&[spec.clone()], &[]).unwrap();
    let destination = temp.path().join("gameplay");
    let store = Store::new(destination.clone()).unwrap();
    let old = store
        .create("monitor", 1000, "Keep existing", &json!({}), "original")
        .unwrap();
    let old_id = old["id"].as_str().unwrap();
    let prior_frame = store
        .admit(
            old_id,
            &png(),
            12,
            8,
            "original-time",
            &json!({}),
            "original-config",
            &json!({}),
            "original-hand",
            &json!({}),
        )
        .unwrap();
    let prior_id = prior_frame["id"].as_str().unwrap();
    let prior_db = Connection::open(destination.join("gameplay.sqlite3")).unwrap();
    prior_db
        .execute(
            "UPDATE frames SET ocr_status='pending' WHERE id=?",
            [prior_id],
        )
        .unwrap();
    drop(prior_db);
    let original_frame = store.frame(prior_id, true).unwrap();
    let original_png =
        fs::read(destination.join("frames").join(format!("{prior_id}.png"))).unwrap();
    store.stop(old_id).unwrap();
    store.archive(old_id).unwrap();
    let archived = store.session(old_id).unwrap();
    let result = apply(&prepared, &destination).unwrap();
    assert_eq!(result["inserted"], 2);
    assert_eq!(apply(&prepared, &destination).unwrap()["reused"], 2);
    assert_eq!(store.session(old_id).unwrap(), archived);
    assert_eq!(store.frame(prior_id, true).unwrap(), original_frame);
    assert_eq!(
        fs::read(destination.join("frames").join(format!("{prior_id}.png"))).unwrap(),
        original_png
    );
    let frame = store.frame(&prepared.batch.frames[0].id, true).unwrap();
    assert_eq!(frame["hand_id"], Value::Null);
    assert_eq!(frame["ocr_status"], "error");
    assert_eq!(frame["results"], json!({}));
    assert_eq!(frame["captured_at"], prepared.batch.frames[0].captured_at);
    assert_eq!(database_snapshot(&spec.directory), before);
    let db = Connection::open(destination.join("gameplay.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM gameplay_import_origins", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn conflicts_remain_unresolved_and_changed_sources_do_not_overwrite_imports() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let db = Connection::open(spec.directory.join("data.db")).unwrap();
    db.execute(
        "INSERT INTO images VALUES(4,'conflict.png','hash','#999999','round_id',1,1700000000000,1,2,3,4)",
        [],
    )
    .unwrap();
    fs::write(spec.directory.join("images/conflict.png"), png()).unwrap();
    drop(db);
    let prepared = plan(&[spec.clone()], &[]).unwrap();
    assert!(prepared.batch.frames[0].hand_id.is_none());
    assert_eq!(prepared.batch.frames[0].evidence["game_id_conflict"], true);
    let destination = temp.path().join("gameplay");
    Store::new(destination.clone()).unwrap();
    apply(&prepared, &destination).unwrap();
    let db = Connection::open(spec.directory.join("data.db")).unwrap();
    db.execute("UPDATE images SET label='#111111' WHERE id=1", [])
        .unwrap();
    drop(db);
    assert!(apply(&prepared, &destination)
        .unwrap_err()
        .contains("changed since planning"));
    let revised = plan(&[spec], &[]).unwrap();
    assert!(apply(&revised, &destination)
        .unwrap_err()
        .contains("Source revision conflicts"));
}

#[test]
fn wal_snapshot_contains_committed_rows_without_touching_source_sidecars() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let db = Connection::open(spec.directory.join("data.db")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    db.execute(
        "INSERT INTO full_captures VALUES(4,'wal-missing.png','fixture',1700000000004,'unknown')",
        [],
    )
    .unwrap();
    let prepared = plan(&[spec], &[]).unwrap();
    assert!(prepared
        .batch
        .unresolved
        .iter()
        .any(|v| v.origin.ends_with("full_captures:4")));
    prepared.sources[0].assert_unchanged().unwrap();
    drop(db);
}

#[test]
fn interrupted_publication_resumes_but_corrupted_published_pixels_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let prepared = plan(&[spec], &[]).unwrap();
    let destination = temp.path().join("gameplay");
    Store::new(destination.clone()).unwrap();
    let frame = &prepared.batch.frames[0];
    let published = destination.join("frames").join(format!("{}.png", frame.id));
    fs::copy(&frame.source_path, &published).unwrap();
    assert_eq!(apply(&prepared, &destination).unwrap()["inserted"], 2);
    fs::write(&published, b"corrupt").unwrap();
    assert!(apply(&prepared, &destination)
        .unwrap_err()
        .contains("Published frame conflicts"));
}

#[test]
fn path_traversal_and_overlapping_destinations_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let prepared = plan(&[spec.clone()], &[]).unwrap();
    assert!(apply(&prepared, &spec.directory)
        .unwrap_err()
        .contains("overlap"));
    let db = Connection::open(spec.directory.join("data.db")).unwrap();
    db.execute("UPDATE images SET filename='../escape.png' WHERE id=1", [])
        .unwrap();
    drop(db);
    assert!(plan(&[spec], &[])
        .unwrap_err()
        .contains("Unsafe source filename"));
}

#[test]
fn exact_configuration_recovery_keeps_unverified_game_evidence_separate() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let config_path = temp.path().join("regions.json");
    fs::write(&config_path, r#"{"screen_width":12,"screen_height":8}"#).unwrap();
    use md5::{Digest, Md5};
    let hash = format!(
        "{:x}",
        Md5::digest(b"{\"screen_height\": 8, \"screen_width\": 12}")
    );
    let db = Connection::open(spec.directory.join("data.db")).unwrap();
    db.execute("UPDATE full_captures SET regions_hash=?", [&hash])
        .unwrap();
    drop(db);
    let prepared = plan(&[spec], &[PathBuf::from(config_path)]).unwrap();
    assert_eq!(
        prepared.batch.frames[0].config["regions"]["screen_width"],
        12
    );
    assert_eq!(
        prepared.batch.frames[0].evidence["configuration_recovery"],
        "matching_python_sorted_json_md5"
    );
    let _: Value = serde_json::to_value(&prepared).unwrap();
}

fn policy_fixture(root: &Path) -> (SourceSpec, PathBuf) {
    let source = fixture(root);
    let config = json!({"screen_width":12,"screen_height":8,"round_id":{"x":1,"y":2,"w":3,"h":4},"seats":[{"status":{"x":1,"y":2,"w":3,"h":4}}]});
    let serialized="{\"round_id\": {\"h\": 4, \"w\": 3, \"x\": 1, \"y\": 2}, \"screen_height\": 8, \"screen_width\": 12, \"seats\": [{\"status\": {\"h\": 4, \"w\": 3, \"x\": 1, \"y\": 2}}]}";
    use md5::{Digest, Md5};
    let hash = format!("{:x}", Md5::digest(serialized));
    let path = root.join("regions.json");
    fs::write(&path, config.to_string()).unwrap();
    let db = Connection::open(root.join("data.db")).unwrap();
    db.execute("UPDATE full_captures SET regions_hash=?", [hash])
        .unwrap();
    db.execute("INSERT INTO images VALUES(4,'blank.png','blank','','seats[0].status',1,1700000000000,1,2,3,4)",[]).unwrap();
    let mut cropped = Cursor::new(vec![]);
    DynamicImage::new_rgb8(3, 4)
        .write_to(&mut cropped, ImageFormat::Png)
        .unwrap();
    for name in ["round.png", "blank.png"] {
        fs::write(root.join("images").join(name), cropped.get_ref()).unwrap();
    }
    (source, path)
}

#[test]
fn legacy_policy_preserves_text_blanks_pixels_and_rejects_old_plans() {
    let temp = tempfile::tempdir().unwrap();
    let (source, config) = policy_fixture(&temp.path().join("source"));
    let prepared = plan(&[source.clone()], &[config]).unwrap();
    assert_eq!(prepared.version, 2);
    assert_eq!(prepared.batch.frames[0].labels.len(), 2);
    assert_eq!(prepared.batch.frames[0].hand_id.as_deref(), Some("123456"));
    assert_eq!(prepared.batch.frames[1].hand_id, None);
    assert!(prepared.batch.frames[1].labels.is_empty());
    let blank = prepared.batch.frames[0]
        .labels
        .iter()
        .find(|l| l.region_id == "seats[0].status")
        .unwrap();
    assert_eq!(blank.label, "");
    assert_eq!(blank.provenance["explicit_blank"], true);
    assert_eq!(blank.provenance["visually_verified"], false);
    let destination = temp.path().join("destination");
    Store::new(destination.clone()).unwrap();
    let mut old = prepared.clone();
    old.version = 1;
    assert!(apply(&old, &destination)
        .unwrap_err()
        .contains("Unsupported"));
    apply(&prepared, &destination).unwrap();
    assert_eq!(apply(&prepared, &destination).unwrap()["reused"], 2);
    let db = Connection::open(destination.join("gameplay.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM gameplay_import_labels", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM pixel_assets", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    fs::write(&blank.source_path, png()).unwrap();
    assert!(apply(&prepared, &destination)
        .unwrap_err()
        .contains("Source inventory changed since planning"));
}

#[test]
fn conflicting_or_misaligned_annotations_are_retained_without_current_readings() {
    let temp = tempfile::tempdir().unwrap();
    let (source, config) = policy_fixture(&temp.path().join("source"));
    let db = Connection::open(source.directory.join("data.db")).unwrap();
    db.execute("INSERT INTO images VALUES(5,'other.png','other','occupied','seats[0].status',1,1700000000000,1,2,3,4)",[]).unwrap();
    fs::copy(
        source.directory.join("images/blank.png"),
        source.directory.join("images/other.png"),
    )
    .unwrap();
    db.execute("UPDATE images SET x=2 WHERE region_id='round_id'", [])
        .unwrap();
    drop(db);
    let prepared = plan(&[source], &[config]).unwrap();
    assert!(prepared.batch.frames[0].labels.is_empty());
    assert!(prepared.batch.frames[0].hand_id.is_none());
    assert_eq!(
        prepared.batch.frames[0].evidence["unresolved_annotations"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn reviewed_queue_blank_is_explicit_truth_but_unreviewed_prediction_is_not() {
    let temp = tempfile::tempdir().unwrap();
    let (source, config) = policy_fixture(&temp.path().join("source"));
    let db = Connection::open(source.directory.join("data.db")).unwrap();
    db.execute_batch("ALTER TABLE queue_items ADD COLUMN reviewed INTEGER DEFAULT 0; ALTER TABLE queue_items ADD COLUMN region_id TEXT; ALTER TABLE queue_items ADD COLUMN label TEXT;").unwrap();
    db.execute("DELETE FROM images WHERE id=4", []).unwrap();
    let png = fs::read(source.directory.join("images/blank.png")).unwrap();
    let payload = json!({"rect":{"x":1,"y":2,"w":3,"h":4}});
    db.execute("INSERT INTO queue_items(queue_id,source,game_id,payload,crop,reviewed,region_id,label) VALUES(5,'first.png','#untrusted',?,?,1,'seats[0].status','')",params![payload.to_string(),png]).unwrap();
    drop(db);
    let prepared = plan(&[source.clone()], &[config.clone()]).unwrap();
    assert_eq!(prepared.batch.frames[0].labels.len(), 2);
    assert_eq!(prepared.batch.frames[0].hand_id.as_deref(), Some("123456"));
    let blank = prepared.batch.frames[0]
        .labels
        .iter()
        .find(|l| l.label.is_empty())
        .unwrap();
    assert!(blank.encoded_png.is_some());
    let destination = temp.path().join("destination");
    Store::new(destination.clone()).unwrap();
    apply(&prepared, &destination).unwrap();
    let db = Connection::open(source.directory.join("data.db")).unwrap();
    db.execute("UPDATE queue_items SET reviewed=0 WHERE queue_id=5", [])
        .unwrap();
    drop(db);
    let unreviewed = plan(&[source], &[config]).unwrap();
    assert_eq!(unreviewed.batch.frames[0].labels.len(), 1);
}

#[test]
fn apply_rejects_changed_removed_or_added_unresolved_pngs() {
    for change in ["change", "remove", "add"] {
        let temp = tempfile::tempdir().unwrap();
        let spec = fixture(&temp.path().join("source"));
        let prepared = plan(&[spec.clone()], &[]).unwrap();
        let destination = temp.path().join("destination");
        Store::new(destination.clone()).unwrap();
        match change {
            "change" => fs::write(spec.directory.join("images/orphan.png"), b"changed").unwrap(),
            "remove" => fs::remove_file(spec.directory.join("images/orphan.png")).unwrap(),
            _ => fs::write(spec.directory.join("images/added.png"), png()).unwrap(),
        }
        assert!(apply(&prepared, &destination).is_err(), "{change}");
        let conn = Connection::open(destination.join("gameplay.sqlite3")).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM frames", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn source_inventory_is_checked_before_the_import_transaction_commits() {
    let temp = tempfile::tempdir().unwrap();
    let spec = fixture(&temp.path().join("source"));
    let prepared = plan(&[spec.clone()], &[]).unwrap();
    let destination = temp.path().join("destination");
    let store = Store::new(destination.clone()).unwrap();
    let result = store.import_legacy_checked(&prepared.batch, || {
        fs::write(
            spec.directory.join("images/orphan.png"),
            b"changed during import",
        )
        .unwrap();
        prepared.sources[0].assert_unchanged()
    });
    assert!(result.unwrap_err().contains("Source inventory changed"));
    let conn = Connection::open(destination.join("gameplay.sqlite3")).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM frames", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    fs::write(spec.directory.join("images/orphan.png"), png()).unwrap();
    assert_eq!(apply(&prepared, &destination).unwrap()["inserted"], 2);
}
