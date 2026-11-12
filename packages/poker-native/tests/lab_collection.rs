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
