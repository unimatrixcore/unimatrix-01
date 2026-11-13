use image::{DynamicImage, Rgba, RgbaImage};
use poker_native::{
    labels::validate_label,
    media,
    types::{canonical_id, RegionSettings},
    NativeStore,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::Path};
use tempfile::TempDir;

fn fixture(dir: &Path) -> Value {
    fs::create_dir_all(dir.join("images")).unwrap();
    fs::create_dir_all(dir.join("full_captures")).unwrap();
    let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(4, 4, Rgba([10, 20, 30, 255])));
    let crop = image.crop_imm(0, 0, 2, 2);
    let bytes = media::png(&crop).unwrap();
    fs::write(dir.join("images/sample.png"), &bytes).unwrap();
    fs::write(
        dir.join("full_captures/master.png"),
        media::png(&image).unwrap(),
    )
    .unwrap();
    let conn = Connection::open(dir.join("data.db")).unwrap();
    conn.execute_batch("CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT UNIQUE,phash TEXT,label TEXT,region_id TEXT,source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER);
CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT UNIQUE,monitor TEXT,timestamp INTEGER,regions_hash TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE session_progress(id INTEGER PRIMARY KEY,data TEXT);
CREATE TABLE session_history(id INTEGER PRIMARY KEY,timestamp INTEGER,data TEXT);
CREATE TABLE private_review_events(id INTEGER PRIMARY KEY,original_id TEXT,decision TEXT);
CREATE TRIGGER private_review_audit AFTER UPDATE OF label ON images BEGIN INSERT INTO private_review_events(original_id,decision) VALUES(NEW.region_id,NEW.label); END;
INSERT INTO full_captures VALUES(1,'master.png','DP-1',100,'old');
INSERT INTO images VALUES(1,'sample.png','0000000000000000000000000000000000000000000000000000000000000000','','seats[0].cards[0]',1,100,0,0,2,2);
INSERT INTO private_review_events VALUES(1,'legacy-id','unknown');
INSERT INTO settings VALUES('config','{\"last_monitor\":\"DP-1\",\"username\":\"Alice\",\"unknownSetting\":true}');
INSERT INTO session_history VALUES(1,123,'{\"points\":44,\"date\":\"old\"}');").unwrap();
    let legacy = json!({"frames":[{"id":1,"source":"master.png","game_id":"# 123456","thumbnail":"aGVsbG8=","regions":[{"id":"seats[0].cards[0]","source":"master.png","rect":{"x":0,"y":0,"w":2,"h":2},"phash":media::dhash(&crop),"label":"","base64_image":media::data_url(&bytes).trim_start_matches("data:image/png;base64,")}]}],"pool":[{"id":"seats[0].cards[0]","source":"master.png","rect":{"x":0,"y":0,"w":2,"h":2},"phash":media::dhash(&crop),"label":"","base64_image":media::data_url(&bytes).trim_start_matches("data:image/png;base64,")}],"currentReviewIdx":2,"sessionScore":88,"currentCombo":3,"usernamePool":["Alice"],"unknownProgress":"retain me"});
    conn.execute(
        "INSERT INTO session_progress VALUES(1,?)",
        [legacy.to_string()],
    )
    .unwrap();
    legacy
}
fn store() -> (TempDir, NativeStore) {
    let t = TempDir::new().unwrap();
    let s = NativeStore::open(t.path().join("managed")).unwrap();
    (t, s)
}
fn import(store: &mut NativeStore, source: &Path) {
    assert_eq!(
        store
            .request("import_dataset", &json!({"path":source}))
            .unwrap(),
        json!({"changed":1})
    );
}
fn entries(store: &mut NativeStore) -> Value {
    store
        .request("entries", &json!({"search":"","offset":0,"limit":250}))
        .unwrap()
}
fn session() -> Value {
    json!({"frames":[],"pool":[],"currentIndex":0,"points":0.0,"streak":0,"elapsedMs":0.0})
}
fn sample(label: &str, decision: &str) -> Value {
    let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255])));
    let bytes = media::png(&image).unwrap();
    json!({"key":"test-sample","regionId":"seat.0.hand_0","label":label,"decision":decision,"image":media::data_url(&bytes),"phash":media::dhash(&image),"source":"master.png","rect":{"x":0,"y":0,"w":2,"h":2}})
}
#[test]
fn import_preserves_unknown_schema_raw_progress_and_unverified_empty_labels() {
    let source = TempDir::new().unwrap();
    let legacy = fixture(source.path());
    let before = fs::read(source.path().join("data.db")).unwrap();
    let (_temp, mut s) = store();
    import(&mut s, source.path());
    assert_eq!(before, fs::read(source.path().join("data.db")).unwrap());
    let boot = s.request("bootstrap", &json!({})).unwrap();
    assert_eq!(boot["stats"]["images"], 1);
    assert_eq!(boot["stats"]["captures"], 1);
    assert_eq!(boot["settings"]["monitor"], "DP-1");
    assert_eq!(boot["settings"]["unknownSetting"], true);
    assert_eq!(boot["session"]["points"].as_f64(), Some(88.0));
    assert_eq!(boot["session"]["streak"], 3);
    assert_eq!(boot["session"]["pool"][0]["decision"], "pending");
    assert_eq!(boot["session"]["pool"][0]["regionId"], "seats[0].cards[0]");
    assert_eq!(boot["history"][0]["timestamp"], 123);
    assert!(entries(&mut s)["items"][0]["decision"].is_null());
    let db = Connection::open(s.data_dir().join("data.db")).unwrap();
    let raw: String = db
        .query_row("SELECT raw_session FROM unimatrix_imports", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), legacy);
    let snapshot = Connection::open(s.data_dir().join("legacy-snapshot.db")).unwrap();
    let raw: String = snapshot
        .query_row("SELECT data FROM session_progress", [], |r| r.get(0))
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), legacy);
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT COUNT(*) FROM private_review_events", [], |r| r
            .get(0))
            .unwrap(),
        1
    );
    drop(db);
    s.request(
        "update_labels",
        &json!({"filenames":["sample.png"],"label":"A"}),
    )
    .unwrap();
    let db = Connection::open(s.data_dir().join("data.db")).unwrap();
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT COUNT(*) FROM private_review_events", [], |r| r
            .get(0))
            .unwrap(),
        2
    );
    assert!(s
        .request("import_dataset", &json!({"path":source.path()}))
        .unwrap_err()
        .contains("empty"));
}
#[test]
fn commits_reject_pending_and_invalid_labels_without_writes_then_commit_explicit_blank() {
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (_temp, mut s) = store();
    import(&mut s, source.path());
    let before = fs::read_dir(s.data_dir().join("images")).unwrap().count();
    let mut state = session();
    let mut pending = sample("", "pending");
    pending["key"] = json!("second");
    state["pool"] = json!([sample("A", "label"), pending]);
    assert!(s
        .request("commit_session", &json!({"session":state}))
        .unwrap_err()
        .contains("pending"));
    assert_eq!(entries(&mut s)["total"], 1);
    assert_eq!(
        fs::read_dir(s.data_dir().join("images")).unwrap().count(),
        before
    );
    state["pool"] = json!([sample("As", "label")]);
    assert!(s
        .request("commit_session", &json!({"session":state}))
        .is_err());
    assert_eq!(entries(&mut s)["total"], 1);
    state["pool"] = json!([sample("", "blank")]);
    assert_eq!(
        s.request("commit_session", &json!({"session":state}))
            .unwrap(),
        json!({"changed":1})
    );
    let items = entries(&mut s);
    assert_eq!(items["total"], 2);
    assert_eq!(items["items"][0]["decision"], "blank");
    assert_eq!(items["items"][0]["label"], "");
    assert!(
        s.request("bootstrap", &json!({})).unwrap()["session"]["pool"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn trigger_failure_rolls_back_batch_and_crop_files() {
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (_temp, mut s) = store();
    import(&mut s, source.path());
    let conn = Connection::open(s.data_dir().join("data.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_blank BEFORE INSERT ON images WHEN NEW.label='' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;").unwrap();
    drop(conn);
    let mut second = sample("", "blank");
    second["key"] = json!("second");
    let mut state = session();
    state["pool"] = json!([sample("A", "label"), second]);
    assert!(s
        .request("commit_session", &json!({"session":state}))
        .unwrap_err()
        .contains("fixture rejection"));
    assert_eq!(entries(&mut s)["total"], 1);
    assert_eq!(
        fs::read_dir(s.data_dir().join("images")).unwrap().count(),
        1
    );
}
#[test]
fn discarded_sample_is_excluded_and_save_session_survives_reopen() {
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (temp, mut s) = store();
    import(&mut s, source.path());
    let mut state = session();
    state["pool"] = json!([sample("", "discard")]);
    state["points"] = json!(22.0);
    state["streak"] = json!(4);
    s.request("save_session", &json!({"session":state}))
        .unwrap();
    drop(s);
    let mut s = NativeStore::open(temp.path().join("managed")).unwrap();
    let boot = s.request("bootstrap", &json!({})).unwrap();
    assert_eq!(boot["session"], state);
    assert_eq!(
        s.request("commit_session", &json!({"session":state}))
            .unwrap(),
        json!({"changed":0})
    );
    assert_eq!(entries(&mut s)["total"], 1);
}
#[test]
fn rejects_path_traversal_symlinks_and_unmanaged_destinations() {
    let (temp, mut s) = store();
    for name in ["../secret.png", "/tmp/secret.png", "a\\b.png", "..", ""] {
        assert!(s
            .request("image", &json!({"filename":name,"kind":"crop"}))
            .is_err());
        assert!(s
            .request("delete_entries", &json!({"filenames":[name]}))
            .is_err());
    }
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"safe").unwrap();
    assert!(NativeStore::open(outside.clone()).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("keep"), s.data_dir().join("images/escape.png"))
            .unwrap();
        assert!(s
            .request("image", &json!({"filename":"escape.png","kind":"crop"}))
            .is_err());
        assert!(s
            .request("clear_database", &json!({"confirmation":"CLEAR"}))
            .is_err());
        assert_eq!(fs::read(outside.join("keep")).unwrap(), b"safe");
    }
}
#[test]
fn missing_legacy_references_are_reported_without_dropping_rows_and_symlinks_still_fail() {
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (_temp, mut s) = store();
    fs::remove_file(source.path().join("images/sample.png")).unwrap();
    fs::remove_file(source.path().join("full_captures/master.png")).unwrap();
    import(&mut s, source.path());
    assert_eq!(entries(&mut s)["total"], 1);
    let report: Value =
        serde_json::from_slice(&fs::read(s.data_dir().join("import-report.json")).unwrap())
            .unwrap();
    assert_eq!(report["missingImageCount"], 1);
    assert_eq!(report["missingCaptureCount"], 1);
    assert_eq!(report["missingImages"], json!(["sample.png"]));
    assert_eq!(report["missingCaptures"], json!(["master.png"]));
    assert!(s.request("bootstrap", &json!({})).unwrap()["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w
            .as_str()
            .unwrap()
            .contains("1 missing crop files and 1 missing master captures")));
    assert_eq!(
        s.request("recrop", &json!({})).unwrap(),
        json!({"changed":0,"skipped":1})
    );
    #[cfg(unix)]
    {
        let source = TempDir::new().unwrap();
        fixture(source.path());
        let (_temp, mut s) = store();
        fs::remove_file(source.path().join("images/sample.png")).unwrap();
        std::os::unix::fs::symlink(
            source.path().join("full_captures/master.png"),
            source.path().join("images/sample.png"),
        )
        .unwrap();
        assert!(s
            .request("import_dataset", &json!({"path":source.path()}))
            .is_err());
        assert_eq!(entries(&mut s)["total"], 0);
    }
}
#[test]
fn validates_flat_regions_and_recrop_resets_changed_pixels_without_renaming_region_ids() {
    assert_eq!(canonical_id("seats[0].cards[0]"), "seat.0.hand_0");
    assert_eq!(canonical_id("community_cards[0]"), "community.card_1");
    assert_eq!(canonical_id("pot"), "pot.main");
    assert_eq!(canonical_id("split_pot"), "pot.split");
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (_temp, mut s) = store();
    import(&mut s, source.path());
    s.request(
        "update_labels",
        &json!({"filenames":["sample.png"],"label":"A"}),
    )
    .unwrap();
    assert!(s.request("save_regions",&json!({"regions":{"seat.0.hand_0":{"x":u32::MAX,"y":0,"w":2,"h":2}},"screenWidth":4,"screenHeight":4})).is_err());
    assert!(s.request("save_regions",&json!({"regions":{"seats[0].cards[0]":{"x":0,"y":0,"w":2,"h":2}},"screenWidth":4,"screenHeight":4})).is_err());
    let config = json!({"regions":{"seat.0.hand_0":{"x":0,"y":0,"w":3,"h":3}},"screenWidth":4,"screenHeight":4});
    s.request("save_regions", &config).unwrap();
    assert_eq!(entries(&mut s)["items"][0]["label"], "A");
    assert_eq!(
        s.request("recrop", &json!({})).unwrap(),
        json!({"changed":1,"skipped":0})
    );
    let after = entries(&mut s);
    assert_eq!(after["items"][0]["regionId"], "seats[0].cards[0]");
    assert_eq!(after["items"][0]["label"], "");
    assert!(after["items"][0]["decision"].is_null());
    assert_eq!(after["items"][0]["rect"]["w"], 3);
    let parsed: RegionSettings = serde_json::from_value(config).unwrap();
    let vision = parsed.vision_config().unwrap();
    assert_eq!(
        vision.seats.unwrap()[0]
            .as_ref()
            .unwrap()
            .cards
            .as_ref()
            .unwrap()[0]
            .unwrap()
            .w,
        3
    );
}
#[test]
fn labels_match_legacy_validation_and_dhash_uses_little_endian_bits() {
    for (id, label) in [
        ("seat.0.name", "Alice..."),
        ("seat.0.status", "Decline Straddle"),
        ("seat.0.dealer", "D"),
        ("community.card_1", "10"),
        ("seat.0.bank", "All-In"),
        ("pot.main", "Pot: S 12.3 BB"),
        ("pot.split", "G 1 BB S 4.2 BB"),
        ("round_id", "# 123456"),
    ] {
        validate_label(id, label).unwrap();
    }
    for (id, label) in [
        ("seat.0.name", "bad name"),
        ("seat.0.status", "Invalid#Status"),
        ("community.card_1", "As"),
        ("seat.0.bet", "G 1.23 BB"),
        ("round_id", "123456"),
    ] {
        assert!(validate_label(id, label).is_err(), "{id}: {label}");
    }
    let mut gradient = RgbaImage::new(17, 16);
    for y in 0..16 {
        for x in 0..17 {
            gradient.put_pixel(
                x,
                y,
                Rgba([
                    255 - (x * 10) as u8,
                    255 - (x * 10) as u8,
                    255 - (x * 10) as u8,
                    255,
                ]),
            );
        }
    }
    assert_eq!(
        media::dhash(&DynamicImage::ImageRgba8(gradient)),
        "ff".repeat(32)
    );
    let zero = "00".repeat(32);
    let mut two = zero.clone();
    two.replace_range(0..2, "03");
    assert_eq!(media::hamming(&zero, &two), 2);
    assert_eq!(media::hamming(&zero, &"é".repeat(32)), u32::MAX);
}

#[cfg(unix)]
#[test]
fn capture_filters_inactive_seats_deduplicates_across_restart_and_rejects_bad_game_id_without_orphans(
) {
    use std::{ffi::OsString, os::unix::fs::PermissionsExt};
    struct EnvGuard(Vec<(&'static str, Option<OsString>)>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let screenshot = temp.path().join("screen.png");
    let mut pixels = RgbaImage::from_pixel(8, 8, Rgba([230, 230, 230, 255]));
    for y in 4..6 {
        for x in 0..2 {
            pixels.put_pixel(x, y, Rgba([25, 42, 53, 255]));
        }
    }
    fs::write(
        &screenshot,
        media::png(&DynamicImage::ImageRgba8(pixels)).unwrap(),
    )
    .unwrap();
    let write_script = |name: &str, contents: &str| {
        let path = bin.join(name);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    };
    write_script(
        "hyprctl",
        "#!/bin/sh\nprintf '[{\"name\":\"TEST\",\"width\":8,\"height\":8}]'\n",
    );
    write_script("grim","#!/bin/sh\n[ \"$1\" = -o ] && [ \"$2\" = TEST ] && [ \"$3\" = - ] || exit 9\n/bin/cat \"$POKER_TEST_SCREEN\"\n");
    write_script("tesseract","#!/bin/sh\n[ \"$1\" = stdin ] && [ \"$2\" = stdout ] && [ \"$3\" = --psm ] && [ \"$4\" = 7 ] || exit 9\n/bin/cat > /dev/null\nprintf '# 123456'\n");
    let _guard = EnvGuard(
        ["PATH", "WAYLAND_DISPLAY", "POKER_TEST_SCREEN"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect(),
    );
    std::env::set_var("PATH", &bin);
    std::env::set_var("WAYLAND_DISPLAY", "test-wayland");
    std::env::set_var("POKER_TEST_SCREEN", &screenshot);
    let root = temp.path().join("managed");
    let mut s = NativeStore::open(root.clone()).unwrap();
    let rect = |x, y| json!({"x":x,"y":y,"w":2,"h":2});
    let config = json!({"screenWidth":8,"screenHeight":8,"regions":{"round_id":rect(0,0),"seat.0.nameplate":rect(0,4),"seat.0.name":rect(0,6),"seat.1.nameplate":rect(2,4),"seat.1.name":rect(2,6),"seat.1.bet":rect(4,6)}});
    s.request("save_regions", &config).unwrap();
    let first = s.request("capture", &json!({"monitor":"TEST"})).unwrap();
    let crops = first["crops"].as_array().unwrap();
    assert_eq!(crops.len(), 3);
    assert!(crops.iter().any(|c| c["regionId"] == "seat.0.name"));
    assert!(crops.iter().any(|c| c["regionId"] == "seat.1.bet"));
    assert!(!crops.iter().any(|c| c["regionId"] == "seat.1.name"));
    assert!(!crops
        .iter()
        .any(|c| c["regionId"].as_str().unwrap().ends_with("nameplate")));
    drop(s);
    let mut s = NativeStore::open(root).unwrap();
    let duplicate = s.request("capture", &json!({"monitor":"TEST"})).unwrap();
    assert!(duplicate["crops"].as_array().unwrap().is_empty());
    s.request("clear_session", &json!({})).unwrap();
    let third = s.request("capture", &json!({"monitor":"TEST"})).unwrap();
    assert_eq!(third["crops"].as_array().unwrap().len(), 3);
    let mut state = s.request("bootstrap", &json!({})).unwrap()["session"].clone();
    for crop in state["pool"].as_array_mut().unwrap() {
        if crop["regionId"] == "round_id" {
            crop["decision"] = json!("label");
        } else {
            crop["label"] = json!("");
            crop["decision"] = json!("blank");
        }
    }
    s.request("commit_session", &json!({"session":state}))
        .unwrap();
    let fourth = s.request("capture", &json!({"monitor":"TEST"})).unwrap();
    assert!(fourth["crops"].as_array().unwrap().is_empty());
    let before = s.request("bootstrap", &json!({})).unwrap()["stats"]["captures"].clone();
    let files_before = fs::read_dir(s.data_dir().join("full_captures"))
        .unwrap()
        .count();
    write_script(
        "tesseract",
        "#!/bin/sh\n/bin/cat >/dev/null\nprintf 'not a game id'\n",
    );
    assert!(s
        .request("capture", &json!({"monitor":"TEST"}))
        .unwrap_err()
        .contains("Game ID not verified"));
    assert_eq!(
        s.request("bootstrap", &json!({})).unwrap()["stats"]["captures"],
        before
    );
    assert_eq!(
        fs::read_dir(s.data_dir().join("full_captures"))
            .unwrap()
            .count(),
        files_before
    );
    assert!(s.request("capture", &json!({"monitor":"missing"})).is_err());
    let mut wrong = config;
    wrong["screenWidth"] = json!(9);
    s.request("save_regions", &wrong).unwrap();
    assert!(s
        .request("game_state", &json!({"monitor":"TEST","username":"Alice"}))
        .unwrap_err()
        .contains("dimensions"));
}

#[test]
fn autosave_does_not_archive_image_payloads_and_delete_collects_only_unused_masters() {
    let source = TempDir::new().unwrap();
    fixture(source.path());
    let (_temp, mut s) = store();
    import(&mut s, source.path());
    let mut state = session();
    state["pool"] = json!([sample("", "pending")]);
    for _ in 0..5 {
        s.request("save_session", &json!({"session":state}))
            .unwrap();
    }
    let conn = Connection::open(s.data_dir().join("data.db")).unwrap();
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM unimatrix_session_archive", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    drop(conn);
    s.request("delete_entries", &json!({"filenames":["sample.png"]}))
        .unwrap();
    assert_eq!(
        s.request("bootstrap", &json!({})).unwrap()["stats"]["captures"],
        1
    );
    assert!(s.data_dir().join("full_captures/master.png").is_file());
    s.request("clear_session", &json!({})).unwrap();
    s.request("delete_entries", &json!({"filenames":["not-present.png"]}))
        .unwrap();
    assert_eq!(
        s.request("bootstrap", &json!({})).unwrap()["stats"]["captures"],
        0
    );
    assert!(!s.data_dir().join("full_captures/master.png").exists());
}

#[test]
fn collector_dhash_matches_pillow_rec601_lanczos_reference() {
    let pixels = RgbaImage::from_fn(63, 41, |x, y| {
        Rgba([
            ((x * 19 + y * 7) % 256) as u8,
            ((x * x + 13 * y) % 256) as u8,
            ((x * 5 + y * y * 3) % 256) as u8,
            255,
        ])
    });
    let image = DynamicImage::ImageRgba8(pixels);
    let gray = media::collector_grayscale(&image);
    assert_eq!(
        [(1, 0), (1, 1), (15, 20), (62, 40)].map(|(x, y)| gray.get_pixel(x, y)[0]),
        [7, 17, 214, 88]
    );
    assert_eq!(
        media::dhash(&image),
        "c8ec4826ec2664626436363333133391b899b989a9c99dcc95ccd64ccb644964"
    );
}
