use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, Rgba, RgbaImage};
use poker_native::{
    lab::{
        self, capture,
        datasets::{DatasetContext, DatasetRegistry},
        queue, review, LabRequest, LabService,
    },
    media,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    sync::Arc,
    time::{Duration, Instant},
};
use tempfile::TempDir;
fn context() -> (TempDir, Arc<DatasetContext>) {
    let temp = TempDir::new().unwrap();
    let registry = DatasetRegistry::new(temp.path().join("datasets")).unwrap();
    let ctx = registry.resolve("legacy").unwrap();
    (temp, ctx)
}
fn png(value: u8) -> Vec<u8> {
    media::png(&DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        2,
        2,
        Rgba([value, value, value, 255]),
    )))
    .unwrap()
}
fn input(key: &str, rid: &str, value: u8) -> review::SampleInput {
    review::SampleInput {
        key: key.into(),
        region_id: rid.into(),
        png: png(value),
        filename: None,
    }
}
fn frame(count: usize) -> Value {
    json!({"id":"manual:frame","source":"frame.png","game_id":"# 123456","regions":(0..count).map(|i|json!({"id":"seat.0.name","source":"frame.png","sample_key":format!("sample-{i:04}"),"phash":"00".repeat(32),"base64_image":STANDARD.encode(png(10)),"label":"","rect":{"x":0,"y":0,"w":2,"h":2}})).collect::<Vec<_>>()})
}
#[test]
fn away_status_uses_normal_acceptance_and_rejects_old_contract_suggestions() {
    let (_temp, ctx) = context();
    let sample = input("away-status", "seats[1].status", 10);
    let fresh = review::prediction(
        &ctx,
        &sample,
        json!({"text":"Away","raw_text":"Away","schema_valid":false}),
    )
    .unwrap();
    assert_eq!(fresh["text"], "Away");
    assert_eq!(fresh["schema_valid"], true);
    let mut stale = fresh.clone();
    stale["schema_valid"] = json!(false);
    stale["validation_contract"] = json!({"version":1,"sha256":"199f3970150c4d84e4510e47e91e22556c1fbd07e60b013ceac45055b2bdf7d0"});
    ctx.connection().unwrap().execute("INSERT INTO model_predictions(id,sample_key,region_id,pixel_sha256,dataset_id,created_at,payload) VALUES(?,?,?,?,?,?,?)",rusqlite::params!["stale-away",sample.key,sample.region_id,fresh["pixel_sha256"].as_str().unwrap(),ctx.id,1,serde_json::to_string(&stale).unwrap()]).unwrap();
    let rejected =
        review::review(&ctx, &sample, "Away", "accepted", Some("stale-away"), false).unwrap_err();
    assert!(rejected.message.contains("validation policy changed"));
    let accepted = review::review(
        &ctx,
        &sample,
        "Away",
        "accepted",
        fresh["id"].as_str(),
        false,
    )
    .unwrap();
    assert_eq!(accepted["label"], "Away");
    assert_eq!(accepted["action"], "accepted");
    assert_eq!(accepted["outside_contract"], 0);
}

