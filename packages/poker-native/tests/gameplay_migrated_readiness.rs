use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, Rgb, RgbImage};
use md5::{Digest, Md5};
use poker_native::{
    lab::{
        legacy_benchmark::{apply, plan, SourceSpec},
        sha256, LabRequest, LabResponse, LabService,
    },
    media,
};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

fn request(
    service: &LabService,
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    body: Value,
) -> LabResponse {
    let response = service.request(LabRequest {
        method: method.into(),
        path: path.into(),
        body,
        query: query
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        headers: BTreeMap::new(),
    });
    assert_eq!(response.status, 200, "{method} {path}: {}", response.body);
    response
}

fn source_hashes(root: &Path) -> BTreeMap<PathBuf, String> {
    fn visit(root: &Path, path: &Path, hashes: &mut BTreeMap<PathBuf, String>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, hashes);
            } else {
                hashes.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    sha256(&fs::read(path).unwrap()),
                );
            }
        }
    }
    let mut hashes = BTreeMap::new();
    visit(root, root, &mut hashes);
    hashes
}

fn service(root: &Path) -> LabService {
    LabService::open_with_paths(
        root.join("data"),
        root.join("config"),
        root.join("missing-tools"),
        HashMap::from([
            ("HOME".into(), root.display().to_string()),
            (
                "OCR_MODEL_PYTHON".into(),
                root.join("unavailable-python").display().to_string(),
            ),
            (
                "POKER_GAMEPLAY_ROOT".into(),
                root.join("recordings").display().to_string(),
            ),
        ]),
    )
    .unwrap()
}

fn assert_verification_accounting(detail: &Value, profile: &Value) {
    let regions = profile["profile"]["regions"].as_array().unwrap();
    let readings = detail["effective_results"].as_object().unwrap();
    assert_eq!(readings.len(), 104);
    let mut absent = 0u64;
    let mut cards = 0;
    let mut visual = 0;
    for region in regions {
        let id = region["id"].as_str().unwrap();
        let reading = readings.get(id).unwrap();
        let state = reading["verification"]["state"].as_str().unwrap();
        if region["ocr"] == false {
            visual += 1;
            assert_eq!(state, "visual_indicator", "{id}");
        } else {
            assert_ne!(state, "visual_indicator", "{id}");
            if matches!(region["category"].as_str(), Some("card" | "suit")) {
                cards += 1;
                assert_ne!(state, "absent", "{id}");
            }
            if state == "absent" {
                absent += 1;
                assert!(reading["prediction"].is_null(), "{id}");
            }
        }
    }
    assert_eq!(cards, 46);
    assert_eq!(visual, 9);
    let verification = &detail["verification"];
    assert_eq!(verification["absent_count"], absent);
    let total = verification["total"].as_u64().unwrap();
    assert_eq!(total + absent, 95);
    assert_eq!(
        total,
        ["verified", "unverified", "needs_review", "unsupported"]
            .iter()
            .map(|bucket| verification[bucket].as_u64().unwrap())
            .sum::<u64>()
    );
}