#[test]
fn immutable_predictions_reviews_bind_pixels_dataset_region_and_contract() {
    let (_temp, ctx) = context();
    let sample = input("obs", "seat.0.name", 10);
    let prediction = review::prediction(
        &ctx,
        &sample,
        json!({"text":"Player 1","raw_text":"Player 1"}),
    )
    .unwrap();
    assert_eq!(
        prediction["validation_contract"],
        review::validation_contract()
    );
    assert_eq!(prediction["schema_valid"], true);
    assert_eq!(
        review::validation_contract()["sha256"],
        lab::sha256(poker_native::labels::CONTRACT_BYTES)
    );
    assert!(review::review(
        &ctx,
        &sample,
        "Player 2",
        "accepted",
        prediction["id"].as_str(),
        false
    )
    .is_err());
    let event = review::review(
        &ctx,
        &sample,
        "Player 1",
        "accepted",
        prediction["id"].as_str(),
        false,
    )
    .unwrap();
    assert_eq!(event["action"], "accepted");
    assert_eq!(event["schema_valid"], 1);
    assert_eq!(
        review::history(&ctx, Some("obs"), None).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let changed = input("obs", "seat.0.name", 20);
    assert_eq!(
        review::prediction(
            &ctx,
            &changed,
            json!({"text":"Player 1","raw_text":"Player 1"})
        )
        .unwrap_err()
        .status,
        409
    );
    let wrong = input("obs", "seat.0.bank", 10);
    assert_eq!(
        review::prediction(
            &ctx,
            &wrong,
            json!({"text":"G No Chips","raw_text":"G No Chips"})
        )
        .unwrap_err()
        .status,
        409
    );
    let conn = ctx.connection().unwrap();
    assert!(conn
        .execute("UPDATE model_predictions SET payload='{}'", [])
        .is_err());
    assert!(conn.execute("DELETE FROM label_review_events", []).is_err());
    drop(conn);
    let status = input("status", "seat.0.status", 10);
    assert!(review::review(&ctx, &status, "Waiting For Players", "manual", None, false).is_err());
    let outside =
        review::review(&ctx, &status, "Waiting For Players", "manual", None, true).unwrap();
    assert_eq!(outside["outside_contract"], 1);
    assert!(review::review(&ctx, &status, "Waiting For Players", "accepted", None, true).is_err());
}
#[test]
fn queue_identity_cursors_tombstones_and_checkpoints_keep_server_review_truth() {
    let (_temp, ctx) = context();
    queue::ingest_frame(&ctx, &frame(3)).unwrap();
    let summary = queue::summary(&ctx).unwrap();
    assert_eq!(summary["total"], 3);
    assert_eq!(summary["pending"], 3);
    let first = queue::page(&ctx, None, 2, "oldest").unwrap();
    assert_eq!(first["items"][0]["sample_key"], "sample-0000");
    assert!(first["items"][0].get("base64_image").is_none());
    assert!(first["items"][0]["image_url"]
        .as_str()
        .unwrap()
        .ends_with("dataset_id=legacy"));
    let cursor = first["next_cursor"].as_str().unwrap();
    assert_eq!(
        queue::page(&ctx, Some(cursor), 2, "oldest").unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(queue::page(&ctx, Some(cursor), 2, "newest").is_err());
    assert!(queue::page(&ctx, Some("foreign:oldest:1"), 2, "oldest").is_err());
    let page = queue::review_page(&ctx, None, 100).unwrap();
    let mut session = json!({"queue_mode":"paged","review_batch":page["review_batch"],"pool":[{"sample_key":"sample-0000","label":"FORGED","reviewed":true,"prediction_id":"forged","labelTime":42,"discarded":false}]});
    queue::save_checkpoint(&ctx, &session, false).unwrap();
    assert_eq!(queue::summary(&ctx).unwrap()["pending"], 3);
    let pool = queue::session(&ctx).unwrap()["pool"].clone();
    assert_eq!(pool[0]["label"], "");
    assert_eq!(pool[0]["reviewed"], false);
    assert_eq!(pool[0]["labelTime"], 42);
    let event = review::review(
        &ctx,
        &input("sample-0000", "seat.0.name", 10),
        "",
        "manual",
        None,
        false,
    )
    .unwrap();
    assert_eq!(event["label"], "");
    queue::refresh_review(&ctx, "sample-0000").unwrap();
    assert_eq!(queue::summary(&ctx).unwrap()["reviewed"], 1);
    queue::discard(&ctx, &["sample-0001".into()], &[], false).unwrap();
    queue::ingest_frame(&ctx, &frame(3)).unwrap();
    assert_eq!(queue::summary(&ctx).unwrap()["total"], 2);
    session["pool"] = json!([{"sample_key":"sample-0001","label":"Resurrect","reviewed":true}]);
    queue::save_checkpoint(&ctx, &session, false).unwrap();
    assert_eq!(queue::summary(&ctx).unwrap()["total"], 2);
}
#[test]
fn stream_window_ceiling_sequences_and_restartable_receipts_match_source() {
    let (_temp, ctx) = context();
    queue::ingest_frame(&ctx, &frame(125)).unwrap();
    let start = queue::start_stream(&ctx).unwrap();
    let run = start["review_batch"]["batch_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(start["items"].as_array().unwrap().len(), 11);
    let ceiling = start["review_batch"]["ceiling"].as_i64().unwrap();
    let next = queue::stream_next(
        &ctx,
        &run,
        start["review_batch"]["next_cursor"].as_str(),
        10,
    )
    .unwrap();
    assert_eq!(next["items"].as_array().unwrap().len(), 10);
    assert!(queue::stream_next(&ctx, &run, None, 11).is_err());
    let mut checkpoint = start["session"].clone();
    checkpoint["checkpoint_sequence"] = json!(10);
    queue::save_checkpoint(&ctx, &checkpoint, false).unwrap();
    let mut stale = checkpoint.clone();
    stale["checkpoint_sequence"] = json!(9);
    stale["currentReviewIdx"] = json!(8);
    assert_eq!(
        queue::save_checkpoint(&ctx, &stale, false).unwrap()["currentReviewIdx"],
        0
    );
    let mut later = frame(1);
    later["regions"][0]["sample_key"] = json!("later");
    queue::ingest_frame(&ctx, &later).unwrap();
    let mut bad = checkpoint.clone();
    bad["checkpoint_sequence"] = json!(11);
    bad["review_batch"]["keys"] = json!(["later"]);
    assert!(queue::save_checkpoint(&ctx, &bad, false).is_err());
    assert_eq!(queue::stream_stats(&ctx, &run).unwrap()["total"], 125);
    assert!(queue::commit_stream(&ctx, &run).is_err());
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    {
        let conn = ctx.connection().unwrap();
        conn.execute(
            "UPDATE queue_items SET reviewed=1,label='Alice' WHERE queue_id<=?",
            [ceiling],
        )
        .unwrap();
        conn.execute("UPDATE queue_items SET discarded=1 WHERE queue_id=2", [])
            .unwrap();
        conn.execute("UPDATE queue_items SET label='' WHERE queue_id=3", [])
            .unwrap();
    }
    let receipt = queue::commit_stream(&ctx, &run).unwrap();
    assert_eq!(receipt["committed"], 125);
    assert_eq!(receipt["total_stats"]["discarded"], 1);
    assert_eq!(queue::summary(&ctx).unwrap()["total"], 1);
    assert_eq!(queue::commit_stream(&ctx, &run).unwrap(), receipt);
    let new = queue::start_stream(&ctx).unwrap();
    assert_ne!(new["review_batch"]["batch_id"], run);
    assert_eq!(queue::commit_stream(&ctx, &run).unwrap(), receipt);
    assert_eq!(
        queue::session(&ctx).unwrap()["review_batch"]["batch_id"],
        new["review_batch"]["batch_id"]
    );
    assert!(queue::stream_next(&ctx, &run, None, 10).is_err());
}
#[test]
fn legacy_session_queue_migration_preserves_backup_order_and_progress() {
    let (_temp, ctx) = context();
    let mut legacy = json!({"pool":frame(3)["regions"],"frames":[frame(3)],"sessionScore":55,"currentReviewIdx":2,"maxReachedIdx":2,"custom_progress":{"keep":true}});
    legacy["pool"][0]["discarded"] = json!(true);
    ctx.connection()
        .unwrap()
        .execute(
            "INSERT INTO session_progress(id,data) VALUES(1,?)",
            [legacy.to_string()],
        )
        .unwrap();
    queue::ensure(&ctx).unwrap();
    let session = queue::session(&ctx).unwrap();
    assert_eq!(session["pool"].as_array().unwrap().len(), 3);
    assert_eq!(session["sessionScore"], 55);
    assert_eq!(session["currentReviewIdx"], 2);
    assert_eq!(session["custom_progress"], json!({"keep":true}));
    assert_eq!(session["pool"][0]["discarded"], true);
    assert_eq!(
        queue::meta(
            &ctx.connection().unwrap(),
            "legacy_session_backup",
            Value::Null
        )
        .unwrap(),
        legacy
    );
    assert!(ctx
        .directory
        .parent()
        .unwrap()
        .join("backups")
        .read_dir()
        .is_err());
}

struct Fixture {
    temp: TempDir,
    service: Arc<LabService>,
}
impl Fixture {
    fn new(block: bool) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let bin = root.join("bin");
        let tools = root.join("tools");
        fs::create_dir_all(tools.join("dev_tools/training")).unwrap();
        fs::create_dir(&bin).unwrap();
        fs::create_dir(root.join("runtime")).unwrap();
        let mut image = RgbaImage::from_pixel(8, 8, Rgba([240, 240, 240, 255]));
        for y in 4..6 {
            for x in 0..2 {
                image.put_pixel(x, y, Rgba([25, 42, 53, 255]));
            }
        }
        fs::write(
            root.join("screen.png"),
            media::png(&DynamicImage::ImageRgba8(image)).unwrap(),
        )
        .unwrap();
        for (name, script) in [
            ("xrandr", "#!/bin/sh\nprintf 'TEST connected 8x8+0+0\\n'\n"),
            (
                "maim",
                "#!/bin/sh\nfor last do :; done\n/bin/cp \"$POKER_TEST_SCREEN\" \"$last\"\n",
            ),
        ] {
            let file = bin.join(name);
            fs::write(&file, script).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(tools.join("dev_tools/training/collector_inference.py"),"import json,sys,os,time,pathlib\nprint(json.dumps({'ready':True}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n if os.environ.get('POKER_TEST_BLOCK')=='1':\n  pathlib.Path(os.environ['POKER_TEST_STARTED']).write_text('started')\n  while not pathlib.Path(os.environ['POKER_TEST_RELEASE']).exists():time.sleep(.01)\n text=os.environ.get('POKER_TEST_TEXT','# 123456')\n print(json.dumps({'ok':True,'predictions':[{'text':text,'raw_text':text,'schema_valid':True} for x in r['items']]}),flush=True)\n").unwrap();
        let environment = HashMap::from([
            ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
            ("DISPLAY".into(), "test-display".into()),
            (
                "XDG_RUNTIME_DIR".into(),
                root.join("runtime").display().to_string(),
            ),
            (
                "XDG_DATA_HOME".into(),
                root.join("xdg").display().to_string(),
            ),
            (
                "POKER_GAMEPLAY_ROOT".into(),
                root.join("gameplay").display().to_string(),
            ),
            ("OCR_MODEL_PYTHON".into(), "/usr/bin/python3".into()),
            (
                "POKER_TEST_SCREEN".into(),
                root.join("screen.png").display().to_string(),
            ),
            (
                "POKER_TEST_BLOCK".into(),
                if block { "1" } else { "0" }.into(),
            ),
            (
                "POKER_TEST_STARTED".into(),
                root.join("started").display().to_string(),
            ),
            (
                "POKER_TEST_RELEASE".into(),
                root.join("release").display().to_string(),
            ),
            ("POKER_LAB_TOOLS_ROOT".into(), tools.display().to_string()),
        ]);
        let service = Arc::new(
            LabService::open_with_paths(root.join("data"), root.join("config"), tools, environment)
                .unwrap(),
        );
        fs::write(root.join("config/regions.json"),json!({"screen_width":8,"screen_height":8,"round_id":{"x":0,"y":0,"w":2,"h":2},"pot":{"x":2,"y":0,"w":2,"h":2},"seats":[{"nameplate":{"x":0,"y":4,"w":2,"h":2},"name":{"x":0,"y":6,"w":2,"h":2},"bet":{"x":4,"y":6,"w":2,"h":2}},{"nameplate":{"x":2,"y":4,"w":2,"h":2},"name":{"x":2,"y":6,"w":2,"h":2},"bet":{"x":4,"y":4,"w":2,"h":2}}]}).to_string()).unwrap();
        Self { temp, service }
    }
    fn req(&self, method: &str, path: &str, body: Value) -> poker_native::lab::LabResponse {
        self.service.request(LabRequest {
            method: method.into(),
            path: path.into(),
            body,
            query: BTreeMap::new(),
            headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
        })
    }
}
#[test]
fn manual_capture_uses_model_gate_inactive_bets_queue_dedup_and_no_orphans() {
    let f = Fixture::new(false);
    let response = f.req(
        "POST",
        "/api/capture",
        json!({"monitor":"TEST","queue_mode":"paged"}),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let regions = response.body["regions"].as_array().unwrap();
    assert_eq!(regions.len(), 5);
    assert!(regions.iter().any(|r| r["id"] == "seats[1].bet"));
    assert!(!regions.iter().any(|r| r["id"] == "seats[1].name"));
    assert!(!regions
        .iter()
        .any(|r| r["id"].as_str().unwrap().contains("nameplate")));
    assert!(regions
        .iter()
        .all(|r| r["label"] == "" && r["reviewed"] == false));
    assert!(regions.iter().find(|r| r["id"] == "round_id").unwrap()["prediction_id"].is_string());
    let second = f.req(
        "POST",
        "/api/capture",
        json!({"monitor":"TEST","queue_mode":"paged"}),
    );
    assert_eq!(second.status, 200, "{}", second.body);
    assert!(second.body["regions"].as_array().unwrap().is_empty());
    let ctx = f.service.registry.resolve("legacy").unwrap();
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM full_captures", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(fs::read_dir(ctx.captures()).unwrap().count(), 1);
    let foreign = f.req("GET", "/api/queue", Value::Null);
    assert_eq!(foreign.status, 200);
}
#[test]
fn watch_stop_remains_responsive_and_late_model_result_cannot_admit_capture() {
    let f = Fixture::new(true);
    let started = f.req(
        "POST",
        "/api/watch/start",
        json!({"monitor":"TEST","queue_mode":"paged","interval_seconds":1}),
    );
    assert_eq!(started.status, 200);
    let lease = started.body["lease_id"].clone();
    let service = f.service.clone();
    let tick_lease = lease.clone();
    let worker = std::thread::spawn(move || {
        service.request(LabRequest {
            method: "POST".into(),
            path: "/api/watch/tick".into(),
            body: json!({"lease_id":tick_lease}),
            query: BTreeMap::new(),
            headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
        })
    });
    let until = Instant::now() + Duration::from_secs(3);
    while !f.temp.path().join("started").exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(f.temp.path().join("started").exists());
    let clock = Instant::now();
    assert_eq!(
        f.req("POST", "/api/watch/stop", json!({"lease_id":lease}))
            .status,
        200
    );
    assert!(clock.elapsed() < Duration::from_millis(200));
    fs::write(f.temp.path().join("release"), b"go").unwrap();
    let response = worker.join().unwrap();
    assert_eq!(response.status, 409, "{}", response.body);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    assert_eq!(queue::summary(&ctx).unwrap()["total"], 0);
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM full_captures", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(fs::read_dir(ctx.captures()).unwrap().count(), 0);
}
#[test]
fn editor_draft_export_epochs_media_ranges_and_python_hash_match() {
    let f = Fixture::new(false);
    let current = f.service.capture.config().unwrap();
    let draft =
        json!({"regions":{"round_id":{"x":0,"y":0,"w":2,"h":2}},"screenWidth":8,"screenHeight":8});
    let saved = f.req("POST", "/api/editor/regions", draft.clone());
    assert_eq!(saved.status, 200);
    assert_eq!(f.service.capture.config().unwrap().hash, current.hash);
    let started = f.req(
        "POST",
        "/api/watch/start",
        json!({"monitor":"TEST","queue_mode":"paged"}),
    );
    let mut export = draft;
    export["export"] = json!(true);
    let saved = f.req("POST", "/api/editor/regions", export);
    assert_eq!(saved.status, 200, "{}", saved.body);
    assert_ne!(f.service.capture.config().unwrap().hash, current.hash);
    let stopped = f.req(
        "POST",
        "/api/watch/tick",
        json!({"lease_id":started.body["lease_id"]}),
    );
    assert_eq!(stopped.status, 409);
    let root = f.temp.path().join("data/screenshots");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("example.mp4"), b"0123456789").unwrap();
    let mut request = LabRequest {
        method: "GET".into(),
        path: "/api/editor/media/example.mp4".into(),
        body: Value::Null,
        query: BTreeMap::new(),
        headers: BTreeMap::from([("Range".into(), "bytes=2-5".into())]),
    };
    let ranged = f.service.request(request.clone());
    assert_eq!(ranged.status, 206);
    assert_eq!(ranged.headers["Content-Range"], "bytes 2-5/10");
    assert_eq!(
        STANDARD.decode(ranged.body_base64.unwrap()).unwrap(),
        b"2345"
    );
    request.headers.insert("Range".into(), "bytes=100-".into());
    assert_eq!(f.service.request(request).status, 416);
    let temp = TempDir::new().unwrap();
    let config =
        capture::CaptureService::with_environment(temp.path().join("config"), HashMap::new())
            .unwrap()
            .config()
            .unwrap();
    assert_eq!(
        capture::region_hash(&config).unwrap(),
        "65ca71aac848595ec6fe603e6ccc4ec9"
    );
    assert_eq!(
        lab::python_json(&json!(["é", "x"]), true).unwrap(),
        "[\"\\u00e9\",\"x\"]"
    );
}

#[test]
fn interrupted_stream_commit_rehydrates_its_original_run_and_receipt() {
    let (_temp, ctx) = context();
    queue::ingest_frame(&ctx, &frame(125)).unwrap();
    let started = queue::start_stream(&ctx).unwrap();
    let id = started["review_batch"]["batch_id"].as_str().unwrap();
    {
        let conn = ctx.connection().unwrap();
        conn.execute("UPDATE queue_items SET reviewed=1,label='Alice'", [])
            .unwrap();
        let mut run = queue::stream_conn(&conn, &ctx, id, true).unwrap();
        run["total_stats"] = queue::stream_stats_conn(&conn, &ctx, id).unwrap();
        run["checkpoint"] = queue::meta(&conn, "checkpoint", json!({})).unwrap();
        run["state"] = json!("committing");
        queue::put_meta(&conn, &format!("stream:{id}"), &run).unwrap();
    }
    queue::commit(
        &ctx,
        &(0..100)
            .map(|i| format!("sample-{i:04}"))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let recovered = queue::session(&ctx).unwrap();
    assert_eq!(recovered["review_batch"]["batch_id"], id);
    assert_eq!(recovered["review_batch"]["committing"], true);
    assert!(!recovered["pool"].as_array().unwrap().is_empty());
    assert_eq!(recovered["review_stats"]["total"], 125);
    let receipt = queue::commit_stream(&ctx, id).unwrap();
    assert_eq!(receipt["committed"], 125);
    assert_eq!(queue::summary(&ctx).unwrap()["total"], 0);
}
#[test]
fn failed_watch_persistence_releases_global_scan_reservation() {
    let f = Fixture::new(false);
    let started = f.req(
        "POST",
        "/api/watch/start",
        json!({"monitor":"TEST","queue_mode":"paged"}),
    );
    assert_eq!(started.status, 200);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    ctx.connection().unwrap().execute_batch("CREATE TRIGGER fail_watch_state BEFORE INSERT ON settings WHEN NEW.key='watch_state' BEGIN SELECT RAISE(ABORT,'fixture watch failure'); END;").unwrap();
    let failed = f.req(
        "POST",
        "/api/watch/tick",
        json!({"lease_id":started.body["lease_id"]}),
    );
    assert_eq!(failed.status, 500);
    ctx.connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_watch_state")
        .unwrap();
    let scan = f.service.watch.reserve_manual("legacy").unwrap();
    f.service.watch.release(&scan).unwrap();
    assert_eq!(ctx.state.lock().unwrap()["watch_runtime"]["reserved"], 0);
}

#[test]
fn stale_queue_review_cannot_follow_a_saved_filename_or_forge_identity() {
    let (_temp, ctx) = context();
    queue::ingest_frame(&ctx, &frame(1)).unwrap();
    review::review(
        &ctx,
        &input("sample-0000", "seat.0.name", 10),
        "Alice",
        "manual",
        None,
        false,
    )
    .unwrap();
    queue::refresh_review(&ctx, "sample-0000").unwrap();
    assert_eq!(
        review::sample_input(
            &ctx,
            &json!({"sample_key":"sample-0000","queue_mode":"paged","queue_id":999})
        )
        .unwrap_err()
        .status,
        409
    );
    queue::commit(&ctx, &["sample-0000".into()]).unwrap();
    let error = review::sample_input(
        &ctx,
        &json!({"sample_key":"sample-0000","queue_mode":"paged","queue_id":1}),
    )
    .unwrap_err();
    assert_eq!(error.status, 400);
    assert!(error.message.contains("Queued crop no longer exists"));
    let saved = review::sample_input(&ctx, &json!({"sample_key":"sample-0000"})).unwrap();
    assert!(saved.filename.is_some());
}
#[test]
fn malformed_labels_predictions_and_archived_contexts_fail_without_blank_writes() {
    let (temp, ctx) = context();
    let value = frame(1)["regions"][0].clone();
    let mut malformed = value.clone();
    malformed["label"] = json!(123);
    let bytes = png(10);
    assert_eq!(
        review::commit(
            &ctx,
            &[(
                malformed,
                bytes.clone(),
                media::dhash(&media::decode_image(&bytes).unwrap())
            )]
        )
        .unwrap_err()
        .status,
        400
    );
    let mut malformed = value;
    malformed["prediction_id"] = json!(123);
    assert_eq!(
        review::commit(
            &ctx,
            &[(
                malformed,
                bytes.clone(),
                media::dhash(&media::decode_image(&bytes).unwrap())
            )]
        )
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let registry = DatasetRegistry::new(temp.path().join("other")).unwrap();
    let archived = registry.resolve("legacy").unwrap();
    review::ensure(&archived).unwrap();
    registry
        .update("legacy", &json!({"archived":true}))
        .unwrap();
    assert_eq!(
        review::review(
            &archived,
            &input("late", "seat.0.name", 10),
            "Alice",
            "manual",
            None,
            false
        )
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(
        queue::discard(&archived, &[], &[], true)
            .unwrap_err()
            .status,
        409
    );
}

#[test]
fn nonpaged_immediate_capture_cache_clears_with_original_session_lifecycle() {
    let f = Fixture::new(false);
    let first = f.req("POST", "/api/capture", json!({"monitor":"TEST"}));
    assert_eq!(first.status, 200, "{}", first.body);
    assert!(!first.body["regions"].as_array().unwrap().is_empty());
    let second = f.req("POST", "/api/capture", json!({"monitor":"TEST"}));
    assert_eq!(second.status, 200);
    assert!(second.body["regions"].as_array().unwrap().is_empty());
    f.req("POST", "/api/clear_session", json!({}));
    let third = f.req("POST", "/api/capture", json!({"monitor":"TEST"}));
    assert!(!third.body["regions"].as_array().unwrap().is_empty());
}
#[test]
fn editor_preserves_negative_and_outside_rectangles_but_capture_rejects_them() {
    let f = Fixture::new(false);
    let draft = json!({"regions":{"round_id":{"x":-12,"y":-3,"w":2,"h":2},"seat.0.name":{"x":100,"y":200,"w":3,"h":3}},"screenWidth":8,"screenHeight":8,"export":true});
    let response = f.req("POST", "/api/editor/regions", draft);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["native"]["round_id"]["x"], -12);
    assert_eq!(response.body["native"]["seats"][0]["name"]["x"], 100);
    let loaded = f.req("GET", "/api/editor/regions", Value::Null);
    assert_eq!(loaded.status, 200);
    assert_eq!(loaded.body["regions"]["round_id"]["x"], -12);
    let capture = f.req("POST", "/api/capture", json!({"monitor":"TEST"}));
    assert_eq!(capture.status, 400);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM full_captures", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn nonpaged_review_does_not_initialize_or_migrate_the_disk_queue() {
    let f = Fixture::new(false);
    let result=f.req("POST","/api/review_label",json!({"sample_key":"nonpaged","id":"seat.0.name","base64_image":STANDARD.encode(png(10)),"label":"Alice","action":"manual"}));
    assert_eq!(result.status, 200, "{}", result.body);
    assert!(result.body["summary"].is_null());
    let ctx = f.service.registry.resolve("legacy").unwrap();
    assert_eq!(
        ctx.connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='queue_items'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn legacy_numeric_frame_id_keeps_source_string_identity() {
    let (_temp, ctx) = context();
    let mut frame = frame(1);
    frame["id"] = json!(123);
    queue::ingest_frame(&ctx, &frame).unwrap();
    assert_eq!(
        queue::page(&ctx, None, 1, "oldest").unwrap()["items"][0]["frame_id"],
        "123"
    );
}

#[test]
fn db_delete_preserves_active_queue_masters_and_removes_unreferenced() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    queue::session(&ctx).unwrap();
    let conn = ctx.connection().unwrap();
    for name in ["active.png", "frame.png", "unused.png"] {
        conn.execute("INSERT INTO full_captures(filename) VALUES(?)", [name])
            .unwrap();
        fs::write(ctx.captures().join(name), png(1)).unwrap();
    }
    conn.execute("INSERT INTO images(filename) VALUES('crop.png')", [])
        .unwrap();
    fs::write(ctx.images().join("crop.png"), png(2)).unwrap();
    conn.execute("INSERT INTO queue_items(sample_key,frame_id,source,region_id,payload,crop,pixel_sha256,created_at) VALUES('a','frame.png','active.png','r','{\"source\":\"active.png\",\"frame_id\":\"frame.png\"}',x'00','x',0)", []).unwrap();
    drop(conn);
    let response = f.req("POST", "/api/db_delete", json!({"filenames":["crop.png"]}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(ctx.captures().join("active.png").exists());
    assert!(ctx.captures().join("frame.png").exists());
    assert!(!ctx.captures().join("unused.png").exists());
    let conn = ctx.connection().unwrap();
    conn.execute("UPDATE queue_items SET payload='broken'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO full_captures(filename) VALUES('unknown.png')",
        [],
    )
    .unwrap();
    fs::write(ctx.captures().join("unknown.png"), png(3)).unwrap();
    drop(conn);
    assert_eq!(
        f.req("POST", "/api/db_delete", json!({"filenames":[]}))
            .status,
        200
    );
    assert!(ctx.captures().join("unknown.png").exists());
}

#[test]
fn fresh_private_config_uses_embedded_defaults_and_preserves_existing() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let env = HashMap::from([(
        "POKER_LAB_TOOLS_ROOT".into(),
        temp.path().join("absent").display().to_string(),
    )]);
    let service =
        capture::CaptureService::with_paths(config.clone(), temp.path().join("data"), env.clone())
            .unwrap();
    let defaults = service.config().unwrap();
    assert!(defaults.regions.is_object());
    assert!(defaults.colors.is_object());
    assert!(!defaults.order.is_empty());
    let original = b"{\"custom\":true}";
    fs::write(config.join("regions.json"), original).unwrap();
    capture::CaptureService::with_paths(config.clone(), temp.path().join("data"), env).unwrap();
    assert_eq!(fs::read(config.join("regions.json")).unwrap(), original);
    LabService::open_with_paths(
        temp.path().join("lab-data"),
        temp.path().join("fresh-config"),
        temp.path().join("absent"),
        HashMap::new(),
    )
    .unwrap();
}

#[test]
fn shared_list_pages_are_bounded_and_scope_cursors() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    queue::ingest_frame(&ctx, &frame(125)).unwrap();
    {
        let conn = ctx.connection().unwrap();
        for i in 0..125 {
            conn.execute("INSERT INTO images(filename,label,region_id,timestamp) VALUES (?1,?2,'seat.0.name',?3)", rusqlite::params![format!("file-{i:03}.png"), if i % 2 == 0 { "match" } else { "" }, i]).unwrap();
        }
    }
    let run = queue::start_stream(&ctx).unwrap()["review_batch"]["batch_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let make = |path: &str, query: BTreeMap<String, String>, dataset: &str| LabRequest {
        method: "GET".into(),
        path: path.into(),
        body: Value::Null,
        query,
        headers: BTreeMap::from([("X-Dataset-ID".into(), dataset.into())]),
    };
    for (path, query, expected) in [
        ("/api/queue", BTreeMap::new(), 125),
        (
            "/api/queue/review/items",
            BTreeMap::from([
                ("run_id".into(), run.clone()),
                ("filter".into(), "pending".into()),
            ]),
            125,
        ),
        (
            "/api/db_entries",
            BTreeMap::from([("search".into(), "match".into())]),
            63,
        ),
    ] {
        let req = make(path, query.clone(), "legacy");
        let mut cursor = None;
        let mut ids = std::collections::BTreeSet::new();
        let mut pages = 0;
        loop {
            let result = f
                .service
                .list_page(req.clone(), cursor.clone(), Some(20))
                .unwrap();
            let items = result.body["items"].as_array().unwrap();
            assert!(items.len() <= 20);
            assert_eq!(result.body["total"], expected);
            for item in items {
                assert!(ids.insert(
                    item[if path == "/api/db_entries" {
                        "filename"
                    } else {
                        "sample_key"
                    }]
                    .as_str()
                    .unwrap()
                    .to_owned()
                ));
            }
            pages += 1;
            cursor = result.body["nextCursor"].as_str().map(str::to_owned);
            if pages == 1 {
                let mut changed = req.clone();
                changed.query.insert("search".into(), "different".into());
                assert!(f
                    .service
                    .list_page(changed, cursor.clone(), Some(20))
                    .is_err());
                let other = make(path, query.clone(), "other");
                assert!(f
                    .service
                    .list_page(other, cursor.clone(), Some(20))
                    .is_err());
            }
            if cursor.is_none() {
                break;
            }
        }
        assert!(pages > 2);
        assert_eq!(ids.len(), expected as usize);
    }
    let req = make("/api/db_entries", BTreeMap::new(), "legacy");
    let all = f.service.list_page(req.clone(), None, Some(500)).unwrap();
    let rows = all.body["items"].as_array().unwrap();
    assert_eq!(rows.len(), 125);
    assert!(rows[..63].iter().all(|row| row["label"] == "match"));
    assert!(rows[63..].iter().all(|row| row["label"] == ""));
    let keys = f
        .service
        .list_page(
            make(
                "/api/db_entries",
                BTreeMap::from([("keys_only".into(), "1".into())]),
                "legacy",
            ),
            None,
            Some(10),
        )
        .unwrap();
    assert!(keys.body["items"][0].get("label").is_none());
    let capped = f
        .service
        .list_page(
            make("/api/queue", BTreeMap::new(), "legacy"),
            None,
            Some(500),
        )
        .unwrap();
    assert_eq!(capped.body["items"].as_array().unwrap().len(), 100);
    assert_eq!(capped.body["hasMore"], true);
    assert_eq!(
        f.service
            .list_page(req.clone(), None, Some(1))
            .unwrap()
            .body["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(f.service.list_page(req.clone(), None, Some(501)).is_err());
    assert!(f
        .service
        .list_page(
            make("/api/initial_data", BTreeMap::new(), "legacy"),
            None,
            None
        )
        .is_err());
}

#[test]
fn gameplay_list_snapshot_excludes_new_frames_and_scopes_cursors() {
    let f = Fixture::new(false);
    assert_eq!(f.req("GET", "/api/gameplay", Value::Null).status, 200);
    let conn = rusqlite::Connection::open(f.temp.path().join("gameplay/gameplay.sqlite3")).unwrap();
    for i in 0..205 {
        conn.execute("INSERT INTO sessions(id,name,source,interval_ms,status,created_at,config_hash,config_json,archived) VALUES (?1,'test','monitor',1000,'ready',?2,'hash','{}',0)",rusqlite::params![format!("session{i:03}"),format!("{i:04}")]).unwrap();
    }
    for i in 0..65 {
        conn.execute("INSERT INTO frames(id,session_id,captured_at,hand_id,ocr_status,width,height,image_sha256,results_json,config_hash,config_json) VALUES (?1,'session000',?2,?3,'complete',1,1,'hash','{}','hash','{}')",rusqlite::params![format!("frame{i:03}"),format!("{i:04}"),format!("hand{i:03}")]).unwrap();
    }
    let request = |path: &str, query: BTreeMap<String, String>| LabRequest {
        method: "GET".into(),
        path: path.into(),
        body: Value::Null,
        query,
        headers: BTreeMap::new(),
    };
    let sessions = request("/api/gameplay", BTreeMap::new());
    let mut c = None;
    let mut count = 0;
    let mut pages = 0;
    loop {
        let p = f.service.list_page(sessions.clone(), c, Some(70)).unwrap();
        count += p.body["items"].as_array().unwrap().len();
        pages += 1;
        c = p.body["nextCursor"].as_str().map(str::to_owned);
        if c.is_none() {
            break;
        }
    }
    assert_eq!(count, 205);
    assert!(pages > 2);
    let first = f
        .service
        .list_page(sessions.clone(), None, Some(2))
        .unwrap();
    conn.execute(
        "UPDATE sessions SET name='renamed' WHERE id='session000'",
        [],
    )
    .unwrap();
    assert_eq!(
        f.service
            .list_page(
                sessions.clone(),
                first.body["nextCursor"].as_str().map(str::to_owned),
                Some(2)
            )
            .unwrap()
            .status,
        409
    );
    for path in [
        "/api/gameplay/sessions/session000",
        "/api/gameplay/sessions/session000/frames",
    ] {
        let query = if path.ends_with("frames") {
            BTreeMap::from([("order".into(), "desc".into())])
        } else {
            BTreeMap::new()
        };
        let req = request(path, query);
        let first = f.service.list_page(req.clone(), None, Some(20)).unwrap();
        assert_eq!(first.body["meta"]["session"]["id"], "session000");
        let mut cursor = first.body["nextCursor"].as_str().map(str::to_owned);
        let mut ids: std::collections::BTreeSet<String> = first.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v[if path.ends_with("frames") {
                    "id"
                } else {
                    "hand_id"
                }]
                .as_str()
                .unwrap()
                .to_owned()
            })
            .collect();
        let mut wrong = req.clone();
        wrong.path = wrong.path.replace("session000", "session001");
        assert!(f
            .service
            .list_page(wrong, cursor.clone(), Some(20))
            .is_err());
        if path.ends_with("frames") {
            let mut wrong = req.clone();
            wrong.query.insert("order".into(), "asc".into());
            assert!(f
                .service
                .list_page(wrong, cursor.clone(), Some(20))
                .is_err());
            let mut wrong = req.clone();
            wrong.query.insert("hand_id".into(), "hand001".into());
            assert!(f
                .service
                .list_page(wrong, cursor.clone(), Some(20))
                .is_err());
        }
        conn.execute("INSERT INTO frames(id,session_id,captured_at,hand_id,ocr_status,width,height,image_sha256,results_json,config_hash,config_json) VALUES (?1,'session000','9999',?1,'complete',1,1,'hash','{}','hash','{}')",[if path.ends_with("frames") {"newframe"} else {"newhand"}]).unwrap();
        let expected = if path.ends_with("frames") { 66 } else { 65 };
        while let Some(c) = cursor {
            let p = f.service.list_page(req.clone(), Some(c), Some(20)).unwrap();
            for v in p.body["items"].as_array().unwrap() {
                assert!(ids.insert(
                    v[if path.ends_with("frames") {
                        "id"
                    } else {
                        "hand_id"
                    }]
                    .as_str()
                    .unwrap()
                    .to_owned()
                ));
            }
            cursor = p.body["nextCursor"].as_str().map(str::to_owned);
        }
        assert_eq!(ids.len(), expected);
        assert!(!ids.contains(if path.ends_with("frames") {
            "newframe"
        } else {
            "newhand"
        }));
        assert_eq!(
            f.service.list_page(req, None, Some(500)).unwrap().body["items"]
                .as_array()
                .unwrap()
                .len(),
            expected + 1
        );
    }
    let req = request("/api/gameplay/sessions/session000/frames", BTreeMap::new());
    let first = f.service.list_page(req.clone(), None, Some(1)).unwrap();
    conn.execute("DELETE FROM frames WHERE id='newframe'", [])
        .unwrap();
    assert_eq!(
        f.service
            .list_page(
                req,
                first.body["nextCursor"].as_str().map(str::to_owned),
                Some(1)
            )
            .unwrap()
            .status,
        409
    );
    conn.execute("UPDATE sessions SET archived=1 WHERE id='session001'", [])
        .unwrap();
    let archived = request(
        "/api/gameplay",
        BTreeMap::from([("archived".into(), "1".into())]),
    );
    assert_eq!(
        f.service.list_page(archived, None, Some(10)).unwrap().body["items"][0]["id"],
        "session001"
    );
}

#[test]
fn paged_database_and_names_match_unicode_case_insensitively() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    {
        let conn = ctx.connection().unwrap();
        for (filename, label) in [("accent.png", "ÉLISE"), ("greek.png", "ΑΘΉΝΑ")] {
            conn.execute("INSERT INTO images(filename,label,region_id,timestamp) VALUES (?1,?2,'seat.0.name',0)", rusqlite::params![filename, label]).unwrap();
        }
    }
    for path in ["/api/db_entries", "/api/name_suggestions"] {
        for (search, expected) in [("él", "ÉLISE"), ("αθή", "ΑΘΉΝΑ")] {
            let request = LabRequest {
                method: "GET".into(),
                path: path.into(),
                body: Value::Null,
                query: BTreeMap::from([("search".into(), search.into())]),
                headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
            };
            let page = f.service.list_page(request, None, Some(10)).unwrap();
            assert_eq!(page.body["total"], 1);
            assert_eq!(
                page.body["items"][0][if path == "/api/db_entries" {
                    "label"
                } else {
                    "name"
                }],
                expected
            );
        }
    }
}

#[test]
fn filename_history_rejects_mapping_changes_between_pages() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    review::ensure(&ctx).unwrap();
    {
        let conn = ctx.connection().unwrap();
        conn.execute("INSERT INTO review_samples(sample_key,region_id,pixel_sha256,image_sha256,filename,crop) VALUES ('a','name','hash','hash','shared.png',x'00'),('b','name','hash','hash',NULL,x'00')", []).unwrap();
        for (sample, time) in [("a", 20), ("a", 30), ("b", 40)] {
            conn.execute("INSERT INTO label_review_events(sample_key,prior_label,label,action,pixel_sha256,dataset_id,created_at) VALUES (?1,'','label','manual','hash','legacy',?2)", rusqlite::params![sample, time]).unwrap();
        }
    }
    let request = LabRequest {
        method: "GET".into(),
        path: "/api/label_history".into(),
        body: Value::Null,
        query: BTreeMap::from([("filename".into(), "shared.png".into())]),
        headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
    };
    let first = f.service.list_page(request.clone(), None, Some(1)).unwrap();
    assert_eq!(first.body["items"][0]["payload"]["created_at"], 30);
    let external = rusqlite::Connection::open(ctx.directory.join("data.db")).unwrap();
    external
        .execute(
            "UPDATE review_samples SET filename='shared.png' WHERE sample_key='b'",
            [],
        )
        .unwrap();
    assert_eq!(
        f.service
            .list_page(
                request.clone(),
                first.body["nextCursor"].as_str().map(str::to_owned),
                Some(1)
            )
            .unwrap()
            .status,
        409
    );
    let refreshed = f.service.list_page(request, None, Some(10)).unwrap();
    assert_eq!(refreshed.body["total"], 3);
    assert_eq!(refreshed.body["items"][0]["payload"]["created_at"], 40);
}

#[test]
fn paged_gameplay_hands_preserve_unidentified_groups() {
    let f = Fixture::new(false);
    assert_eq!(f.req("GET", "/api/gameplay", Value::Null).status, 200);
    let conn = rusqlite::Connection::open(f.temp.path().join("gameplay/gameplay.sqlite3")).unwrap();
    conn.execute("INSERT INTO sessions(id,name,source,interval_ms,status,created_at,config_hash,config_json,archived) VALUES ('legacy-hands','test','monitor',1000,'ready','0','hash','{}',0)", []).unwrap();
    for (i, hand) in [None, Some(""), Some("known"), None]
        .into_iter()
        .enumerate()
    {
        conn.execute("INSERT INTO frames(id,session_id,captured_at,hand_id,ocr_status,width,height,image_sha256,results_json,config_hash,config_json) VALUES (?1,'legacy-hands',?2,?3,'complete',1,1,'hash','{}','hash','{}')", rusqlite::params![format!("frame{i}"), format!("{i:04}"), hand]).unwrap();
    }
    let request = LabRequest {
        method: "GET".into(),
        path: "/api/gameplay/sessions/legacy-hands".into(),
        body: Value::Null,
        query: BTreeMap::new(),
        headers: BTreeMap::new(),
    };
    let mut cursor = None;
    let mut groups = BTreeMap::new();
    loop {
        let page = f
            .service
            .list_page(request.clone(), cursor, Some(1))
            .unwrap();
        assert_eq!(page.body["total"], 3);
        for item in page.body["items"].as_array().unwrap() {
            assert!(groups
                .insert(
                    item["hand_id"].to_string(),
                    item["frame_count"].as_i64().unwrap()
                )
                .is_none());
        }
        cursor = page.body["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        groups,
        BTreeMap::from([
            ("null".into(), 2),
            ("\"\"".into(), 1),
            ("\"known\"".into(), 1)
        ])
    );
    let legacy = f.req("GET", "/api/gameplay/sessions/legacy-hands", Value::Null);
    assert_eq!(legacy.body["hands"].as_array().unwrap().len(), groups.len());
}

#[test]
fn database_paging_rejects_external_mutations() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    {
        let conn = ctx.connection().unwrap();
        for i in 0..3 {
            conn.execute("INSERT INTO images(filename,label,region_id,timestamp) VALUES (?1,'label','seat',?2)",rusqlite::params![format!("{i}.png"),i]).unwrap();
        }
    }
    let req = LabRequest {
        method: "GET".into(),
        path: "/api/db_entries".into(),
        body: Value::Null,
        query: BTreeMap::new(),
        headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
    };
    let first = f.service.list_page(req.clone(), None, Some(1)).unwrap();
    let cursor = first.body["nextCursor"].as_str().unwrap().to_owned();
    let external = rusqlite::Connection::open(ctx.directory.join("data.db")).unwrap();
    external
        .execute(
            "UPDATE images SET label='changed' WHERE filename='0.png'",
            [],
        )
        .unwrap();
    assert_eq!(
        f.service
            .list_page(req, Some(cursor), Some(1))
            .unwrap()
            .status,
        409
    );
}

#[test]
fn shared_catalog_and_history_pages_cover_scopes_and_mutations() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    review::ensure(&ctx).unwrap();
    f.service.ai_review.ensure(&ctx).unwrap();
    {
        let conn = ctx.connection().unwrap();
        conn.execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','legacy','run','done','test',1,0,0,0)",[]).unwrap();
        for i in 0..7 {
            conn.execute("INSERT INTO images(filename,label,region_id,timestamp) VALUES (?1,?2,'seat.0.name',?3)",rusqlite::params![format!("name{i}.png"),format!("player{i}"),i]).unwrap();
            conn.execute(
                "INSERT INTO session_history(timestamp,data) VALUES (?1,?2)",
                rusqlite::params![i, json!({"n":i}).to_string()],
            )
            .unwrap();
            conn.execute("INSERT INTO model_predictions(id,sample_key,region_id,pixel_sha256,dataset_id,created_at,payload) VALUES (?1,'sample','seat.0.name','hash','legacy',?2,'{\"text\":\"test\"}')",rusqlite::params![format!("pred{i}"),i*2]).unwrap();
            conn.execute("INSERT INTO label_review_events(sample_key,filename,prior_label,label,action,pixel_sha256,dataset_id,created_at) VALUES ('sample','name0.png','','test','manual','hash','legacy',?1)",[i*2+1]).unwrap();
            conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?1,0,?1,?2,'name','name','','hash',0,'unchanged',?3)",rusqlite::params![i,format!("key{i}"),json!({"n":i}).to_string()]).unwrap();
        }
        conn.execute("INSERT INTO review_samples(sample_key,region_id,pixel_sha256,image_sha256,filename,crop) VALUES ('sample','name','hash','hash','name0.png',x'00')",[]).unwrap();
    }
    for i in 0..5 {
        f.service.registry.create(&format!("dataset{i}")).unwrap();
    }
    let req = |path: &str, query: BTreeMap<String, String>| LabRequest {
        method: "GET".into(),
        path: path.into(),
        body: Value::Null,
        query,
        headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
    };
    for (path, query, expected) in [
        ("/api/datasets", BTreeMap::new(), 6),
        ("/api/get_session_history", BTreeMap::new(), 7),
        ("/api/name_suggestions", BTreeMap::new(), 7),
        (
            "/api/label_history",
            BTreeMap::from([("sample_key".into(), "sample".into())]),
            14,
        ),
        (
            "/api/ai-review/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/results",
            BTreeMap::new(),
            7,
        ),
    ] {
        let request = req(path, query);
        let mut cursor = None;
        let mut count = 0;
        let mut pages = 0;
        loop {
            let response = f
                .service
                .list_page(request.clone(), cursor.clone(), Some(2))
                .unwrap();
            let items = response.body["items"].as_array().unwrap();
            assert!(items.len() <= 2);
            assert_eq!(response.body["total"], expected);
            if path == "/api/label_history" {
                assert!(items.iter().all(|item| ["event", "prediction"]
                    .contains(&item["kind"].as_str().unwrap())
                    && item["payload"].is_object()));
            }
            if path == "/api/datasets" {
                assert_eq!(response.body["meta"]["default_dataset_id"], "legacy");
            }
            count += items.len();
            pages += 1;
            cursor = response.body["nextCursor"].as_str().map(str::to_owned);
            if pages == 1 {
                let mut wrong = request.clone();
                wrong.path = if path == "/api/get_session_history" {
                    "/api/name_suggestions"
                } else {
                    "/api/get_session_history"
                }
                .into();
                wrong.query.clear();
                assert!(f.service.list_page(wrong, cursor.clone(), Some(2)).is_err());
            }
            if cursor.is_none() {
                break;
            }
        }
        assert!(pages > 2);
        assert_eq!(count, expected as usize);
        assert!(f.service.list_page(request.clone(), None, Some(0)).is_err());
        assert!(f.service.list_page(request, None, Some(501)).is_err());
    }
    let request = req(
        "/api/label_history",
        BTreeMap::from([("filename".into(), "name0.png".into())]),
    );
    let first = f.service.list_page(request.clone(), None, Some(2)).unwrap();
    assert_eq!(first.body["total"], 14);
    let mut changed = request;
    changed.query.insert("filename".into(), "name1.png".into());
    assert!(f
        .service
        .list_page(
            changed,
            first.body["nextCursor"].as_str().map(str::to_owned),
            Some(2)
        )
        .is_err());
    let request = req(
        "/api/name_suggestions",
        BTreeMap::from([("search".into(), "player1".into())]),
    );
    assert_eq!(
        f.service.list_page(request, None, Some(5)).unwrap().body["items"][0]["name"],
        "player1"
    );
    let request = req("/api/datasets", BTreeMap::new());
    let first = f.service.list_page(request.clone(), None, Some(2)).unwrap();
    let created = f.service.registry.create("changed").unwrap();
    assert_eq!(
        f.service
            .list_page(
                request.clone(),
                first.body["nextCursor"].as_str().map(str::to_owned),
                Some(2)
            )
            .unwrap()
            .status,
        409
    );
    let first = f.service.list_page(request.clone(), None, Some(2)).unwrap();
    f.service
        .registry
        .update(created["id"].as_str().unwrap(), &json!({"archived":true}))
        .unwrap();
    assert_eq!(
        f.service
            .list_page(
                request.clone(),
                first.body["nextCursor"].as_str().map(str::to_owned),
                Some(2)
            )
            .unwrap()
            .status,
        409
    );
    assert_eq!(
        f.service.list_page(request, None, Some(500)).unwrap().body["total"],
        6
    );
    let all = req(
        "/api/datasets",
        BTreeMap::from([("include_archived".into(), "1".into())]),
    );
    assert_eq!(
        f.service.list_page(all, None, Some(500)).unwrap().body["total"],
        7
    );
}

#[test]
fn score_history_finds_older_high_scores_and_deduplicates() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    {
        let mut conn = ctx.connection().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO session_history(timestamp,data) VALUES (0,?1)",
            [json!({"items":10,"rpm":20,"score":99999,"marker":"older"}).to_string()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO session_history(timestamp,data) VALUES (1,?1)",
            [json!({"items":10,"rpm":20,"score":99999,"marker":"newer"}).to_string()],
        )
        .unwrap();
        for i in 0..2100 {
            tx.execute(
                "INSERT INTO session_history(timestamp,data) VALUES (?1,?2)",
                rusqlite::params![i + 2, json!({"items":i,"rpm":30,"score":i+1}).to_string()],
            )
            .unwrap();
        }
        tx.execute(
            "INSERT INTO session_history(timestamp,data) VALUES (9999,?1)",
            [json!({"items":1,"rpm":1,"score":0}).to_string()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let req = LabRequest {
        method: "GET".into(),
        path: "/api/get_session_history".into(),
        body: Value::Null,
        query: BTreeMap::from([("order".into(), "score".into())]),
        headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
    };
    let first = f.service.list_page(req.clone(), None, Some(2)).unwrap();
    assert_eq!(first.body["total"], 2101);
    assert_eq!(first.body["items"][0]["marker"], "newer");
    assert_eq!(first.body["items"][1]["score"], 2100);
    let cursor = first.body["nextCursor"].as_str().unwrap().to_owned();
    {
        let conn = ctx.connection().unwrap();
        conn.execute(
            "INSERT INTO session_history(timestamp,data) VALUES (10000,?1)",
            [json!({"items":100,"rpm":100,"score":999999}).to_string()],
        )
        .unwrap();
    }
    let second = f
        .service
        .list_page(req.clone(), Some(cursor.clone()), Some(2))
        .unwrap();
    assert_eq!(second.body["items"][0]["score"], 2099);
    assert_eq!(second.body["total"], 2101);
    let mut recent = req;
    recent.query.clear();
    assert!(f.service.list_page(recent, Some(cursor), Some(2)).is_err());
}

#[test]
fn score_history_uses_javascript_string_signatures_for_mixed_types() {
    let f = Fixture::new(false);
    let ctx = f.service.registry.resolve("legacy").unwrap();
    let records = [
        json!({"items":1,"rpm":2.5,"score":10,"tag":"numeric"}),
        json!({"items":"1","rpm":"2.5","score":"10","tag":"string"}),
        json!({"items":1.0,"rpm":2.5,"score":10.0,"tag":"float"}),
        json!({"rpm":3,"score":9,"tag":"missing"}),
        json!({"items":"undefined","rpm":3,"score":9,"tag":"undefined-string"}),
        json!({"items":null,"rpm":3,"score":9,"tag":"null"}),
        json!({"items":"null","rpm":3,"score":9,"tag":"null-string"}),
        json!({"items":1e-7,"rpm":2,"score":8,"tag":"small"}),
        json!({"items":"1e-7","rpm":2,"score":8,"tag":"small-string"}),
        json!({"items":1e21,"rpm":2,"score":7,"tag":"large"}),
        json!({"items":"1e+21","rpm":2,"score":7,"tag":"large-string"}),
        json!({"items":1,"rpm":2,"score":"9invalid","tag":"invalid"}),
    ];
    {
        let conn = ctx.connection().unwrap();
        for (i, record) in records.iter().enumerate() {
            conn.execute(
                "INSERT INTO session_history(timestamp,data) VALUES (?1,?2)",
                rusqlite::params![i as i64, record.to_string()],
            )
            .unwrap();
        }
    }
    let req = LabRequest {
        method: "GET".into(),
        path: "/api/get_session_history".into(),
        body: Value::Null,
        query: BTreeMap::from([("order".into(), "score".into())]),
        headers: BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
    };
    let result = f.service.list_page(req, None, Some(20)).unwrap();
    assert_eq!(result.body["total"], 5);
    let tags: Vec<_> = result.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["tag"].as_str().unwrap())
        .collect();
    assert_eq!(
        tags,
        vec![
            "float",
            "null-string",
            "undefined-string",
            "small-string",
            "large-string"
        ]
    );
}