#[test]
fn migrated_sparse_recording_uses_public_gameplay_review_and_preserves_source_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(source.join("images")).unwrap();
    fs::create_dir_all(source.join("full_captures")).unwrap();
    let old_config = json!({"screen_height":1080,"screen_width":1920,"round_id":{"x":0,"y":0,"w":1920,"h":1080},"seats":[{"name":{"x":0,"y":0,"w":1920,"h":1080},"status":{"x":0,"y":0,"w":1920,"h":1080}}]});
    let old_config_bytes = b"{\"round_id\": {\"h\": 1080, \"w\": 1920, \"x\": 0, \"y\": 0}, \"screen_height\": 1080, \"screen_width\": 1920, \"seats\": [{\"name\": {\"h\": 1080, \"w\": 1920, \"x\": 0, \"y\": 0}, \"status\": {\"h\": 1080, \"w\": 1920, \"x\": 0, \"y\": 0}}]}";
    let old_hash = format!("{:x}", Md5::digest(old_config_bytes));
    let config_path = source.join("original-regions.json");
    fs::write(&config_path, old_config.to_string()).unwrap();
    let source_db = Connection::open(source.join("data.db")).unwrap();
    source_db.execute_batch("CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT,monitor TEXT,timestamp INTEGER,regions_hash TEXT);CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT,phash TEXT,label TEXT,region_id TEXT,source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER);").unwrap();
    let mut original_pixels = BTreeMap::new();
    for (index, name, hash) in [
        (1, "known.png", old_hash.as_str()),
        (2, "unknown.png", "unknown"),
    ] {
        let pixels = RgbImage::from_fn(1920, 1080, |x, y| {
            Rgb([
                ((x + y + index * 19) % 251) as u8,
                ((x / 7 + y + index * 23) % 253) as u8,
                ((x + y / 5 + index * 29) % 249) as u8,
            ])
        });
        let png = media::png(&DynamicImage::ImageRgb8(pixels)).unwrap();
        fs::write(source.join("full_captures").join(name), &png).unwrap();
        original_pixels.insert(name, png);
        source_db
            .execute(
                "INSERT INTO full_captures VALUES(?1,?2,'retired-monitor',?3,?4)",
                params![index, name, 1700000000000i64 + i64::from(index), hash],
            )
            .unwrap();
    }
    for (id, filename, label, region) in [
        (1, "game.png", "# 123456", "round_id"),
        (2, "name.png", "Old Alice 玩家", "seats[0].name"),
        (3, "blank.png", "", "seats[0].status"),
    ] {
        fs::write(
            source.join("images").join(filename),
            &original_pixels["known.png"],
        )
        .unwrap();
        source_db.execute("INSERT INTO images VALUES(?1,?2,'original-phash',?3,?4,1,1700000000001,0,0,1920,1080)",params![id,filename,label,region]).unwrap();
    }
    drop(source_db);
    let before = source_hashes(&source);
    let spec = SourceSpec {
        id: "readiness-fixture".into(),
        name: "Migrated sparse fixture".into(),
        directory: source.clone(),
    };
    let prepared = plan(&[spec], &[config_path]).unwrap();
    assert_eq!(prepared.batch.frames.len(), 2);
    assert_eq!(prepared.batch.frames[0].labels.len(), 3);
    assert_eq!(prepared.batch.frames[0].hand_id.as_deref(), Some("123456"));
    assert!(prepared.batch.frames[1].hand_id.is_none());
    let app = service(temp.path());
    let destination = app.gameplay.evidence_root().unwrap();
    assert_eq!(apply(&prepared, &destination).unwrap()["inserted"], 2);
    let collection_id = prepared.batch.collection.id.as_str();
    let session_id = prepared.batch.sessions[0].id.as_str();
    let collections = request(&app, "GET", "/api/gameplay/collections", &[], Value::Null).body;
    let collection = collections["collections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == collection_id)
        .unwrap();
    assert_eq!(collection["kind"], "legacy_benchmark");
    assert_eq!(collection["recording_count"], 1);
    assert_eq!(collection["frame_count"], 2);
    let sessions = request(
        &app,
        "GET",
        "/api/gameplay",
        &[("collection_id", collection_id)],
        Value::Null,
    )
    .body;
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        sessions["sessions"][0]["source"],
        "legacy-benchmark:readiness-fixture"
    );
    assert_eq!(sessions["sessions"][0]["interval_ms"], 0);
    let games = request(
        &app,
        "GET",
        &format!("/api/gameplay/sessions/{session_id}"),
        &[],
        Value::Null,
    )
    .body;
    assert_eq!(games["hands"].as_array().unwrap().len(), 2);
    assert!(games["hands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["hand_id"] == "123456"));
    assert!(games["hands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["hand_id"].is_null()));
    let frames = request(
        &app,
        "GET",
        &format!("/api/gameplay/sessions/{session_id}/frames"),
        &[],
        Value::Null,
    )
    .body;
    assert_eq!(frames["frames"].as_array().unwrap().len(), 2);
    let mut paged = vec![];
    for path in [
        format!("/api/gameplay/sessions/{session_id}"),
        format!("/api/gameplay/sessions/{session_id}/frames"),
    ] {
        let page = app
            .list_page(
                LabRequest {
                    method: "GET".into(),
                    path,
                    body: Value::Null,
                    query: BTreeMap::new(),
                    headers: BTreeMap::new(),
                },
                None,
                Some(100),
            )
            .unwrap();
        assert_eq!(page.status, 200);
        paged.push(page.body);
    }
    assert_eq!(
        games["hands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["hand_id"] == "123456")
            .unwrap()["verification"]["verified"],
        3
    );
    assert!(paged.iter().all(|page| page["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["verification"]["verified"] == 3)));
    let profile = request(&app, "GET", "/api/gameplay/ai/profile", &[], Value::Null).body;
    assert_eq!(profile["profile"]["regions"].as_array().unwrap().len(), 104);
    assert_eq!(
        profile["profile"]["regions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|region| region["ocr"] != false)
            .count(),
        95
    );
    let mut initial_details = vec![];
    for (index, frame) in prepared.batch.frames.iter().enumerate() {
        let detail = request(
            &app,
            "GET",
            &format!("/api/gameplay/frames/{}", frame.id),
            &[],
            Value::Null,
        )
        .body["frame"]
            .clone();
        assert_eq!(detail["ocr_status"], "error");
        assert_eq!(detail["results"], json!({}));
        assert_eq!(
            detail["effective_config_snapshot"]["region_profile_id"],
            profile["id"]
        );
        assert_verification_accounting(&detail, &profile);
        let image = request(
            &app,
            "GET",
            detail["image_url"].as_str().unwrap(),
            &[],
            Value::Null,
        );
        assert_eq!(image.headers["content-type"], "image/png");
        assert_eq!(
            STANDARD.decode(image.body_base64.unwrap()).unwrap(),
            original_pixels[if index == 0 {
                "known.png"
            } else {
                "unknown.png"
            }]
        );
        initial_details.push(detail);
    }
    assert!(
        initial_details[0]["verification"]["absent_count"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(initial_details[0]["config_snapshot"]["regions"], old_config);
    for (region, label) in [
        ("round_id", "# 123456"),
        ("seats[0].name", "Old Alice 玩家"),
        ("seats[0].status", ""),
    ] {
        let reading = &initial_details[0]["effective_results"][region];
        assert_eq!(reading["verification"]["state"], "legacy_verified");
        assert_eq!(reading["verification"]["source"], "legacy");
        assert_eq!(reading["prediction"]["text"], label);
        assert_eq!(reading["prediction"]["visually_verified"], false);
        assert!(reading["verification"]["legacy_provenance"]["crop"]["id"].is_number());
    }
    assert_eq!(
        frames["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == prepared.batch.frames[0].id)
            .unwrap()["verification"]["verified"],
        3
    );
    let verified_selection = ["round_id", "seats[0].name", "seats[0].status"]
        .map(|region| json!({"frame_id":prepared.batch.frames[0].id,"region_id":region}));
    let only_verified = request(
        &app,
        "POST",
        "/api/gameplay/ai/prepare",
        &[],
        json!({"session_id":session_id,"selection":verified_selection}),
    )
    .body;
    let verified_status = request(
        &app,
        "POST",
        "/api/gameplay/ai/start",
        &[],
        json!({"session_id":session_id,"run_id":only_verified["run_id"]}),
    )
    .body;
    assert_eq!(verified_status["job"]["usage"]["requests"], 0);
    assert_eq!(verified_status["job"]["counts"]["verified"], 3);
    let owned = request(
        &app,
        "GET",
        "/api/gameplay/ai/items",
        &[("session_id", session_id)],
        Value::Null,
    )
    .body;
    for item in owned["items"].as_array().unwrap() {
        assert_eq!(item["crop_scope"], "legacy_source");
        assert!(item["guide"].is_null());
        let crop = request(
            &app,
            "GET",
            item["crop_url"].as_str().unwrap(),
            &[],
            Value::Null,
        );
        assert_eq!(
            STANDARD.decode(crop.body_base64.unwrap()).unwrap(),
            original_pixels["known.png"]
        );
    }
    let own = owned["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["region_id"] == "seats[0].name")
        .unwrap();
    request(
        &app,
        "POST",
        "/api/gameplay/ai/review",
        &[],
        json!({"occurrence_id":own["id"],"expected_revision":own["revision"],"action":"manual","label":"Current Alice"}),
    );
    let selection = prepared
        .batch
        .frames
        .iter()
        .map(|frame| json!({"frame_id":frame.id,"region_id":"community_cards[0]"}))
        .collect::<Vec<_>>();
    let review_prepare = request(
        &app,
        "POST",
        "/api/gameplay/ai/prepare",
        &[],
        json!({"session_id":session_id,"selection":selection}),
    )
    .body;
    assert_eq!(review_prepare["scope"]["frame_count"], 2);
    assert_eq!(review_prepare["scope"]["occurrences"], 2);
    assert_eq!(review_prepare["scope"]["profile_id"], profile["id"]);
    let items = request(
        &app,
        "GET",
        "/api/gameplay/ai/items",
        &[("session_id", session_id)],
        Value::Null,
    )
    .body;
    assert_eq!(items["total"], 2);
    let mut reviews = vec![];
    for item in items["items"].as_array().unwrap() {
        assert_eq!(item["region_id"], "community_cards[0]");
        assert!(["pending", "flagged"].contains(&item["state"].as_str().unwrap()));
        assert!(item["guide"].is_object());
        let label = if item["frame_id"] == prepared.batch.frames[0].id {
            "Q"
        } else {
            ""
        };
        let review = request(&app, "POST", "/api/gameplay/ai/review", &[], json!({"occurrence_id":item["id"],"expected_revision":item["revision"],"action":"manual","label":label})).body;
        assert_eq!(review["item"]["state"], "manual");
        assert_eq!(review["item"]["label"], label);
        reviews.push(review);
    }
    let status = request(
        &app,
        "GET",
        "/api/gameplay/ai/status",
        &[("session_id", session_id)],
        Value::Null,
    )
    .body;
    assert_eq!(status["job"]["usage"]["requests"], 0);
    assert_eq!(status["job"]["counts"]["manual"], 2);
    let evidence = Connection::open_with_flags(
        temp.path().join("data/ocr-evidence.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        evidence
            .query_row("SELECT COUNT(*) FROM ai_review_attempts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(evidence);
    assert_eq!(apply(&prepared, &destination).unwrap()["reused"], 2);
    let imported = Connection::open_with_flags(
        destination.join("gameplay.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        imported
            .query_row("SELECT COUNT(*) FROM frames", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        imported
            .query_row("SELECT COUNT(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let retained: String = imported
        .query_row(
            "SELECT evidence_json FROM gameplay_import_origins WHERE frame_id=?",
            [&prepared.batch.frames[0].id],
            |row| row.get(0),
        )
        .unwrap();
    let retained: Value = serde_json::from_str(&retained).unwrap();
    assert!(retained["crops"]
        .as_array()
        .unwrap()
        .iter()
        .any(|crop| crop["label"] == "Old Alice 玩家"));
    assert_eq!(retained["game_id_verified"], true);
    let unknown_config: String = imported
        .query_row(
            "SELECT config_json FROM frames WHERE id=?",
            [&prepared.batch.frames[1].id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unknown_config, "null");
    drop(imported);
    drop(app);
    let reopened = service(temp.path());
    let mut persisted_details = vec![];
    for (index, frame) in prepared.batch.frames.iter().enumerate() {
        let detail = request(
            &reopened,
            "GET",
            &format!("/api/gameplay/frames/{}", frame.id),
            &[],
            Value::Null,
        )
        .body["frame"]
            .clone();
        if index == 0 {
            assert_eq!(
                detail["effective_results"]["seats[0].name"]["prediction"]["text"],
                "Current Alice"
            );
            assert_eq!(
                detail["effective_results"]["seats[0].name"]["verification"]["source"],
                "human"
            );
            assert_eq!(
                detail["effective_results"]["seats[0].status"]["verification"]["state"],
                "legacy_verified"
            );
        }
        let reading = &detail["effective_results"]["community_cards[0]"];
        assert_verification_accounting(&detail, &profile);
        assert_eq!(reading["verification"]["state"], "manual");
        assert_eq!(reading["verification"]["source"], "human");
        assert_eq!(
            reading["prediction"]["text"],
            if index == 0 { "Q" } else { "" }
        );
        persisted_details.push(detail);
    }
    assert_eq!(source_hashes(&source), before);
    for receipt in &prepared.sources {
        receipt.assert_unchanged().unwrap();
    }
    if let Some(path) = std::env::var_os("POKER_MIGRATED_RESPONSE_FIXTURE") {
        fs::write(path, serde_json::to_vec_pretty(&json!({"collections":collections,"sessions":sessions,"games":games,"frames":frames,"profile":profile,"paged":paged,"verified_prepare":only_verified,"verified_items":owned,"verified_status":verified_status,"prepare":review_prepare,"items":items,"reviews":reviews,"status":status,"initial_details":initial_details,"persisted_details":persisted_details})).unwrap()).unwrap();
    }
    for detail in initial_details.iter().chain(&persisted_details) {
        assert!(detail.get("config_snapshot").is_none_or(Value::is_object), "Published Gameplay frame schema requires an object when config_snapshot is present: {}", detail["config_snapshot"]);
    }
}
