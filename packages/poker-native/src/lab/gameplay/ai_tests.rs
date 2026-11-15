use super::*;
use crate::lab::ai_review::AiReviewManager;
use image::{DynamicImage, Rgb, RgbImage};
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture() -> (tempfile::TempDir, LabService) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let config = dir.path().join("config");
    fs::create_dir_all(&config).unwrap();
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
    let service =
        LabService::open_with_paths(root, config.clone(), tools, Default::default()).unwrap();
    fs::write(config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"board.0.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"},"category":"card","bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
    (dir, service)
}
fn recording(service: &LabService) -> String {
    let store = service.gameplay.evidence_store().unwrap();
    let config = json!({"regions":{}});
    let session = store
        .create("fixture", 1000, "Fixture", &config, "fixture")
        .unwrap();
    let id = session["id"].as_str().unwrap().to_string();
    let mut image = RgbImage::from_pixel(20, 20, Rgb([20, 20, 20]));
    image.put_pixel(5, 5, Rgb([255, 255, 255]));
    let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
    for _ in 0..3 {
        store.admit(&id,&png,20,20,"2026-11-14T00:00:00Z",&config,"fixture",&json!({"community_cards[0]":{"prediction":{"text":"K"},"rect":{"x":2,"y":2,"w":6,"h":6}}}),"12345678",&json!({})).unwrap();
    }
    id
}
#[test]
fn gameplay_uses_existing_two_read_correction_and_global_exact_reuse() {
    let (_dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"id":"fixture-response","model":"fixture","output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"fixture"}]}).to_string(),"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture-key","model":"fixture"}))
        .unwrap();
    let first = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &first).unwrap();
    assert_eq!(prepared["scope"]["occurrences"], 3);
    assert_eq!(prepared["scope"]["unique_crops"], 1);
    assert_eq!(prepared["scope"]["png_encodes"], 1);
    let started=service.gameplay_ai.start(&service,&json!({"session_id":first,"run_id":prepared["run_id"],"auto_correct":true,"max_requests":2})).unwrap();
    let job = started["job"]["id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    let status = service.gameplay_ai.status(&service, &first).unwrap();
    assert_eq!(status["state"], "completed");
    assert_eq!(status["counts"]["corrected"], 3);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(status["error"].is_string());
    assert_eq!(status["auto_correct"], true);
    if let Ok(path) = std::env::var("POKER_AI_FIXTURE_RECEIPT") {
        let frame_id = service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT frame_id FROM gameplay_ai_occurrences WHERE session_id=? LIMIT 1",
                [&first],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        let response = service.request(LabRequest {
            method: "GET".into(),
            path: format!("/api/gameplay/frames/{frame_id}"),
            body: Value::Null,
            query: Default::default(),
            headers: Default::default(),
        });
        fs::write(
            format!("{path}.ai-frame.json"),
            response.body["frame"].to_string(),
        )
        .unwrap();
    }
    let second = recording(&service);
    let cached = service.gameplay_ai.prepare(&service, &second).unwrap();
    assert_eq!(cached["scope"]["exact_cache_hits"], 3);
    let complete = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":second,"run_id":cached["run_id"],"auto_correct":false}),
        )
        .unwrap();
    assert_eq!(complete["job"]["state"], "completed");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, cached["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    drop(conn);
    let review=service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"label":"Q","action":"manual"})).unwrap();
    assert_eq!(review["affected_count"], 6);
    assert_eq!(review["item"]["label"], "Q");
    assert_eq!(review["item"]["state"], "manual");
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM label_review_events WHERE action='manual'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(conn);
    assert!(service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":item["id"],"expected_revision":0,"label":"J","action":"manual"})
        )
        .is_err());
    if let Ok(path) = std::env::var("POKER_AI_FIXTURE_RECEIPT") {
        let route = |path: &str, query: std::collections::BTreeMap<String, String>| {
            service.request(LabRequest {
                method: "GET".into(),
                path: path.into(),
                body: Value::Null,
                query,
                headers: Default::default(),
            })
        };
        let status = route(
            "/api/gameplay/ai/status",
            std::collections::BTreeMap::from([("session_id".into(), second.clone())]),
        );
        let collections = route("/api/gameplay/collections", Default::default());
        let frame = route(
            &format!(
                "/api/gameplay/frames/{}",
                item["frame_id"].as_str().unwrap()
            ),
            Default::default(),
        );
        let items = route(
            "/api/gameplay/ai/items",
            std::collections::BTreeMap::from([("session_id".into(), second)]),
        );
        assert_eq!(status.status, 200);
        assert_eq!(frame.status, 200);
        assert_eq!(items.status, 200);
        fs::write(path,json!({"status":status.body,"prepare":cached,"collections":collections.body,"frame":frame.body["frame"],"items":items.body,"review":review}).to_string()).unwrap();
    }
}
#[test]
fn unknown_provider_outcome_is_not_retried_on_resume() {
    let (_dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Err(bad(
                "OpenAI could not be reached or returned invalid JSON. Resume to retry.",
            ))
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let started = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":prepared["run_id"]}),
        )
        .unwrap();
    let id = started["job"]["id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, id);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    service
        .ai_review
        .resume(&service.gameplay_ai.context, id)
        .unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, id);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        service.gameplay_ai.status(&service, &session).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("unknown outcome")
    );
    let repeated = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(repeated["run_id"], prepared["run_id"]);
    assert!(service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":repeated["run_id"]})
        )
        .is_err());
    let other_session = recording(&service);
    let prepared_again = service
        .gameplay_ai
        .prepare(&service, &other_session)
        .unwrap();
    let started_again = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":other_session,"run_id":prepared_again["run_id"],"batch_size":1}),
        )
        .unwrap();
    let another = started_again["job"]["id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, another);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let key: String = service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .query_row(
            "SELECT sample_key FROM gameplay_ai_occurrences LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let diagnostic=service.ai_review.start(&service.gameplay_ai.context,&json!({"run_id":prepared_again["run_id"],"batch_size":1,"auto_correct":false,"repair_sample_keys":[key]})).unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        diagnostic["id"].as_str().unwrap(),
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "A changed evidence policy must never bypass an unknown provider charge"
    );
}
#[test]
fn archived_benchmark_reads_do_not_modify_source_database_or_assets() {
    let (_dir, service) = fixture();
    let ctx = service.registry.resolve("legacy").unwrap();
    let png = crate::media::png(&DynamicImage::new_rgb8(3, 3)).unwrap();
    fs::write(ctx.images().join("fixture.png"), &png).unwrap();
    ctx.connection().unwrap().execute("INSERT INTO images(filename,phash,label,region_id,timestamp) VALUES('fixture.png','hash','A','community_cards[0]',1)",[]).unwrap();
    fn inventory(root: &Path) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        fn walk(base: &Path, path: &Path, out: &mut std::collections::BTreeMap<String, String>) {
            for entry in fs::read_dir(path).unwrap() {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    walk(base, &p, out);
                } else {
                    out.insert(
                        p.strip_prefix(base).unwrap().to_string_lossy().into_owned(),
                        sha256(&fs::read(p).unwrap()),
                    );
                }
            }
        }
        walk(root, root, &mut out);
        out
    }
    let source = ctx.directory.clone();
    let before = inventory(&source);
    let request = |method: &str, path: &str| {
        service.request(LabRequest {
            method: method.into(),
            path: path.into(),
            body: json!({}),
            query: Default::default(),
            headers: std::collections::BTreeMap::from([("X-Dataset-ID".into(), "legacy".into())]),
        })
    };
    assert_eq!(request("GET", "/api/db_entries").status, 200);
    assert_eq!(
        request("GET", "/api/db_image/fixture.png").body_base64,
        Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &png
        ))
    );
    assert_eq!(request("POST", "/api/review_label").status, 409);
    assert_eq!(request("DELETE", "/api/datasets/legacy").status, 409);
    assert_eq!(before, inventory(&source));
}

#[test]
fn canonical_predictions_win_and_do_not_collide_with_themselves() {
    for (canonical, legacy) in [
        ("board.0.rank", "community_cards[0]"),
        ("seat.0.name", "seats[6].name"),
        ("game.id", "round_id"),
    ] {
        let results =
            json!({canonical:{"prediction":{"text":"new"},"rect":{"x":2,"y":2,"w":6,"h":6}}});
        assert_eq!(legacy_prediction(&results, canonical)["text"], "new");
        assert_eq!(prediction_key(&results, canonical), canonical);
        let old = json!({legacy:{"prediction":{"text":"old"},"rect":{"x":2,"y":2,"w":6,"h":6}}});
        assert_eq!(legacy_prediction(&old, canonical)["text"], "old");
        assert_eq!(prediction_key(&old, canonical), legacy);
    }
}
#[test]
fn occurrence_admission_precedes_shared_human_and_ai_truth() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    let id = items[0]["id"].as_str().unwrap();
    let key = items[0]["sample_key"].as_str().unwrap();
    conn.execute(
        "UPDATE gameplay_ai_occurrences SET state='ambiguous',reason='neighbor' WHERE id=?",
        [id],
    )
    .unwrap();
    conn.execute("INSERT INTO gameplay_ai_runs(run_id,session_id,profile_id,scope,job_id,created_at) SELECT 'fixture-run',session_id,profile_id,scope,'fixture',0 FROM gameplay_ai_runs WHERE run_id=?",[prep["run_id"].as_str().unwrap()]).unwrap();
    let pixels: String = conn
        .query_row(
            "SELECT pixel_sha256 FROM queue_items WHERE sample_key=?",
            [key],
            |r| r.get(0),
        )
        .unwrap();
    let result = json!({"label":"A","pixel_sha256":pixels,"first_reading":{"text":"A","clarity":"clear"},"verification":{"text":"A","clarity":"clear"}});
    conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) VALUES('fixture',0,0,1,?,'board.0.rank','card','K',?,0,'corrected',?)",params![key,pixels,result.to_string()]).unwrap();
    let ai_rows = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(ai_rows[0]["state"], "ambiguous");
    assert_eq!(ai_rows[1]["state"], "corrected");
    conn.execute(
        "INSERT INTO gameplay_ai_manual(sample_key,label,state) VALUES(?,'A','manual')",
        [key],
    )
    .unwrap();
    let rows = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(rows[0]["state"], "ambiguous");
    assert_eq!(rows[0]["label"], "K");
    assert_eq!(rows[1]["state"], "manual");
    drop(conn);
    let mut frame = json!({"id":items[0]["frame_id"],"width":20,"height":20,"results":{}});
    service.gameplay_ai.enrich_frame(&mut frame).unwrap();
    assert!(frame["effective_results"]["board.0.rank"]["prediction"].is_null());
    let cached = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(cached["run_id"], prep["run_id"]);
    let manual = service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":id,"expected_revision":0,"action":"manual","label":"Q"}),
        )
        .unwrap();
    assert_eq!(manual["item"]["state"], "manual");
    service.gameplay_ai.enrich_frame(&mut frame).unwrap();
    assert_eq!(
        frame["effective_results"]["board.0.rank"]["prediction"]["text"],
        "Q"
    );
    service.gameplay_ai.review(&service,&json!({"occurrence_id":items[1]["id"],"expected_revision":1,"action":"ambiguous","label":""})).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let quarantined = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(quarantined[0]["state"], "manual");
    assert_eq!(quarantined[0]["label"], "Q");
    assert_eq!(quarantined[1]["state"], "ambiguous");
    assert_eq!(quarantined[2]["state"], "conflict");
    assert_eq!(
        conn.query_row(
            "SELECT active FROM queue_items WHERE sample_key=?",
            [key],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn occurrence_owned_manual_conflicts_survive_restart() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    drop(conn);
    let a=service.gameplay_ai.review(&service,&json!({"occurrence_id":items[0]["id"],"expected_revision":0,"action":"manual","label":"Q"})).unwrap();
    assert_eq!(a["affected_count"], 3);
    let b=service.gameplay_ai.review(&service,&json!({"occurrence_id":items[1]["id"],"expected_revision":1,"action":"manual","label":"J"})).unwrap();
    assert_eq!(b["affected_count"], 2);
    let path = service
        .gameplay_ai
        .context
        .directory
        .parent()
        .unwrap()
        .join("ocr-evidence.sqlite3");
    let conn = Connection::open(path).unwrap();
    let rows = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(rows[0]["label"], "Q");
    assert_eq!(rows[0]["state"], "manual");
    assert_eq!(rows[1]["label"], "J");
    assert_eq!(rows[1]["state"], "manual");
    assert_eq!(rows[2]["state"], "conflict");
    assert!(service.gameplay_ai.review(&service,&json!({"occurrence_id":items[2]["id"],"expected_revision":2,"action":"manual","label":"not a rank"})).is_err());
    let blank=service.gameplay_ai.review(&service,&json!({"occurrence_id":items[2]["id"],"expected_revision":2,"action":"manual","label":""})).unwrap();
    assert_eq!(blank["item"]["state"], "manual");
    assert_eq!(blank["item"]["label"], "");
    let conn = service.gameplay_ai.context.connection().unwrap();
    let current = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    drop(conn);
    assert_eq!(current[0]["revision"], 1);
    let updated=service.gameplay_ai.review(&service,&json!({"occurrence_id":current[0]["id"],"expected_revision":current[0]["revision"],"action":"manual","label":"10"})).unwrap();
    assert_eq!(updated["item"]["label"], "10");
    let updated_b=service.gameplay_ai.review(&service,&json!({"occurrence_id":current[1]["id"],"expected_revision":current[1]["revision"],"action":"manual","label":"9"})).unwrap();
    assert_eq!(updated_b["item"]["label"], "9");
}
#[test]
fn unchanged_invalid_provider_echo_is_not_accepted() {
    let (_dir, mut service) = fixture();
    let config = service.gameplay_ai.config.join("gameplay-regions.json");
    fs::write(config,json!({"viewport":{"width":20,"height":20},"regions":[{"id":"seat.0.bank","bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
    let session = recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    Connection::open(root.join("gameplay.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE frames SET results_json=? WHERE session_id=?",
            params![
                json!({"seat.0.bank":{"prediction":{"text":"S 2 B"}}}).to_string(),
                session
            ],
        )
        .unwrap();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(|_, _| {
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"S 2 B","clarity":"clear","reason":"echo"}]}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let p = service.gameplay_ai.prepare(&service, &session).unwrap();
    let start=service.gameplay_ai.start(&service,&json!({"run_id":p["run_id"],"session_id":session,"auto_correct":true,"max_requests":2})).unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        start["job"]["id"].as_str().unwrap(),
    );
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["counts"]["verified"], 0);
    assert_eq!(status["counts"]["needs_review"], 3);
}

#[test]
fn preparation_reuses_durable_scope_and_prevents_premature_paid_start() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let first = service.gameplay_ai.prepare(&service, &session).unwrap();
    let second = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(first["run_id"], second["run_id"]);
    let run = first["run_id"].as_str().unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','preparing','$.processed_frames',1,'$.occurrences',1) WHERE run_id=?",[run]).unwrap();
    conn.execute("DELETE FROM gameplay_ai_run_items WHERE run_id=? AND occurrence_id NOT IN (SELECT id FROM gameplay_ai_occurrences WHERE run_id=? ORDER BY frame_id LIMIT 1)",params![run,run]).unwrap();
    drop(conn);
    let guard = service.gameplay_ai.context.operation.lock().unwrap();
    {
        let mut activity = service.gameplay_ai.context.state.lock().unwrap();
        activity["preparation_inflight"] = json!(true);
        activity["preparation_run_id"] = json!(run);
        activity["preparation_session_id"] = json!(session);
    }
    let progress = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(progress["run_id"], first["run_id"]);
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["state"], "preparing");
    assert_eq!(status["preparation"]["processed_frames"], 1);
    assert!(service
        .gameplay_ai
        .start(&service, &json!({"session_id":session,"run_id":run}))
        .is_err());
    drop(guard);
    let resumed = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(resumed["run_id"], first["run_id"]);
    assert_eq!(resumed["scope"]["phase"], "prepared");
    assert_eq!(resumed["scope"]["png_encodes"], 0);
    assert_eq!(resumed["scope"]["occurrences"], 3);
    let stop = service.request(LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/stop".into(),
        body: json!({"job_id":run}),
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(stop.status, 200);
    assert_eq!(stop.body["job"]["state"], "paused");
    assert!(service
        .gameplay_ai
        .start(&service, &json!({"session_id":session,"run_id":run}))
        .is_err());
}

#[test]
fn guided_neighbor_pixel_change_cannot_reuse_an_exact_asset_or_guess_a_label() {
    let (_dir, mut service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"source":"fixture_css","viewport":{"width":20,"height":20},"regions":[{"id":"board.0.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"},"bounds":{"x":2,"y":2,"width":6,"height":6},"guide":{"slot":{"x":2,"y":2,"width":6,"height":6},"anchor":{"x":5,"y":5},"alignment":"center","family":"card_rank","source":"deck_glyph_union"}}]}).to_string()).unwrap();
    let session = recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    let conn = Connection::open(root.join("gameplay.sqlite3")).unwrap();
    let frame: String = conn
        .query_row(
            "SELECT id FROM frames WHERE session_id=? LIMIT 1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    let path = root.join("frames").join(format!("{frame}.png"));
    let mut image = crate::media::decode_image(&fs::read(&path).unwrap())
        .unwrap()
        .to_rgb8();
    image.put_pixel(6, 5, Rgb([255, 255, 255]));
    let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
    fs::write(path, &png).unwrap();
    conn.execute(
        "UPDATE frames SET image_sha256=? WHERE id=?",
        params![sha256(&png), frame],
    )
    .unwrap();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(|payload, _| {
            let prompt = payload["input"][0]["content"][0]["text"].as_str().unwrap();
            let requested: Value = serde_json::from_str(
                prompt
                    .split("Requested IDs and region IDs: ")
                    .nth(1)
                    .unwrap(),
            )
            .unwrap();
            assert!(requested[0]["target_guide"]["anchor"].is_object());
            let items=requested.as_array().unwrap().iter().map(|row|json!({"id":row["id"],"text":"","clarity":"uncertain","reason":"Neighbor glyph makes target unattributable"})).collect::<Vec<_>>();
            Ok(json!({"output_text":json!({"items":items}).to_string()}))
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let p = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(p["scope"]["unique_crops"], 2);
    assert_eq!(p["scope"]["ambiguous"], 0);
    let start = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":p["run_id"],"max_requests":2}),
        )
        .unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        start["job"]["id"].as_str().unwrap(),
    );
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["counts"]["verified"], 0);
    assert_eq!(status["counts"]["needs_review"], 3);
}

#[test]
fn manual_review_and_status_survive_recording_writer() {
    for (region, label) in [("seat.6.dealer", ""), ("game.id", "#87654321")] {
        let (_dir, service) = fixture();
        fs::write(service.gameplay_ai.config.join("gameplay-regions.json"), json!({"viewport":{"width":20,"height":20},"regions":[{"id":region,"bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
        let session = recording(&service);
        service
            .ai_review
            .ensure(&service.gameplay_ai.context)
            .unwrap();
        let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let item = read_items(&conn, prep["run_id"].as_str().unwrap())
            .unwrap()
            .remove(0);
        drop(conn);
        let root = service.gameplay.evidence_root().unwrap();
        let writer = Connection::open(root.join("gameplay.sqlite3")).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let request = |method: &str, path: String, body: Value, query| {
            service.request(LabRequest {
                method: method.into(),
                path,
                body,
                query,
                headers: Default::default(),
            })
        };
        let query = std::collections::BTreeMap::from([("session_id".into(), session.clone())]);
        assert_eq!(
            request(
                "GET",
                "/api/gameplay/ai/status".into(),
                Value::Null,
                query.clone()
            )
            .status,
            200
        );
        let body = json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":label});
        let result = request(
            "POST",
            "/api/gameplay/ai/review".into(),
            body.clone(),
            Default::default(),
        );
        assert_eq!(result.status, 200, "{:?}", result.body);
        assert_eq!(result.body["revision"], 1);
        assert_eq!(result.body["item"]["state"], "manual");
        assert!(result.body["affected_count"].as_u64().unwrap() > 0);
        let status = request(
            "GET",
            "/api/gameplay/ai/status".into(),
            Value::Null,
            query.clone(),
        );
        assert_eq!(status.status, 200);
        assert!(status.body["job"]["counts"]["manual"].as_u64().unwrap() > 0);
        let items = request(
            "GET",
            "/api/gameplay/ai/items".into(),
            Value::Null,
            query.clone(),
        );
        assert_eq!(items.status, 200);
        assert!(items.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["state"] == "manual"));
        let mut review_query = query.clone();
        review_query.insert("filter".into(), "manual".into());
        let unresolved = request(
            "GET",
            "/api/gameplay/ai/items".into(),
            Value::Null,
            review_query.clone(),
        );
        assert_eq!(unresolved.status, 200);
        assert_eq!(unresolved.body["total"], 0);
        review_query.insert("filter".into(), "completed".into());
        let completed = request(
            "GET",
            "/api/gameplay/ai/items".into(),
            Value::Null,
            review_query,
        );
        assert_eq!(completed.status, 200);
        assert!(completed.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|value| value["state"] == "manual" && value["label"] == label));
        assert_eq!(
            request(
                "POST",
                "/api/gameplay/ai/review".into(),
                body,
                Default::default()
            )
            .status,
            409
        );
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            cache::truth(&conn, item["sample_key"].as_str().unwrap()).unwrap(),
            cache::Truth::Accepted {
                label: label.to_owned(),
                human: true
            }
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM gameplay_ai_decisions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM label_review_events WHERE action='manual'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(conn);
        writer.execute_batch("ROLLBACK").unwrap();
        if region == "game.id" {
            let summary = request(
                "GET",
                format!("/api/gameplay/sessions/{session}"),
                Value::Null,
                Default::default(),
            );
            assert_eq!(summary.status, 200);
            assert_eq!(summary.body["hands"][0]["hand_id"], "87654321");
            let frames = request(
                "GET",
                format!("/api/gameplay/sessions/{session}/frames"),
                Value::Null,
                std::collections::BTreeMap::from([("hand_id".into(), "87654321".into())]),
            );
            assert_eq!(frames.body["total"], 3);
            assert_eq!(frames.body["frames"][0]["captured_hand_id"], "12345678");
        }
    }
}

#[test]
fn accepted_game_id_bridge_keeps_capture_truth_separate() {
    let (_dir, service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"game.id","bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let before = service
        .gameplay
        .evidence_store()
        .unwrap()
        .list_page("frames", Some(&session), None, "asc", false, None, 1)
        .unwrap();
    let page_request = LabRequest {
        method: "GET".into(),
        path: format!("/api/gameplay/sessions/{session}/frames"),
        body: Value::Null,
        query: Default::default(),
        headers: Default::default(),
    };
    let page_before = service
        .list_page(page_request.clone(), None, Some(1))
        .unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, prep["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":"#87654321"})).unwrap();
    let stale = service
        .list_page(
            page_request,
            page_before.body["nextCursor"].as_str().map(str::to_owned),
            Some(1),
        )
        .unwrap();
    assert_eq!(stale.status, 409);
    let request = |path: String, query| {
        service.request(LabRequest {
            method: "GET".into(),
            path,
            body: Value::Null,
            query,
            headers: Default::default(),
        })
    };
    let summary = request(
        format!("/api/gameplay/sessions/{session}"),
        Default::default(),
    );
    assert_eq!(summary.status, 200);
    assert_eq!(summary.body["hands"][0]["hand_id"], "87654321");
    assert!(service
        .gameplay
        .evidence_store()
        .unwrap()
        .list_page(
            "frames",
            Some(&session),
            None,
            "asc",
            false,
            before["next_cursor"].as_str(),
            1
        )
        .unwrap_err()
        .starts_with("409:"));
    let frames = request(
        format!("/api/gameplay/sessions/{session}/frames"),
        std::collections::BTreeMap::from([("hand_id".into(), "87654321".into())]),
    );
    assert_eq!(frames.status, 200);
    assert_eq!(frames.body["total"], 3);
    assert_eq!(frames.body["frames"][0]["captured_hand_id"], "12345678");
    let (_, readings) = service.gameplay_ai.effective_hand_readings().unwrap();
    assert_eq!(readings.len(), 3);
    assert!(readings
        .iter()
        .all(|row| row.1.as_deref() == Some("87654321")));
    let root = service.gameplay.evidence_root().unwrap();
    let conn = Connection::open(root.join("gameplay.sqlite3")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM frames WHERE session_id=? AND hand_id='12345678'",
            [&session],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    let restarted = super::super::store::Store::new(root.clone()).unwrap();
    assert_eq!(restarted.hands(&session).unwrap()[0]["hand_id"], "87654321");
    let removed = readings[0].0.clone();
    conn.execute("DELETE FROM frames WHERE id=?", [removed])
        .unwrap();
    service.gameplay_ai.sync_effective_hands(&service).unwrap();
}

#[test]
fn guide_policy_change_keeps_one_pending_claim_without_reencoding() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let first = service.gameplay_ai.prepare(&service, &session).unwrap();
    let file = service.gameplay_ai.config.join("gameplay-regions.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    profile["id"] = json!("new-policy-provenance");
    fs::write(file, profile.to_string()).unwrap();
    let stale = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":first["run_id"]}),
        )
        .unwrap_err();
    assert!(stale.message.contains("profile changed"));
    let next = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_ne!(first["run_id"], next["run_id"]);
    assert_eq!(next["scope"]["png_encodes"], 0);
    assert_eq!(next["scope"]["reused_png_assets"], 0);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM queue_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(next["scope"]["exact_cache_hits"], 0);
}

#[test]
fn stop_by_prepared_run_id_cancels_the_newly_created_job_before_spending() {
    let (_dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            Err(bad("Must never call provider"))
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let started = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":prep["run_id"]}),
        )
        .unwrap();
    let stop = service.request(LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/stop".into(),
        body: json!({"job_id":prep["run_id"]}),
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(stop.status, 200);
    assert_eq!(stop.body["job"]["state"], "cancelled");
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        started["job"]["id"].as_str().unwrap(),
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn shared_pot_geometry_has_one_material_but_distinct_visible_ordinals() {
    let (_dir, service) = fixture();
    let regions=(0..10).map(|i|json!({"id":format!("pot.{i}"),"bounds":{"x":2.,"y":2.,"width":6.,"height":6.},"guide":{"slot":{"x":2.,"y":2.,"width":6.,"height":6.},"anchor":{"x":5.,"y":5.},"alignment":"center","family":"split_pot_group","source":"css_slot"}})).collect::<Vec<_>>();
    fs::write(
        service.gameplay_ai.config.join("gameplay-regions.json"),
        json!({"source":"fixture_css","viewport":{"width":20,"height":20},"regions":regions})
            .to_string(),
    )
    .unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let p = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(p["scope"]["occurrences"], 30);
    assert_eq!(p["scope"]["unique_crops"], 10);
    assert_eq!(p["scope"]["material_crops"], 3);
    assert_eq!(p["scope"]["png_encodes"], 1);
    assert_eq!(p["scope"]["verified_png_decodes"], 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(DISTINCT pixel_sha256) FROM queue_items",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(conn.query_row("SELECT COUNT(DISTINCT json_extract(payload,'$.guide.target_ordinal')) FROM queue_items",[],|r|r.get::<_,i64>(0)).unwrap(),10);
}

#[test]
fn content_addressed_asset_ignores_stale_inline_png_bytes_after_migration() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    service.gameplay_ai.prepare(&service, &session).unwrap();
    service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .execute("UPDATE queue_items SET crop=x'0001'", [])
        .unwrap();
    let file = service.gameplay_ai.config.join("gameplay-regions.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    profile["id"] = json!("new-profile-after-corrupted-blob");
    fs::write(file, profile.to_string()).unwrap();
    let next = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(next["scope"]["png_encodes"], 0);
    assert_eq!(next["scope"]["verified_png_decodes"], 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, next["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    drop(conn);
    let response = service.request(LabRequest {
        method: "GET".into(),
        path: format!("/api/gameplay/ai/crop/{}", item["id"].as_str().unwrap()),
        body: Value::Null,
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(response.status, 200);
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        response.body_base64.unwrap(),
    )
    .unwrap();
    assert!(crate::media::decode_image(&bytes).is_ok());
    assert_eq!(next["scope"]["exact_cache_hits"], 0);
}

#[test]
fn changed_policy_relinks_occurrences_without_reusing_old_shared_truth() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let old = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.source_scope_sha','old-policy') WHERE run_id=?",[old["run_id"].as_str().unwrap()]).unwrap();
    conn.execute(
        "UPDATE gameplay_ai_occurrences SET sample_key='old-policy-asset'",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO gameplay_ai_manual(sample_key,label,state) VALUES('old-policy-asset','A','manual')",[]).unwrap();
    drop(conn);
    let current = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_ne!(current["run_id"], old["run_id"]);
    assert_eq!(current["scope"]["exact_cache_hits"], 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, current["run_id"].as_str().unwrap()).unwrap();
    assert!(items
        .iter()
        .all(|item| item["state"] == "pending" && item["label"] == "K"));
}

#[test]
fn frame_ledger_summary_distinguishes_unsupported_visual_and_manual_states() {
    let (_dir, service) = fixture();
    let guide = json!({"slot":{"x":2.,"y":2.,"width":6.,"height":6.},"anchor":{"x":5.,"y":5.},"alignment":"center","family":"rank","source":"deck_glyph_union"});
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"source":"fixture_css","viewport":{"width":20,"height":20},"regions":[{"id":"board.0.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"},"category":"card","bounds":{"x":2,"y":2,"width":6,"height":6},"guide":guide},{"id":"seat.0.award","category":"winner","bounds":{"x":10,"y":10,"width":4,"height":4},"guideUnsupportedReason":"CSS motion lacks a proven fixed slot"},{"id":"header.timer","category":"timer","bounds":{"x":0,"y":0,"width":1,"height":1},"ocr":false}]}).to_string()).unwrap();
    let session = recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    let id: String = Connection::open(root.join("gameplay.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT id FROM frames WHERE session_id=? LIMIT 1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    let fetch = || {
        service
            .request(LabRequest {
                method: "GET".into(),
                path: format!("/api/gameplay/frames/{id}"),
                body: Value::Null,
                query: Default::default(),
                headers: Default::default(),
            })
            .body["frame"]
            .clone()
    };
    let before = fetch();
    assert_eq!(before["verification"]["total"], 2);
    assert_eq!(before["verification"]["unverified"], 1);
    assert_eq!(before["verification"]["unsupported"], 1);
    assert_eq!(
        before["effective_results"]["header.timer"]["verification"]["state"],
        "visual_indicator"
    );
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let p = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, p["run_id"].as_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|item| item["frame_id"] == id && item["region_id"] == "board.0.rank")
        .unwrap();
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":"A"})).unwrap();
    let manual = fetch();
    assert_eq!(manual["verification"]["verified"], 1);
    assert_eq!(manual["verification"]["unsupported"], 1);
    assert_eq!(manual["verification"]["status"], "partial");
    assert_eq!(
        manual["effective_results"]["board.0.rank"]["verification"]["source"],
        "human"
    );
    assert_eq!(manual["ocr_status"], before["ocr_status"]);
    assert_eq!(manual["results"], before["results"]);
    let list_request = LabRequest {
        method: "GET".into(),
        path: format!("/api/gameplay/sessions/{session}/frames"),
        body: Value::Null,
        query: Default::default(),
        headers: Default::default(),
    };
    let listed = service.request(list_request.clone());
    assert_eq!(listed.status, 200);
    assert!(listed.body["frames"]
        .as_array()
        .unwrap()
        .iter()
        .all(|frame| frame["verification"]["verified"] == 1
            && frame["verification"]["unsupported"] == 1
            && frame.get("effective_results").is_none()
            && frame.get("config_snapshot").is_none()));
    let paged = service.list_page(list_request, None, Some(2)).unwrap();
    assert_eq!(paged.status, 200);
    assert!(paged.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|frame| frame["verification"]["verified"] == 1));
    if let Ok(path) = std::env::var("POKER_AI_FIXTURE_RECEIPT") {
        fs::write(
            format!("{path}.states.json"),
            json!({"unprepared":before,"manual_unsupported_visual":manual}).to_string(),
        )
        .unwrap();
        fs::write(
            format!("{path}.frames.json"),
            json!({"regular":listed.body,"paged":paged.body}).to_string(),
        )
        .unwrap();
    }
}

#[test]
fn appending_a_frame_preserves_occurrence_owned_human_decisions() {
    for action in ["manual", "ambiguous"] {
        let (_dir, service) = fixture();
        let session = recording(&service);
        service
            .ai_review
            .ensure(&service.gameplay_ai.context)
            .unwrap();
        let first = service.gameplay_ai.prepare(&service, &session).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let old = read_items(&conn, first["run_id"].as_str().unwrap())
            .unwrap()
            .remove(0);
        drop(conn);
        let label = if action == "manual" { "Q" } else { "" };
        service.gameplay_ai.review(&service,&json!({"occurrence_id":old["id"],"expected_revision":0,"action":action,"label":label})).unwrap();
        let mut image = RgbImage::from_pixel(20, 20, Rgb([20, 20, 20]));
        image.put_pixel(5, 5, Rgb([255, 255, 255]));
        if action == "ambiguous" {
            image.put_pixel(6, 5, Rgb([255, 255, 255]));
        }
        let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
        service.gameplay.evidence_store().unwrap().admit(&session,&png,20,20,"2026-11-14T00:00:01Z",&json!({"regions":{}}),"fixture",&json!({"community_cards[0]":{"prediction":{"text":"K"},"rect":{"x":2,"y":2,"w":6,"h":6}}}),"12345678",&json!({})).unwrap();
        let next = service.gameplay_ai.prepare(&service, &session).unwrap();
        assert_ne!(first["run_id"], next["run_id"]);
        let conn = service.gameplay_ai.context.connection().unwrap();
        let current = read_items(&conn, next["run_id"].as_str().unwrap()).unwrap();
        let retained = current.iter().find(|item| item["id"] == old["id"]).unwrap();
        assert_eq!(retained["state"], action);
        assert_eq!(retained["label"], label);
        assert_eq!(retained["revision"], 1);
        assert_eq!(current.len(), 4);
        if action == "ambiguous" {
            assert!(current.iter().any(|item| item["state"] == "pending"));
        } else {
            assert!(current.iter().all(|item| item["label"] == "Q"));
        }
    }
}

#[test]
fn pilot_uses_existing_workflow_and_full_scope_reuses_accepted_assets() {
    let (_dir, mut service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"board.0.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"},"bounds":{"x":2,"y":2,"width":6,"height":6}},{"id":"board.1.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"bounds":{"x":2,"y":2,"width":6,"height":6}},{"id":"header.timer","ocr":false,"bounds":{"x":0,"y":0,"width":1,"height":1}}]}).to_string()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"nativepixels"}]}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    let frame: String = Connection::open(root.join("gameplay.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT id FROM frames WHERE session_id=? LIMIT 1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    let selection = json!([{"frame_id":frame,"region_id":"board.0.rank"}]);
    let pilot = service
        .gameplay_ai
        .prepare_scope(&service, &session, Some(&selection))
        .unwrap();
    assert_eq!(pilot["scope"]["kind"], "pilot");
    assert_eq!(pilot["scope"]["occurrences"], 1);
    assert_eq!(pilot["scope"]["recording_frame_count"], 3);
    let started = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":pilot["run_id"],"max_requests":6}),
        )
        .unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        started["job"]["id"].as_str().unwrap(),
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["counts"]["frames_completed"],
        0
    );
    let full = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_ne!(pilot["run_id"], full["run_id"]);
    assert_eq!(full["scope"]["occurrences"], 6);
    assert_eq!(full["scope"]["exact_cache_hits"], 6);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    for invalid in [
        json!([{"frame_id":frame,"region_id":"board.0.rank","expected_label":"A"}]),
        json!([{"frame_id":frame,"region_id":"header.timer"}]),
        json!([{"frame_id":frame,"region_id":"board.0.rank"},{"frame_id":frame,"region_id":"board.0.rank"}]),
    ] {
        assert!(service
            .gameplay_ai
            .prepare_scope(&service, &session, Some(&invalid))
            .is_err());
    }
}

#[test]
fn right_edge_anchor_readmission_reuses_run_and_preserves_owned_ambiguity() {
    let (_dir, service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"source":"fixture_css","viewport":{"width":20,"height":20},"regions":[{"id":"game.high_hand","bounds":{"x":14.,"y":2.,"width":6.,"height":6.},"guide":{"slot":{"x":14.,"y":2.,"width":6.,"height":6.},"anchor":{"x":20.,"y":5.},"alignment":"right","family":"high_hand","source":"css_slot"}}]}).to_string()).unwrap();
    let session = recording(&service);
    let first = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(first["scope"]["ambiguous"], 0);
    let run = first["run_id"].as_str().unwrap();
    let old_reason="Source-derived target guide is missing, clipped, or occurrence requires explicit human resolution";
    let mark_previous = || {
        let conn = service.gameplay_ai.context.connection().unwrap();
        conn.execute(
            "UPDATE gameplay_ai_occurrences SET state='ambiguous',reason=?",
            [old_reason],
        )
        .unwrap();
        conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.admission_revision',1) WHERE run_id=?",[run]).unwrap();
    };
    mark_previous();
    let refreshed = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(refreshed["run_id"], first["run_id"]);
    assert_eq!(refreshed["scope"]["ambiguous"], 0);
    assert_eq!(refreshed["scope"]["occurrences"], 3);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, run).unwrap().remove(0);
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"ambiguous","label":""})).unwrap();
    mark_previous();
    let again = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(again["run_id"], first["run_id"]);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let retained = read_items(&conn, run).unwrap();
    assert_eq!(retained[0]["state"], "ambiguous");
    assert_eq!(
        conn.query_row("SELECT active FROM queue_items LIMIT 1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn isolated_repair_keeps_owned_manual_truth_and_records_diagnostics_only() {
    let (_dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |payload, _| {
            count.fetch_add(1, Ordering::SeqCst);
            let prompt = payload["input"][0]["content"][0]["text"].as_str().unwrap();
            assert!(prompt.contains("No expected labels are provided"));
            Ok(
                json!({"id":"fake","output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"pixels"}]}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture-key","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let start = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":prepared["run_id"]}),
        )
        .unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        start["job"]["id"].as_str().unwrap(),
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let item = service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .query_row("SELECT id FROM gameplay_ai_occurrences LIMIT 1", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":item,"expected_revision":0,"action":"manual","label":""}),
        )
        .unwrap();
    let payload = json!({"session_id":session,"run_id":prepared["run_id"],"repair_occurrence_ids":[item],"max_requests":4});
    let plan = service.gameplay_ai.repair_plan(&payload).unwrap();
    assert_eq!(plan["first_pass_batches"], 1);
    let repair = service.gameplay_ai.start(&service, &payload).unwrap();
    let job = repair["job"]["id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let result: String = conn
        .query_row(
            "SELECT result FROM ai_review_items WHERE job_id=?",
            [job],
            |r| r.get(0),
        )
        .unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["state"], "flagged");
    assert_eq!(result["proposed_label"], "A");
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    let owned = items.iter().find(|x| x["id"] == item).unwrap();
    assert_eq!(owned["label"], "");
    assert_eq!(owned["state"], "manual");
}

#[test]
fn human_status_transcription_retains_outside_contract_provenance() {
    let (_dir, service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"seats[0].status","bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let item = read_items(&service.gameplay_ai.context.connection().unwrap(), run)
        .unwrap()
        .remove(0);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":item["revision"],"action":"manual","label":"Waiting For Players"})).unwrap();
    let rows = read_items(&service.gameplay_ai.context.connection().unwrap(), run).unwrap();
    let owned = rows.iter().find(|r| r["id"] == item["id"]).unwrap();
    assert_eq!(owned["state"], "manual");
    assert_eq!(owned["label"], "Waiting For Players");
    assert_eq!(owned["schema_valid"], false);
    assert_eq!(owned["outside_contract"], true);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT outside_contract FROM label_review_events ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(conn);
    assert!(!crate::labels::validate_text(
        "status",
        "Waiting For Players",
        false
    ));
    assert!(service.gameplay_ai.review(&service,&json!({"occurrence_id":rows[1]["id"],"expected_revision":rows[1]["revision"],"action":"manual","label":"$ arbitrary money"})).is_err());
}

#[test]
fn nameplate_contexts_never_enter_ocr_queue_and_crop_media_only_derives_alpha() {
    use base64::Engine;
    let (_dir, service) = fixture();
    let mut regions = vec![
        json!({"id":"seats[0].bank","category":"bank","bounds":{"x":2.,"y":2.,"width":6.,"height":6.},"crop_mask_source":"chip_columns_value"}),
    ];
    for i in 0..9 {
        regions.push(json!({"id":format!("seats[{i}].nameplate"),"category":"cv_nameplate","ocr":false,"overlay":false,"bounds":{"x":0.,"y":0.,"width":20.,"height":20.}}));
    }
    fs::write(
        service.gameplay_ai.config.join("gameplay-regions.json"),
        json!({"viewport":{"width":20,"height":20},"regions":regions}).to_string(),
    )
    .unwrap();
    let session = recording(&service);
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(prepared["scope"]["expected_regions"], 1);
    assert_eq!(prepared["scope"]["occurrences"], 3);
    let rows = read_items(
        &service.gameplay_ai.context.connection().unwrap(),
        prepared["run_id"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r["region_id"] == "seats[0].bank"));
    let frame = rows[0]["frame_id"].as_str().unwrap();
    let response = service.request(LabRequest {
        method: "GET".into(),
        path: format!("/api/gameplay/frames/{frame}"),
        body: Value::Null,
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(response.body["frame"]["verification"]["total"], 1);
    let response = service.request(LabRequest {
        method: "GET".into(),
        path: rows[0]["crop_url"].as_str().unwrap().into(),
        body: Value::Null,
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(response.status, 200);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(response.body_base64.unwrap())
        .unwrap();
    let display = image::load_from_memory(&bytes).unwrap();
    assert_eq!(display.color(), image::ColorType::Rgba8);
    assert!(display.to_rgba8().get_pixel(0, 0).0[3] < 255);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let canonical: Vec<u8> = conn
        .query_row(
            &format!(
                "SELECT {} FROM queue_items LIMIT 1",
                crate::lab::pixel_assets::expression(&conn, "queue_items").unwrap()
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        image::load_from_memory(&canonical).unwrap().color(),
        image::ColorType::Rgb8
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM queue_items WHERE region_id LIKE '%nameplate%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn selected_scope_survives_reversion_other_session_and_restart() {
    let (dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            panic!("scope selection must not call the provider")
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    let frame: String = Connection::open(root.join("gameplay.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT id FROM frames WHERE session_id=? LIMIT 1",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    let selection = json!([{"frame_id":frame,"region_id":"board.0.rank"}]);
    let a = service
        .gameplay_ai
        .prepare_scope(&service, &session, Some(&selection))
        .unwrap();
    let b = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    conn.execute(
        "UPDATE gameplay_ai_runs SET created_at=1 WHERE run_id=?",
        [a["run_id"].as_str().unwrap()],
    )
    .unwrap();
    conn.execute(
        "UPDATE gameplay_ai_runs SET created_at=2 WHERE run_id=?",
        [b["run_id"].as_str().unwrap()],
    )
    .unwrap();
    drop(conn);
    let queued = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":b["run_id"],"max_requests":1}),
        )
        .unwrap();
    assert!(service
        .gameplay_ai
        .prepare_scope(&service, &session, Some(&selection))
        .unwrap_err()
        .message
        .contains("Stop the active Gameplay review"));
    service
        .ai_review
        .cancel(
            &service.gameplay_ai.context,
            queued["job"]["id"].as_str().unwrap(),
        )
        .unwrap();
    let again = service
        .gameplay_ai
        .prepare_scope(&service, &session, Some(&selection))
        .unwrap();
    assert_eq!(again["run_id"], a["run_id"]);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let occurrence = read_items(&conn, a["run_id"].as_str().unwrap()).unwrap()[0]["id"].clone();
    drop(conn);
    let reviewed = service.gameplay_ai.review(&service, &json!({"occurrence_id":occurrence,"expected_revision":0,"label":"Q","action":"manual"})).unwrap();
    assert_eq!(reviewed["item"]["state"], "manual");
    let check = |service: &LabService| {
        assert_eq!(
            service.gameplay_ai.status(service, &session).unwrap()["id"],
            a["run_id"]
        );
        let request = LabRequest {
            method: "GET".into(),
            path: String::new(),
            body: Value::Null,
            query: [
                ("session_id".into(), session.clone()),
                ("grouped".into(), "false".into()),
            ]
            .into(),
            headers: Default::default(),
        };
        assert_eq!(
            service.gameplay_ai.items(service, &request).unwrap()["total"],
            1
        );
        assert_eq!(
            service.gameplay_ai.status(service, &session).unwrap()["counts"]["manual"],
            1
        );
    };
    check(&service);
    let other = recording(&service);
    service.gameplay_ai.prepare(&service, &other).unwrap();
    check(&service);
    drop(service);
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
    let reopened = LabService::open_with_paths(
        dir.path().join("data"),
        dir.path().join("config"),
        tools,
        Default::default(),
    )
    .unwrap();
    check(&reopened);
    let conn = reopened.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT created_at FROM gameplay_ai_runs WHERE run_id=?",
            [a["run_id"].as_str().unwrap()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn workflow_fixture() -> (tempfile::TempDir, LabService, Arc<AtomicUsize>) {
    let (dir, mut service) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"fixture"}]}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    (dir, service, calls)
}
fn workflow_prepare(service: &LabService, session: &str, flagged: bool) -> Value {
    let mut body = json!({"session_id":session,"auto_correct":false,"max_requests":2});
    if flagged {
        body["review_after_prepare"] = json!(true);
    }
    let response = service.request(LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/prepare".into(),
        body,
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(response.status, 200, "{}", response.body);
    response.body
}
#[test]
fn workflow_flagged_prepare_launches_review_without_frontend() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let prepared = workflow_prepare(&service, &session, true);
    let job = prepared["job_id"].as_str().unwrap();
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["auto_correct"],
        false
    );
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "2"
    );
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["state"],
        "completed"
    );
}
#[test]
fn workflow_pause_at_prepared_completion_prevents_provider_calls() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let (a, b) = (entered.clone(), release.clone());
    *service.gameplay_ai.handoff_hook.lock().unwrap() = Some(Arc::new(move || {
        a.wait();
        b.wait();
    }));
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| workflow_prepare(&service, &session, true));
        entered.wait();
        let before: String = service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let duplicate = service.gameplay_ai.prepare_workflow(
            &service,
            &session,
            None,
            &json!({"auto_correct":false,"max_requests":2}),
        );
        assert!(duplicate.is_err());
        assert_eq!(
            service
                .gameplay_ai
                .context
                .connection()
                .unwrap()
                .query_row(
                    "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            before
        );

        let run = selected_run(
            &*service.gameplay_ai.context.connection().unwrap(),
            &session,
        )
        .unwrap()
        .unwrap()
        .0;
        let response = service.request(LabRequest {
            method: "POST".into(),
            path: "/api/gameplay/ai/stop".into(),
            body: json!({"job_id":run}),
            query: Default::default(),
            headers: Default::default(),
        });
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["job"]["state"], "paused");
        assert_eq!(response.body["job"]["auto_correct"], false);
        assert_eq!(response.body["job"]["max_requests"], 2);
        release.wait();
        assert!(worker.join().unwrap()["job_id"].is_null());
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let reopened = GameplayAi::open(
        service.gameplay_ai.context.directory.parent().unwrap(),
        service.gameplay_ai.config.clone(),
    )
    .unwrap();
    assert_eq!(
        reopened.status(&service, &session).unwrap()["state"],
        "paused"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let intent: String = reopened
        .context
        .connection()
        .unwrap()
        .query_row(
            "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&intent).unwrap()["paused"],
        true
    );
    let resumed = reopened
        .prepare_workflow(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"auto_correct":false,"max_requests":2}),
        )
        .unwrap();
    service
        .ai_review
        .run_fixture(&reopened.context, resumed["job_id"].as_str().unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn workflow_duplicate_adopts_linked_job_without_extra_provider_calls() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let first = workflow_prepare(&service, &session, true);
    let intent: String = service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .query_row(
            "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let duplicate = workflow_prepare(&service, &session, true);
    assert_eq!(duplicate["job_id"], first["job_id"]);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        intent
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    service
        .ai_review
        .cancel(
            &service.gameplay_ai.context,
            first["job_id"].as_str().unwrap(),
        )
        .unwrap();
    let resumed = workflow_prepare(&service, &session, true);
    assert_eq!(resumed["job_id"], first["job_id"]);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        first["job_id"].as_str().unwrap(),
    );
    let count = calls.load(Ordering::SeqCst);
    let completed = workflow_prepare(&service, &session, true);
    assert_eq!(completed["job_id"], first["job_id"]);
    assert_eq!(calls.load(Ordering::SeqCst), count);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let cached_session = recording(&service);
    let cached = workflow_prepare(&service, &cached_session, true);
    assert!(cached["job_id"].is_null());
    assert_eq!(calls.load(Ordering::SeqCst), count);
    assert_eq!(
        service
            .gameplay_ai
            .status(&service, &cached_session)
            .unwrap()["state"],
        "completed"
    );
}
#[test]
fn workflow_unflagged_prepare_and_status_never_call_provider() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let prepared = workflow_prepare(&service, &session, false);
    assert!(prepared["job_id"].is_null());
    for _ in 0..2 {
        assert_eq!(
            service.gameplay_ai.status(&service, &session).unwrap()["state"],
            "prepared"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let reopened = GameplayAi::open(
        service.gameplay_ai.context.directory.parent().unwrap(),
        service.gameplay_ai.config.clone(),
    )
    .unwrap();
    assert_eq!(
        reopened.status(&service, &session).unwrap()["state"],
        "prepared"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn workflow_selection(service: &LabService, session: &str, offset: usize) -> Value {
    let root = service.gameplay.evidence_root().unwrap();
    let conn = Connection::open(root.join("gameplay.sqlite3")).unwrap();
    let frame: String = conn
        .query_row(
            "SELECT id FROM frames WHERE session_id=? ORDER BY captured_at,id LIMIT 1 OFFSET ?",
            params![session, offset as i64],
            |r| r.get(0),
        )
        .unwrap();
    json!([{"frame_id":frame,"region_id":"board.0.rank"}])
}
fn workflow_body(flagged: bool) -> Value {
    json!({"review_after_prepare":flagged,"auto_correct":false,"max_requests":2})
}
fn workflow_request(
    service: &LabService,
    session: &str,
    selection: Option<&Value>,
    body: &Value,
) -> LabResponse {
    let mut body = body.clone();
    body["session_id"] = json!(session);
    if let Some(selection) = selection {
        body["selection"] = selection.clone();
    }
    service.request(LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/prepare".into(),
        body,
        query: Default::default(),
        headers: Default::default(),
    })
}
#[test]
fn workflow_busy_adopts_only_identical_scope_and_options() {
    for pilot in [false, true] {
        let (_dir, service, calls) = workflow_fixture();
        let session = recording(&service);
        let other_session = recording(&service);
        let a = workflow_selection(&service, &session, 0);
        let b = workflow_selection(&service, &session, 1);
        let selection = pilot.then_some(&a);
        let body = workflow_body(true);
        let first = workflow_request(&service, &session, selection, &body);
        assert_eq!(first.status, 200, "{}", first.body);
        let duplicate = workflow_request(&service, &session, selection, &body);
        assert_eq!(duplicate.status, 200, "{}", duplicate.body);
        assert_eq!(duplicate.body["job_id"], first.body["job_id"]);
        for wrong in [Some(&b), if pilot { None } else { Some(&a) }] {
            let response = workflow_request(&service, &session, wrong, &body);
            assert_eq!(response.status, 409, "{}", response.body);
        }
        let response = workflow_request(&service, &other_session, None, &body);
        assert_eq!(response.status, 409, "{}", response.body);
        for changed in [
            json!({"review_after_prepare":false,"auto_correct":false,"max_requests":2}),
            json!({"review_after_prepare":true,"auto_correct":true,"max_requests":2}),
            json!({"review_after_prepare":true,"auto_correct":false,"max_requests":3}),
        ] {
            let response = workflow_request(&service, &session, selection, &changed);
            assert_eq!(response.status, 409, "{}", response.body);
        }
        for invalid in [
            json!({"review_after_prepare":"true"}),
            json!({"max_requests":0}),
        ] {
            assert_eq!(
                workflow_request(&service, &session, selection, &invalid).status,
                400
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            service
                .gameplay_ai
                .context
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                    .get::<_, i64>(0),)
                .unwrap(),
            1
        );
    }
}

#[test]
fn workflow_pending_scope_b_never_returns_previous_scope_a_or_changes_options() {
    for flagged in [false, true] {
        let (_dir, service, calls) = workflow_fixture();
        let session = recording(&service);
        let a = workflow_selection(&service, &session, 0);
        let b = workflow_selection(&service, &session, 1);
        let first = workflow_request(&service, &session, Some(&a), &workflow_body(false));
        assert_eq!(first.status, 200, "{}", first.body);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let release_rx = Mutex::new(release_rx);
        let once = AtomicUsize::new(0);
        *service.gameplay_ai.preparation_hook.lock().unwrap() = Some(Arc::new(move |_| {
            if once.fetch_add(1, Ordering::SeqCst) == 0 {
                entered_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
            }
        }));
        std::thread::scope(|scope| {
            let worker = scope
                .spawn(|| workflow_request(&service, &session, Some(&b), &workflow_body(flagged)));
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            let previous = workflow_request(&service, &session, Some(&a), &workflow_body(flagged));
            let duplicate = workflow_request(&service, &session, Some(&b), &workflow_body(flagged));
            let changed = workflow_request(&service, &session, Some(&b), &workflow_body(!flagged));
            for wrong in [
                json!({"review_after_prepare":flagged,"auto_correct":true,"max_requests":2}),
                json!({"review_after_prepare":flagged,"auto_correct":false,"max_requests":3}),
            ] {
                let response = workflow_request(&service, &session, Some(&b), &wrong);
                assert_eq!(response.status, 409, "{}", response.body);
            }
            release_tx.send(()).unwrap();
            let prepared = worker.join().unwrap();
            assert_eq!(previous.status, 409, "{}", previous.body);
            assert_eq!(changed.status, 409, "{}", changed.body);
            assert_eq!(duplicate.status, 200, "{}", duplicate.body);
            assert_eq!(prepared.status, 200, "{}", prepared.body);
            assert_eq!(duplicate.body["run_id"], prepared.body["run_id"]);
            assert_ne!(duplicate.body["run_id"], first.body["run_id"]);
            assert!(duplicate.body["job_id"].is_null());
            assert_eq!(prepared.body["job_id"].is_string(), flagged);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn workflow_stop_during_sqlite_write_transaction_uses_cancellation_fallback() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let once = AtomicUsize::new(0);
    *service.gameplay_ai.preparation_hook.lock().unwrap() = Some(Arc::new(move |_| {
        if once.fetch_add(1, Ordering::SeqCst) == 0 {
            entered_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }
    }));
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| workflow_prepare(&service, &session, true));
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        let duplicate = workflow_request(&service, &session, None, &workflow_body(true));
        assert_eq!(duplicate.status, 200, "{}", duplicate.body);
        assert!(duplicate.body["job_id"].is_null());
        let conn = Connection::open(
            service
                .gameplay_ai
                .context
                .directory
                .parent()
                .unwrap()
                .join("ocr-evidence.sqlite3"),
        )
        .unwrap();
        conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let error = conn.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(error, _) if error.code == rusqlite::ErrorCode::DatabaseBusy)
        );
        let run = selected_run(
            &*service.gameplay_ai.context.connection().unwrap(),
            &session,
        )
        .unwrap()
        .unwrap()
        .0;
        let stopped = service.request(LabRequest {
            method: "POST".into(),
            path: "/api/gameplay/ai/stop".into(),
            body: json!({"job_id":run}),
            query: Default::default(),
            headers: Default::default(),
        });
        release_tx.send(()).unwrap();
        let prepared = worker.join().unwrap();
        assert_eq!(stopped.status, 200, "{}", stopped.body);
        assert_eq!(stopped.body["job"]["state"], "paused");
        assert!(prepared["job_id"].is_null());
        assert_eq!(prepared["scope"]["phase"], "paused");
    });
    let conn = service.gameplay_ai.context.connection().unwrap();
    let raw: String = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key='gameplay_workflow'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["paused"], true);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn workflow_reopen_adopts_linked_interrupted_job_without_duplicate_or_implicit_spend() {
    for running in [false, true] {
        let (dir, service, calls) = workflow_fixture();
        let session = recording(&service);
        let first = workflow_prepare(&service, &session, true);
        let job = first["job_id"].as_str().unwrap().to_owned();
        if running {
            service
                .gameplay_ai
                .context
                .connection()
                .unwrap()
                .execute(
                    "UPDATE ai_review_jobs SET state='running' WHERE id=?",
                    [&job],
                )
                .unwrap();
        }
        drop(service);
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
        let mut service = LabService::open_with_paths(
            dir.path().join("data"),
            dir.path().join("config"),
            tools,
            Default::default(),
        )
        .unwrap();
        let count = calls.clone();
        service.ai_review = Arc::new(AiReviewManager::with_transport(
            service.registry.clone(),
            Arc::new(move |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(
                    json!({"output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"fixture"}]}).to_string()}),
                )
            }),
            false,
        ));
        service
            .ai_review
            .configure(&json!({"api_key":"fixture","model":"fixture"}))
            .unwrap();
        service
            .ai_review
            .ensure(&service.gameplay_ai.context)
            .unwrap();
        assert_eq!(
            service.gameplay_ai.status(&service, &session).unwrap()["state"],
            "interrupted"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let adopted = workflow_request(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"auto_correct":false}),
        );
        assert_eq!(adopted.status, 200, "{}", adopted.body);
        let adopted = adopted.body;
        assert_eq!(
            service
                .gameplay_ai
                .context
                .connection()
                .unwrap()
                .query_row(
                    "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
            "2"
        );
        assert_eq!(adopted["run_id"], first["run_id"]);
        assert_eq!(adopted["job_id"], first["job_id"]);
        assert_eq!(
            workflow_prepare(&service, &session, true)["job_id"],
            first["job_id"]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            service
                .gameplay_ai
                .context
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                    .get::<_, i64>(0),)
                .unwrap(),
            1
        );
        service
            .ai_review
            .run_fixture(&service.gameplay_ai.context, &job);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            workflow_prepare(&service, &session, true)["job_id"],
            first["job_id"]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

#[test]
fn workflow_exhausted_budget_requires_explicit_larger_cumulative_limit() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let body = json!({"review_after_prepare":true,"auto_correct":false,"max_requests":1});
    let first = workflow_request(&service, &session, None, &body);
    assert_eq!(first.status, 200, "{}", first.body);
    let job = first.body["job_id"].as_str().unwrap();
    service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .execute(
            "UPDATE queue_meta SET value='10000' WHERE key='gameplay_request_budget'",
            [],
        )
        .unwrap();

    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    let exhausted = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(exhausted["state"], "failed");
    assert!(exhausted["error"]
        .as_str()
        .unwrap()
        .contains("budget reached"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let resume = service.request(LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/resume".into(),
        body: json!({"job_id":job}),
        query: Default::default(),
        headers: Default::default(),
    });
    assert_eq!(resume.status, 400, "{}", resume.body);
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["state"],
        "failed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let implicit = workflow_request(
        &service,
        &session,
        None,
        &json!({"review_after_prepare":true,"auto_correct":false}),
    );
    assert_eq!(implicit.status, 400, "{}", implicit.body);
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["state"],
        "failed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        "1"
    );

    let wrong_correction = workflow_request(
        &service,
        &session,
        None,
        &json!({"review_after_prepare":true,"auto_correct":true,"max_requests":2}),
    );
    assert_eq!(wrong_correction.status, 409, "{}", wrong_correction.body);
    let explicit = workflow_request(&service, &session, None, &workflow_body(true));
    assert_eq!(explicit.status, 200, "{}", explicit.body);
    assert_eq!(explicit.body["job_id"], job);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        "2"
    );
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["state"],
        "completed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
                .get::<_, i64>(0),)
            .unwrap(),
        1
    );
}

#[test]
fn workflow_omitted_initial_budget_keeps_default_100() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let prepared = workflow_request(
        &service,
        &session,
        None,
        &json!({"review_after_prepare":true,"auto_correct":false}),
    );
    assert_eq!(prepared.status, 200, "{}", prepared.body);
    assert_eq!(
        service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
        "100"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn workflow_older_linked_job_requires_explicit_budget_instead_of_default_increase() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let first = workflow_request(
        &service,
        &session,
        None,
        &json!({"review_after_prepare":true,"auto_correct":false,"max_requests":1}),
    );
    assert_eq!(first.status, 200, "{}", first.body);
    let job = first.body["job_id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    service.gameplay_ai.context.connection().unwrap().execute(
        "UPDATE gameplay_ai_runs SET scope=json_remove(scope,'$.workflow_options') WHERE run_id=?",
        [first.body["run_id"].as_str().unwrap()],
    ).unwrap();
    let implicit = workflow_request(
        &service,
        &session,
        None,
        &json!({"review_after_prepare":true,"auto_correct":false}),
    );
    assert_eq!(implicit.status, 409, "{}", implicit.body);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let explicit = workflow_request(&service, &session, None, &workflow_body(true));
    assert_eq!(explicit.status, 200, "{}", explicit.body);
    assert_eq!(explicit.body["job_id"], job);
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, job);
    assert_eq!(
        service.gameplay_ai.status(&service, &session).unwrap()["state"],
        "completed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn workflow_rejected_repair_never_changes_an_existing_request_budget() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let first = workflow_prepare(&service, &session, true);
    let job = first["job_id"].as_str().unwrap();
    let invalid = json!({"session_id":session,"run_id":first["run_id"],"repair_occurrence_ids":["missing"],"max_requests":10000});
    for active in [true, false] {
        if !active {
            service
                .ai_review
                .run_fixture(&service.gameplay_ai.context, job);
        }
        let before = calls.load(Ordering::SeqCst);
        assert!(service.gameplay_ai.start(&service, &invalid).is_err());
        let conn = service.gameplay_ai.context.connection().unwrap();
        let limit: String = conn
            .query_row(
                "SELECT value FROM queue_meta WHERE key='gameplay_request_budget'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(limit, "2");
        let job_limit: String = conn
            .query_row(
                "SELECT value FROM queue_meta WHERE key=?",
                [format!("gameplay_request_budget:{job}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(job_limit, "2");
        assert_eq!(calls.load(Ordering::SeqCst), before);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn workflow_reopened_preparation_is_resumable_without_starting_provider_work() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let prepared = workflow_prepare(&service, &session, false);
    service.gameplay_ai.context.connection().unwrap().execute(
        "UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','preparing','$.processed_frames',0) WHERE run_id=?", [prepared["run_id"].as_str().unwrap()],
    ).unwrap();
    let reopened = GameplayAi::open(
        service.gameplay_ai.context.directory.parent().unwrap(),
        service.gameplay_ai.config.clone(),
    )
    .unwrap();
    for _ in 0..2 {
        let status = reopened.status(&service, &session).unwrap();
        assert_eq!(status["state"], "paused");
        assert_eq!(status["preparation"]["inflight"], false);
        assert_eq!(status["auto_correct"], false);
        assert_eq!(status["max_requests"], 2);
        assert_eq!(status["scope"]["phase"], "preparing");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn recovery_replays_raw_phases_with_no_duplicate_calls_and_keeps_quarantine() {
    for saved_second in [true, false] {
        let (_dir, mut service) = fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        service.ai_review = Arc::new(AiReviewManager::with_transport(
            service.registry.clone(),
            Arc::new(move |_, _| {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                Ok(
                    json!({"id":format!("response-{n}"),"model":"fixture","output_text":json!({"items":[{"id":"0","text":"A","clarity":"clear","reason":"raw pixels"}]}).to_string()}),
                )
            }),
            false,
        ));
        service
            .ai_review
            .configure(&json!({"api_key":"fixture","model":"fixture"}))
            .unwrap();
        let session = recording(&service);
        let first = service
            .gameplay_ai
            .prepare_workflow(
                &service,
                &session,
                None,
                &json!({"review_after_prepare":true,"max_requests":2}),
            )
            .unwrap();
        let old = first["job_id"].as_str().unwrap();
        service
            .ai_review
            .run_fixture(&service.gameplay_ai.context, old);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let raw: String;
        {
            let mut conn = service.gameplay_ai.context.connection().unwrap();
            // Legacy batching/ordinals differ from the fresh scope.
            for column in ["response", "verification"] {
                let value: Option<String> = conn
                    .query_row(
                        &format!("SELECT {column} FROM ai_review_batches WHERE job_id=?"),
                        [old],
                        |r| r.get(0),
                    )
                    .unwrap();
                if let Some(value) = value {
                    let mut value: Value = serde_json::from_str(&value).unwrap();
                    let row = value.as_object_mut().unwrap().remove("0").unwrap();
                    value["17"] = row;
                    conn.execute(
                        &format!("UPDATE ai_review_batches SET {column}=? WHERE job_id=?"),
                        params![value.to_string(), old],
                    )
                    .unwrap();
                }
            }
            conn.execute(
                "UPDATE ai_review_items SET ordinal=17,batch_index=135 WHERE job_id=?",
                [old],
            )
            .unwrap();
            conn.execute(
                "UPDATE ai_review_batches SET batch_index=135 WHERE job_id=?",
                [old],
            )
            .unwrap();
            raw = conn
                .query_row(
                    "SELECT response FROM ai_review_batches WHERE job_id=?",
                    [old],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute("UPDATE gameplay_ai_runs SET scope=json_remove(json_set(scope,'$.source_scope_sha','legacy-scope'),'$.review_policy') WHERE job_id=?",[old]).unwrap();
            if !saved_second {
                conn.execute("DELETE FROM gameplay_ai_request_intents WHERE json_extract(response,'$.id')='response-1'",[]).unwrap();
                conn.execute(
                    "UPDATE ai_review_batches SET verification=NULL WHERE job_id=?",
                    [old],
                )
                .unwrap();
            }
            let tx = conn.transaction().unwrap();
            quarantine::apply(&tx, old, "fixture audit").unwrap();
            tx.commit().unwrap();
        }
        let waiting = service.gameplay_ai.prepare(&service, &session).unwrap();
        assert!(waiting["scope"]["recover_from_job_id"].is_null());
        service.gameplay_ai.context.connection().unwrap().execute(
            "UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','paused') WHERE run_id=?",
            [waiting["run_id"].as_str().unwrap()],
        ).unwrap();
        let candidate = service.gameplay_ai.status(&service, &session).unwrap();
        assert_eq!(candidate["recovery_candidate_job_id"], old);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let payload = json!({"review_after_prepare":true,"max_requests":1,"recover_from_job_id":candidate["recovery_candidate_job_id"]});
        let mut api_payload = payload.clone();
        api_payload["session_id"] = json!(session);
        let response = service.request(LabRequest {
            method: "POST".into(),
            path: "/api/gameplay/ai/prepare".into(),
            body: api_payload,
            query: Default::default(),
            headers: Default::default(),
        });
        assert_eq!(response.status, 200, "{}", response.body);
        let recovered = response.body;
        assert_ne!(recovered["run_id"], first["run_id"]);
        assert_eq!(
            recovered["scope"]["profile_id"],
            first["scope"]["profile_id"]
        );
        assert_eq!(recovered["scope"]["review_policy"], cache::REVIEW_POLICY);
        let new = recovered["job_id"].as_str().unwrap();
        assert_ne!(new, old);
        service
            .ai_review
            .run_fixture(&service.gameplay_ai.context, new);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if saved_second { 2 } else { 3 }
        );
        let status = service.gameplay_ai.status(&service, &session).unwrap();
        assert_eq!(status["counts"]["corrected"], 3, "{status}");
        let again = service
            .gameplay_ai
            .prepare_workflow(&service, &session, None, &payload)
            .unwrap();
        assert_eq!(again["job_id"], new);
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT response FROM ai_review_batches WHERE job_id=?",
                [old],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            raw
        );
        assert!(quarantine::guard(&conn, old).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM ai_review_recovered_observations WHERE target_job=?",
                [new],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            if saved_second { 2 } else { 1 }
        );
        assert_eq!(conn.query_row("SELECT source_ordinal FROM ai_review_recovered_observations WHERE target_job=? LIMIT 1",[new],|r|r.get::<_,i64>(0)).unwrap(),17);
        assert_eq!(conn.query_row("SELECT source_batch FROM ai_review_recovered_observations WHERE target_job=? LIMIT 1",[new],|r|r.get::<_,i64>(0)).unwrap(),135);
        assert!(conn
            .execute(
                "DELETE FROM ai_review_recovered_observations WHERE target_job=?",
                [new]
            )
            .is_err());
    }
}

#[test]
fn card_support_is_required_before_cache_or_automatic_acceptance() {
    for support in [
        Value::Null,
        json!("unverified"),
        json!("unsupported"),
        json!("ambiguous"),
    ] {
        let (_dir, service) = fixture();
        let path = service.gameplay_ai.config.join("gameplay-regions.json");
        let mut profile: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        profile["regions"][0]["presence"]["target_support"] = support;
        fs::write(path, profile.to_string()).unwrap();
        let session = recording(&service);
        let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
        assert_eq!(items.len(), 3);
        assert!(items
            .iter()
            .all(|i| i["state"] == "flagged" && i["crop_available"] == true));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM queue_items WHERE active=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn recovery_unknown_outcome_rolls_back_new_job_without_provider_requests() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let first = workflow_prepare(&service, &session, true);
    let old = first["job_id"].as_str().unwrap();
    service
        .ai_review
        .cancel(&service.gameplay_ai.context, old)
        .unwrap();
    {
        let mut conn = service.gameplay_ai.context.connection().unwrap();
        conn.execute("UPDATE gameplay_ai_runs SET scope=json_remove(json_set(scope,'$.source_scope_sha','legacy'),'$.review_policy') WHERE job_id=?",[old]).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_request_intents(request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL)").unwrap();
        conn.execute(
            "INSERT INTO gameplay_ai_request_intents VALUES('unknown',?,'pending',NULL,0)",
            [old],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        quarantine::apply(&tx, old, "unknown fixture").unwrap();
        tx.commit().unwrap();
    }
    let err = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"max_requests":2,"recover_from_job_id":old}),
        )
        .unwrap_err();
    assert!(err.message.contains("unknown outcome"), "{}", err.message);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(quarantine::guard(&conn, old).is_err());
}

#[test]
fn recovery_partial_multi_batch_snapshot_only_sends_missing_phases() {
    let (_dir, mut service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"seat.0.name","bounds":{"x":2,"y":2,"width":6,"height":6}},{"id":"seat.0.status","bounds":{"x":2,"y":2,"width":6,"height":6}},{"id":"game.id","bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |payload, _| {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            let prompt = payload["input"][0]["content"][0]["text"].as_str().unwrap();
            let requested: Value = serde_json::from_str(
                prompt
                    .split("Requested IDs and region IDs: ")
                    .nth(1)
                    .unwrap(),
            )
            .unwrap();
            let items=requested.as_array().unwrap().iter().map(|i|json!({"id":i["id"],"text":match i["region"].as_str().unwrap(){"seat.0.name"=>"Alice","seat.0.status"=>"Fold",_=>"12345678"},"clarity":"clear","reason":"raw fixture"})).collect::<Vec<_>>();
            Ok(
                json!({"id":format!("response-{n}"),"model":"fixture","output_text":json!({"items":items}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    let session = recording(&service);
    let prepared = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"max_requests":6}),
        )
        .unwrap();
    let old = prepared["job_id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, old);
    assert_eq!(calls.load(Ordering::SeqCst), 6);
    {
        let mut conn = service.gameplay_ai.context.connection().unwrap();
        // A compact 3-first / 1-second snapshot represents an interrupted large review.
        conn.execute("DELETE FROM gameplay_ai_request_intents WHERE json_extract(response,'$.id') IN ('response-3','response-5')",[]).unwrap();
        conn.execute(
            "UPDATE ai_review_batches SET verification=NULL WHERE job_id=? AND batch_index>0",
            [old],
        )
        .unwrap();
        let batches = conn
            .prepare(
                "SELECT batch_index,response,verification FROM ai_review_batches WHERE job_id=?",
            )
            .unwrap()
            .query_map([old], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for (batch, first, second) in batches {
            for (column, value) in [("response", Some(first)), ("verification", second)] {
                if let Some(value) = value {
                    let mut value: Value = serde_json::from_str(&value).unwrap();
                    let ordinal = conn
                        .query_row(
                            "SELECT ordinal FROM ai_review_items WHERE job_id=? AND batch_index=?",
                            params![old, batch],
                            |r| r.get::<_, i64>(0),
                        )
                        .unwrap();
                    let row = value
                        .as_object_mut()
                        .unwrap()
                        .remove(&ordinal.to_string())
                        .unwrap();
                    value[(ordinal + 20).to_string()] = row;
                    conn.execute(&format!("UPDATE ai_review_batches SET {column}=? WHERE job_id=? AND batch_index=?"),params![value.to_string(),old,batch]).unwrap();
                }
            }
        }
        conn.execute("UPDATE ai_review_items SET ordinal=ordinal+20,batch_index=batch_index+135 WHERE job_id=?",[old]).unwrap();
        conn.execute(
            "UPDATE ai_review_batches SET batch_index=batch_index+135 WHERE job_id=?",
            [old],
        )
        .unwrap();
        conn.execute("UPDATE gameplay_ai_runs SET scope=json_remove(json_set(scope,'$.source_scope_sha','legacy'),'$.review_policy') WHERE job_id=?",[old]).unwrap();
        let tx = conn.transaction().unwrap();
        quarantine::apply(&tx, old, "partial fixture").unwrap();
        tx.commit().unwrap();
    }
    let recovered = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"max_requests":2,"recover_from_job_id":old}),
        )
        .unwrap();
    let new = recovered["job_id"].as_str().unwrap();
    service
        .ai_review
        .run_fixture(&service.gameplay_ai.context, new);
    assert_eq!(calls.load(Ordering::SeqCst), 8);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM ai_review_recovered_observations WHERE target_job=?",
            [new],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    assert_eq!(
        conn.query_row("SELECT state FROM ai_review_jobs WHERE id=?", [new], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "completed"
    );
}

#[test]
fn current_unsupported_occurrence_cannot_inherit_supported_global_card_truth() {
    let (_dir, service, calls) = workflow_fixture();
    let first = recording(&service);
    let prepared = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &first,
            None,
            &json!({"review_after_prepare":true,"auto_correct":true,"max_requests":2}),
        )
        .unwrap();
    service.ai_review.run_fixture(
        &service.gameplay_ai.context,
        prepared["job_id"].as_str().unwrap(),
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let path = service.gameplay_ai.config.join("gameplay-regions.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    profile["regions"][0]["presence"]["target_support"] = json!("unsupported");
    profile["regions"][0]["presence"]["card_evidence"]["target_support"] = json!("unsupported");
    fs::write(path, profile.to_string()).unwrap();
    let second = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &second).unwrap();
    assert_eq!(prepared["scope"]["exact_cache_hits"], 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert!(items
        .iter()
        .all(|i| i["state"] == "flagged" && i["label"] == "K"));
    assert!(matches!(
        cache::truth(&conn, items[0]["sample_key"].as_str().unwrap()).unwrap(),
        cache::Truth::Accepted { human: false, .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn injected_occupancy_is_rederived_from_current_pixels_before_ai_admission() {
    for state in ["empty", "occupied", "unknown"] {
        let (_dir, service) = fixture();
        let occupancy = json!({"state":state,"source":"source_free_seat_pixels","reason":"fixture free-seat pixels","policy":"source_free_seat_occupancy_v1"});
        let regions=["seats[0].cards[0]","seats[0].name"].into_iter().map(|id|json!({"id":id,"bounds":{"x":2,"y":2,"width":6,"height":6},"seat_occupancy":occupancy,"presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}}})).collect::<Vec<_>>();
        fs::write(
            service.gameplay_ai.config.join("gameplay-regions.json"),
            json!({"viewport":{"width":20,"height":20},"regions":regions}).to_string(),
        )
        .unwrap();
        let session = recording(&service);
        let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
        let repeated = service.gameplay_ai.prepare(&service, &session).unwrap();
        assert_eq!(repeated["run_id"], prepared["run_id"]);
        let conn = service.gameplay_ai.context.connection().unwrap();
        let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
        assert_eq!(items.len(), 6);
        assert!(items
            .iter()
            .all(|i| i["seat_occupancy"]["state"] == "unknown"));
        assert_eq!(prepared["scope"]["absent_count"], 0);
        assert!(items
            .iter()
            .all(|i| i["state"] != "absent" && i["crop_available"] == true));
        let frame = items[0]["frame_id"].as_str().unwrap().to_string();
        drop(conn);
        let response = service.request(LabRequest {
            method: "GET".into(),
            path: format!("/api/gameplay/frames/{frame}"),
            body: Value::Null,
            query: Default::default(),
            headers: Default::default(),
        });
        assert_eq!(response.status, 200, "{}", response.body);
        assert_ne!(
            response.body["frame"]["effective_results"]["seats[0].cards[0]"]["verification"]
                ["state"],
            "absent"
        );
    }
}

#[test]
fn enrichment_rederives_empty_metadata_without_localizers() {
    let (_dir, service) = fixture();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"seats[0].name","category":"name","bounds":{"x":2,"y":2,"width":6,"height":6},"seat_occupancy":{"state":"empty","source":"source_free_seat_pixels","policy":"source_free_seat_occupancy_v1"}}]}).to_string()).unwrap();
    recording(&service);
    let root = service.gameplay.evidence_root().unwrap();
    let path = fs::read_dir(root.join("frames"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "png"))
        .unwrap();
    let mut frame = json!({"id":path.file_stem().unwrap().to_str().unwrap(),"width":20,"height":20,"results":{},"config_snapshot":{}});
    service
        .gameplay_ai
        .enrich_frame_at(&mut frame, &root)
        .unwrap();
    assert_eq!(
        frame["effective_config_snapshot"]["regions"]["regions"][0]["seat_occupancy"]["state"],
        "unknown"
    );
    let state = &frame["effective_results"]["seats[0].name"]["verification"]["state"];
    assert!(state.is_string(), "{frame}");
    assert_ne!(state, "absent");
}

#[test]
fn resume_explicit_budget_is_job_specific_and_exhaustion_sends_no_request() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let prepared = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &session,
            None,
            &json!({"review_after_prepare":true,"auto_correct":false,"max_requests":10000}),
        )
        .unwrap();
    let job = prepared["job_id"].as_str().unwrap();
    let frozen_scope = service.gameplay_ai.status(&service, &session).unwrap()["scope"].clone();
    service
        .ai_review
        .cancel(&service.gameplay_ai.context, job)
        .unwrap();
    let request = |limit: Option<Value>| {
        let mut body = json!({"job_id":job});
        if let Some(limit) = limit {
            body["max_requests"] = limit;
        }
        service.request(LabRequest {
            method: "POST".into(),
            path: "/api/gameplay/ai/resume".into(),
            body,
            query: Default::default(),
            headers: Default::default(),
        })
    };
    for limit in [
        json!(0),
        json!(10001),
        json!(1.5),
        json!("650"),
        Value::Null,
    ] {
        assert_eq!(request(Some(limit)).status, 400);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = request(Some(json!(650)));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["job"]["id"], job);
    assert_eq!(response.body["job"]["max_requests"], 650);
    assert_eq!(response.body["job"]["scope"], frozen_scope);
    assert_eq!(response.body["job"]["auto_correct"], false);
    service
        .ai_review
        .cancel(&service.gameplay_ai.context, job)
        .unwrap();
    let response = request(None);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body["job"]["max_requests"], 650);
    service
        .ai_review
        .cancel(&service.gameplay_ai.context, job)
        .unwrap();
    {
        let conn = service.gameplay_ai.context.connection().unwrap();
        conn.execute(
            "UPDATE ai_review_jobs SET usage=json_set(usage,'$.requests',65) WHERE id=?",
            [job],
        )
        .unwrap();
    }
    for limit in [1, 64, 65] {
        let response = request(Some(json!(limit)));
        assert_eq!(response.status, 400, "{}", response.body);
        assert!(response.body.to_string().contains("already exhausted"));
    }
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT value FROM queue_meta WHERE key=?",
            [format!("gameplay_request_budget:{job}")],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "650"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn supported_card_blank_pairs_never_accept_even_when_prior_is_blank() {
    for (region, text, clarity, prior, supported) in [
        ("board.0.rank", "", "blank", "", true),
        ("board.0.suit", "", "blank", "", true),
        ("board.0.suit", "", "blank", "d", true),
        ("board.0.rank", "Q", "clear", "K", true),
        ("board.0.suit", "d", "clear", "h", true),
    ] {
        let (_dir, mut service) = fixture();
        let support = if supported {
            "supported"
        } else {
            "unsupported"
        };
        fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":region,"bounds":{"x":2,"y":2,"width":6,"height":6},"presence":{"target_support":support,"card_evidence":{"target_support":support,"policy":"source_card_plane_component_support_v1"}}}]}).to_string()).unwrap();
        service.ai_review = Arc::new(AiReviewManager::with_transport(
            service.registry.clone(),
            Arc::new(move |_, _| {
                Ok(
                    json!({"id":"fixture-response","model":"fixture","output_text":json!({"items":[{"id":"0","text":text,"clarity":clarity,"reason":"fixture pixels"}]}).to_string()}),
                )
            }),
            false,
        ));
        service
            .ai_review
            .configure(&json!({"api_key":"fixture","model":"fixture"}))
            .unwrap();
        let session = recording(&service);
        let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
        {
            let conn = service.gameplay_ai.context.connection().unwrap();
            conn.execute("UPDATE queue_items SET label=?,reviewed=1", [prior])
                .unwrap();
        }
        let started=service.gameplay_ai.start(&service,&json!({"session_id":session,"run_id":prep["run_id"],"auto_correct":true,"max_requests":2})).unwrap();
        let job = started["job"]["id"].as_str().unwrap();
        service
            .ai_review
            .run_fixture(&service.gameplay_ai.context, job);
        let conn = service.gameplay_ai.context.connection().unwrap();
        let (state, raw, key): (String, String, String) = conn
            .query_row(
                "SELECT state,result,sample_key FROM ai_review_items WHERE job_id=?",
                [job],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap_or_else(|e| {
                panic!("{region} {text:?} prior {prior:?}: {e}; {started}; {prep}")
            });
        let result: Value = serde_json::from_str(&raw).unwrap();
        if text.is_empty() {
            assert_eq!(state, "flagged", "{result}");
            assert_eq!(result["proposed_label"], "");
            assert_eq!(result["first_reading"]["clarity"], "blank");
            assert_eq!(result["verification"]["clarity"], "blank");
            assert!(result["event_id"].is_null());
            assert!(matches!(
                cache::truth(&conn, &key).unwrap(),
                cache::Truth::NeedsReview { .. }
            ));
            conn.execute(
                "UPDATE ai_review_items SET state='unchanged' WHERE job_id=?",
                [job],
            )
            .unwrap();
            assert!(matches!(
                cache::truth(&conn, &key).unwrap(),
                cache::Truth::NeedsReview { .. }
            ));
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM label_review_events WHERE action='accepted'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        } else {
            assert_eq!(state, "corrected", "{result}");
            assert!(matches!(
                cache::truth(&conn, &key).unwrap(),
                cache::Truth::Accepted { human: false, .. }
            ));
        }
    }
}

#[test]
fn recovery_candidate_status_is_session_scoped_idle_and_read_only() {
    let (_dir, service, calls) = workflow_fixture();
    let session = recording(&service);
    let other_session = recording(&service);
    let unrelated_session = recording(&service);
    let mut sources = Vec::new();
    for (index, source_session) in [&session, &session, &other_session].into_iter().enumerate() {
        let prepared = workflow_prepare(&service, source_session, true);
        let job = prepared["job_id"].as_str().unwrap().to_owned();
        service
            .ai_review
            .cancel(&service.gameplay_ai.context, &job)
            .unwrap();
        let mut conn = service.gameplay_ai.context.connection().unwrap();
        conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.source_scope_sha','legacy-scope') WHERE job_id=?", [&job]).unwrap();
        conn.execute(
            "UPDATE ai_review_jobs SET created_at=? WHERE id=?",
            params![index as i64, job],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        quarantine::apply(&tx, &job, "synthetic candidate fixture").unwrap();
        tx.commit().unwrap();
        sources.push(job);
    }
    let waiting = service.gameplay_ai.prepare(&service, &session).unwrap();
    let unrelated = service
        .gameplay_ai
        .prepare(&service, &unrelated_session)
        .unwrap();
    let conn = Connection::open(
        service
            .gameplay_ai
            .context
            .directory
            .with_extension("sqlite3"),
    )
    .unwrap();
    let poll = |session: &str| {
        let response = service.request(LabRequest {
            method: "GET".into(),
            path: "/api/gameplay/ai/status".into(),
            body: Value::Null,
            query: [("session_id".into(), session.into())].into(),
            headers: Default::default(),
        });
        assert_eq!(response.status, 200, "{}", response.body);
        response.body["job"].clone()
    };
    for phase in ["paused", "prepared"] {
        conn.execute(
            "UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase',?) WHERE run_id=?",
            params![phase, waiting["run_id"].as_str().unwrap()],
        )
        .unwrap();
        let before = selected_run(&conn, &session).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .unwrap();
        for _ in 0..2 {
            let status = poll(&session);
            assert_eq!(status["state"], phase);
            assert_eq!(status["recovery_candidate_job_id"], sources[1]);
            assert!(status["scope"]["recover_from_job_id"].is_null());
            assert_eq!(
                poll(&unrelated_session)["recovery_candidate_job_id"],
                Value::Null
            );
        }
        assert_eq!(selected_run(&conn, &session).unwrap(), before);
        assert_eq!(
            conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
    }
    assert_eq!(poll(&other_session)["state"], "quarantined");
    assert!(poll(&other_session)["recovery_candidate_job_id"].is_null());
    conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.recover_from_job_id',?) WHERE run_id=?", params![sources[1], waiting["run_id"].as_str().unwrap()]).unwrap();
    let persisted = poll(&session);
    assert_eq!(persisted["scope"]["recover_from_job_id"], sources[1]);
    assert!(persisted["recovery_candidate_job_id"].is_null());
    conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.recover_from_job_id',NULL) WHERE run_id=?", [waiting["run_id"].as_str().unwrap()]).unwrap();
    for state in ["queued", "running"] {
        conn.execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at) VALUES('active-fixture','gameplay-ai',?,?,'fixture',1,0,100,100)", params![unrelated["run_id"].as_str().unwrap(), state]).unwrap();
        assert!(poll(&session)["recovery_candidate_job_id"].is_null());
        conn.execute("DELETE FROM ai_review_jobs WHERE id='active-fixture'", [])
            .unwrap();
    }
    assert_eq!(poll(&session)["recovery_candidate_job_id"], sources[1]);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(quarantine::guard(&conn, &sources[0]).is_err());
    assert!(quarantine::guard(&conn, &sources[1]).is_err());
    assert!(quarantine::guard(&conn, &sources[2]).is_err());
    let err = service
        .gameplay_ai
        .prepare_workflow(
            &service,
            &unrelated_session,
            None,
            &json!({"recover_from_job_id":sources[1]}),
        )
        .unwrap_err();
    assert!(err.message.contains("from this recording"));
}

fn assert_read_rows(actual: &ReadRows, expected: &[Value]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.as_ref(), expected);
    }
}

#[test]
#[ignore = "Requires an immutable private ledger snapshot, never opens live data"]
fn private_projection_benchmark() {
    let path = std::env::var("POKER_PERF_DB").unwrap();
    let conn =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let run: String = conn.query_row("SELECT run_id FROM gameplay_ai_run_items GROUP BY run_id ORDER BY COUNT(*) DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    let (_dir, service) = fixture();
    *service.gameplay_ai.context.connection().unwrap() = Connection::open_with_flags(
        conn.path().unwrap(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let baseline_start = std::time::Instant::now();
    let baseline_items = read_items(&conn, &run).unwrap();
    eprintln!("read_items: {:?}", baseline_start.elapsed());
    let group_start = std::time::Instant::now();
    let baseline_groups = cache::group_work(&conn, baseline_items.clone()).unwrap();
    eprintln!("group_work: {:?}", group_start.elapsed());
    eprintln!(
        "uncached projection: {:?} items={} groups={}",
        baseline_start.elapsed(),
        baseline_items.len(),
        baseline_groups.len()
    );
    for i in 0..4 {
        let start = std::time::Instant::now();
        let (items, groups) = service.gameplay_ai.read_snapshot(&run).unwrap();
        let page: Vec<_> = groups.iter().take(100).cloned().collect();
        let elapsed = start.elapsed();
        assert_read_rows(&items, &baseline_items);
        assert_read_rows(&groups, &baseline_groups);
        eprintln!(
            "snapshot {i}: {:?} items={} groups={} page={}",
            elapsed,
            items.len(),
            groups.len(),
            page.len()
        );
    }
    let session: String = conn
        .query_row(
            "SELECT session_id FROM gameplay_ai_runs WHERE run_id=?",
            [&run],
            |r| r.get(0),
        )
        .unwrap();
    for filter in ["all", "completed", "manual"] {
        let request = LabRequest {
            method: "GET".into(),
            path: String::new(),
            body: Value::Null,
            query: [
                ("session_id".into(), session.clone()),
                ("filter".into(), filter.into()),
            ]
            .into(),
            headers: Default::default(),
        };
        let start = std::time::Instant::now();
        let result = service.gameplay_ai.items(&service, &request).unwrap();
        eprintln!(
            "items endpoint {filter}: {:?} total={}",
            start.elapsed(),
            result["total"]
        );
    }
}

#[test]
fn read_snapshot_invalidates_on_local_and_external_writes_and_run_changes() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    drop(conn);
    let (first, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    let (warm, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(Arc::ptr_eq(&first, &warm));
    let conn = service.gameplay_ai.context.connection().unwrap();
    conn.execute("UPDATE gameplay_ai_occurrences SET reason='local change' WHERE id=(SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=? LIMIT 1)", [run]).unwrap();
    let db_path = conn.path().unwrap().to_owned();
    drop(conn);
    let (local, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(!Arc::ptr_eq(&first, &local));
    let external = Connection::open(db_path).unwrap();
    external.execute("UPDATE gameplay_ai_occurrences SET reason='external change' WHERE id=(SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=? LIMIT 1)", [run]).unwrap();
    let (changed, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(!Arc::ptr_eq(&local, &changed));
    let (other, _) = service.gameplay_ai.read_snapshot("other-run").unwrap();
    assert!(other.is_empty());
    let (again, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(!Arc::ptr_eq(&changed, &again));
    assert_eq!(*changed, *again);
}

#[test]
fn read_snapshot_retries_write_after_projection() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_dir, service) = fixture();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap().to_owned();
    let path = service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .path()
        .unwrap()
        .to_owned();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let hook_run = run.clone();
    *service.gameplay_ai.projection_hook.lock().unwrap() = Some(Arc::new(move || {
        if observed.fetch_add(1, Ordering::SeqCst) == 0 {
            let external = Connection::open(&path).unwrap();
            external.execute("UPDATE gameplay_ai_occurrences SET reason='concurrent write' WHERE id=(SELECT occurrence_id FROM gameplay_ai_run_items WHERE run_id=? LIMIT 1)", [&hook_run]).unwrap();
        }
    }));
    let (items, groups) = service.gameplay_ai.read_snapshot(&run).unwrap();
    assert!(calls.load(Ordering::SeqCst) >= 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let expected = read_items(&conn, &run).unwrap();
    let expected_groups = cache::group_work(&conn, expected.clone()).unwrap();
    assert_read_rows(&items, &expected);
    assert_read_rows(&groups, &expected_groups);
}

#[test]
fn manual_refresh_matches_fresh_projection_and_invalidates_external_write() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    {
        let conn = service.gameplay_ai.context.connection().unwrap();
        let rows = read_items(&conn, run).unwrap();
        conn.execute(
            "INSERT INTO gameplay_ai_legacy(occurrence_id,label,provenance) VALUES(?,?,?)",
            params![rows.last().unwrap()["id"].as_str().unwrap(), "K", "{}"],
        )
        .unwrap();
    }
    let (before, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    let id = before[0]["id"].as_str().unwrap().to_owned();
    let revision = before[0]["revision"].as_i64().unwrap();
    service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":id,"expected_revision":revision,"label":"Q","action":"manual"}),
        )
        .unwrap();
    {
        let current = ReadSource::read(&service.gameplay_ai.context.connection().unwrap()).unwrap();
        let cache = service.gameplay_ai.read_snapshot.lock().unwrap();
        assert!(cache.as_ref().is_some_and(
            |snapshot| snapshot.source == current && !Arc::ptr_eq(&snapshot.items, &before)
        ));
    }
    let (incremental, groups) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(!Arc::ptr_eq(&before, &incremental));
    let conn = service.gameplay_ai.context.connection().unwrap();
    let source = ReadSource::read(&conn).unwrap();
    assert!(service
        .gameplay_ai
        .read_snapshot
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.source == source && Arc::ptr_eq(&s.items, &incremental)));
    let expected = read_items(&conn, run).unwrap();
    let expected_groups = cache::group_work(&conn, expected.clone()).unwrap();
    assert_read_rows(&incremental, &expected);
    assert_read_rows(&groups, &expected_groups);
    let second = incremental[1].clone();
    let path = conn.path().unwrap().to_owned();
    drop(conn);
    service.gameplay_ai.review(&service, &json!({"occurrence_id":second["id"],"expected_revision":second["revision"],"label":"J","action":"manual"})).unwrap();
    let (conflict_items, conflict_groups) = service.gameplay_ai.read_snapshot(run).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let fresh = read_items(&conn, run).unwrap();
    let fresh_groups = cache::group_work(&conn, fresh.clone()).unwrap();
    assert_read_rows(&conflict_items, &fresh);
    assert_read_rows(&conflict_groups, &fresh_groups);
    drop(conn);
    let request = |filter: &str, grouped: &str| LabRequest {
        method: "GET".into(),
        path: String::new(),
        body: Value::Null,
        query: [
            ("session_id".into(), session.clone()),
            ("filter".into(), filter.into()),
            ("grouped".into(), grouped.into()),
        ]
        .into(),
        headers: Default::default(),
    };
    let filters = [
        "all",
        "completed",
        "manual",
        "pending",
        "ambiguous",
        "conflict",
        "flagged",
        "error",
    ];
    let cached_pages: Vec<_> = filters
        .iter()
        .flat_map(|filter| {
            ["true", "false"].map(|grouped| {
                service
                    .gameplay_ai
                    .items(&service, &request(filter, grouped))
                    .unwrap()
            })
        })
        .collect();
    let cached_status = service.gameplay_ai.status(&service, &session).unwrap();
    *service.gameplay_ai.read_snapshot.lock().unwrap() = None;
    let fresh_pages: Vec<_> = filters
        .iter()
        .flat_map(|filter| {
            ["true", "false"].map(|grouped| {
                service
                    .gameplay_ai
                    .items(&service, &request(filter, grouped))
                    .unwrap()
            })
        })
        .collect();
    let fresh_status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(cached_pages, fresh_pages);
    assert_eq!(cached_status["counts"], fresh_status["counts"]);
    assert_eq!(cached_status["group_counts"], fresh_status["group_counts"]);
    let (incremental, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    Connection::open(path)
        .unwrap()
        .execute(
            "UPDATE gameplay_ai_occurrences SET reason='external' WHERE id=?",
            [&id],
        )
        .unwrap();
    let (external, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    assert!(!Arc::ptr_eq(&incremental, &external));
}

#[test]
fn manual_refresh_shares_untouched_occurrences_and_groups() {
    let (_dir, service) = fixture();
    let config = service.gameplay_ai.config.join("gameplay-regions.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    profile["regions"].as_array_mut().unwrap().push(json!({
        "id":"game.id", "bounds":{"x":10,"y":10,"width":6,"height":6}
    }));
    fs::write(config, profile.to_string()).unwrap();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let (before, before_groups) = service.gameplay_ai.read_snapshot(run).unwrap();
    let target = before
        .iter()
        .find(|item| item["region_id"] == "board.0.rank")
        .unwrap();
    service
        .gameplay_ai
        .review(
            &service,
            &json!({
                "occurrence_id":target["id"], "expected_revision":target["revision"],
                "action":"manual", "label":"Q"
            }),
        )
        .unwrap();
    let (after, groups) = service.gameplay_ai.read_snapshot(run).unwrap();
    let untouched: Vec<_> = before
        .iter()
        .filter(|item| item["region_id"] == "game.id")
        .collect();
    assert_eq!(untouched.len(), 3);
    for old in untouched {
        let new = after.iter().find(|item| item["id"] == old["id"]).unwrap();
        assert!(Arc::ptr_eq(old, new));
    }
    let old_group = before_groups
        .iter()
        .find(|item| item["region_id"] == "game.id")
        .unwrap();
    let new_group = groups
        .iter()
        .find(|item| item["work_key"] == old_group["work_key"])
        .unwrap();
    assert!(Arc::ptr_eq(old_group, new_group));
    let changed = after
        .iter()
        .find(|item| item["id"] == target["id"])
        .unwrap();
    assert!(!Arc::ptr_eq(target, changed));
    assert_eq!(target["label"], "K");
    assert_eq!(changed["label"], "Q");
    let conn = service.gameplay_ai.context.connection().unwrap();
    let fresh = read_items(&conn, run).unwrap();
    assert_read_rows(&after, &fresh);
    assert_read_rows(&groups, &cache::group_work(&conn, fresh).unwrap());
}

#[test]
#[ignore = "Requires a private ledger copied to a temporary writable database"]
fn private_manual_refresh_benchmark() {
    let source = std::fs::canonicalize(std::env::var("POKER_PERF_DB").unwrap()).unwrap();
    assert!(
        source.starts_with("/tmp"),
        "benchmark requires a private snapshot under /tmp"
    );
    let wal = std::path::PathBuf::from(format!("{}-wal", source.display()));
    assert!(
        !wal.exists() || wal.metadata().unwrap().len() == 0,
        "snapshot must be self-contained without a populated WAL"
    );
    let (dir, service) = fixture();
    let path = dir.path().join("benchmark-copy.sqlite3");
    std::fs::copy(source, &path).unwrap();
    let conn = Connection::open(&path).unwrap();
    crate::lab::pixel_assets::install(&conn).unwrap();
    let run: String = conn.query_row("SELECT run_id FROM gameplay_ai_run_items GROUP BY run_id ORDER BY COUNT(*) DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    let session: String = conn
        .query_row(
            "SELECT session_id FROM gameplay_ai_runs WHERE run_id=?",
            [&run],
            |r| r.get(0),
        )
        .unwrap();
    // Select this run in the private copy so the endpoint and projection agree.
    conn.execute("INSERT INTO queue_meta(key,value) VALUES(?,json_quote(?)) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("gameplay_selected:{session}"), run]).unwrap();
    *service.gameplay_ai.context.connection().unwrap() = conn;
    let request = LabRequest {
        method: "GET".into(),
        path: "/api/gameplay/ai/items".into(),
        body: Value::Null,
        query: [
            ("session_id".into(), session),
            ("filter".into(), "manual".into()),
        ]
        .into(),
        headers: Default::default(),
    };
    let start = std::time::Instant::now();
    let cold = service.request(request.clone());
    assert_eq!(cold.status, 200, "{:?}", cold.body);
    eprintln!("cold endpoint: {:?}", start.elapsed());
    for n in 0..2 {
        let conn = service.gameplay_ai.context.connection().unwrap();
        let (id, revision): (String, i64) = conn.query_row("SELECT o.id,o.revision FROM gameplay_ai_occurrences o JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id JOIN queue_items q USING(sample_key) WHERE r.run_id=? AND o.category='card' AND q.pixel_asset_sha IS NOT NULL ORDER BY o.id LIMIT 1 OFFSET ?", params![run, n], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        drop(conn);
        let start = std::time::Instant::now();
        let result = service.request(LabRequest { method: "POST".into(), path: "/api/gameplay/ai/review".into(), body: json!({"occurrence_id":id,"expected_revision":revision,"label":"A","action":"manual"}), query: Default::default(), headers: Default::default() });
        assert_eq!(result.status, 200, "{:?}", result.body);
        let post = start.elapsed();
        let start = std::time::Instant::now();
        let page = service.request(request.clone());
        assert_eq!(page.status, 200, "{:?}", page.body);
        let get = start.elapsed();
        let (incremental, groups) = service.gameplay_ai.read_snapshot(&run).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let fresh = read_items(&conn, &run).unwrap();
        let fresh_groups = cache::group_work(&conn, fresh.clone()).unwrap();
        assert_read_rows(&incremental, &fresh);
        assert_read_rows(&groups, &fresh_groups);
        eprintln!(
            "save {n}: post={post:?} get={get:?} needs_review={} revision={}",
            page.body["total"], result.body["revision"]
        );
    }
}

#[test]
fn incremental_refresh_preserves_suit_and_money_component_truth() {
    use crate::lab::gameplay::crop_mask::{from_resolved_panels, Rect, SourcePanel};
    let panel = |x| Rect {
        x,
        y: 0.,
        width: 6.,
        height: 6.,
    };
    let scalar =
        from_resolved_panels(SourcePanel::ChipColumnsValue, [0., 0.], &[panel(0.)]).unwrap();
    let split = from_resolved_panels(
        SourcePanel::ChipColumnsValue,
        [0., 0.],
        &[panel(0.), panel(20.)],
    )
    .unwrap();
    let region = |id: &str, x| json!({"id":id,"presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1"},"bounds":{"x":x,"y":2,"width":6,"height":6}});
    let mut bet = region("seats[0].bet", 2);
    bet["crop_mask"] = json!(scalar);
    let cases = [
        (
            json!([
                region("community_cards[0].suit", 2),
                region("seats[4].cards[1].suit", 22)
            ]),
            json!({"community_cards[0].suit":"c","seats[4].cards[1].suit":"c"}),
            "community_cards[0].suit",
            "s",
        ),
        (
            json!([bet,{"id":"split_pot","bounds":{"x":2,"y":2,"width":26,"height":6},"crop_mask":split}]),
            json!({"seats[0].bet":"S 2 BB","split_pot":"S 2 BB S 2 BB"}),
            "split_pot",
            "S 3 BB S 3 BB",
        ),
    ];
    for (regions, labels, target, label) in cases {
        let (_dir, service) = fixture();
        fs::write(
            service.gameplay_ai.config.join("gameplay-regions.json"),
            json!({"viewport":{"width":40,"height":20},"regions":regions}).to_string(),
        )
        .unwrap();
        let store = service.gameplay.evidence_store().unwrap();
        let settings = json!({"regions":{}});
        let session = store
            .create("fixture", 1000, "Fixture", &settings, "fixture")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut image = RgbImage::from_pixel(40, 20, Rgb([20, 20, 20]));
        for x in [4, 24] {
            image.put_pixel(x, 4, Rgb([255, 255, 255]));
            image.put_pixel(x + 1, 5, Rgb([200, 210, 220]));
        }
        let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
        let results: serde_json::Map<String, Value> = labels
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), json!({"prediction":{"text":value}})))
            .collect();
        store
            .admit(
                &session,
                &png,
                40,
                20,
                "2026-11-14T00:00:00Z",
                &settings,
                "fixture",
                &json!(results),
                "12345678",
                &json!({}),
            )
            .unwrap();
        service
            .ai_review
            .ensure(&service.gameplay_ai.context)
            .unwrap();
        let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
        let run = prepared["run_id"].as_str().unwrap();
        let (before, _) = service.gameplay_ai.read_snapshot(run).unwrap();
        let item = before
            .iter()
            .find(|item| item["region_id"] == target)
            .unwrap();
        service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":item["revision"],"action":"manual","label":label})).unwrap();
        let (incremental, grouped) = service.gameplay_ai.read_snapshot(run).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert!(service
            .gameplay_ai
            .read_snapshot
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|cached| cached.source == ReadSource::read(&conn).unwrap()
                && Arc::ptr_eq(&cached.items, &incremental)));
        let fresh = read_items(&conn, run).unwrap();
        let fresh_groups = cache::group_work(&conn, fresh.clone()).unwrap();
        assert_read_rows(&incremental, &fresh);
        assert_read_rows(&grouped, &fresh_groups);
        if target == "split_pot" {
            assert!(
                conn.query_row(
                    "SELECT COUNT(*) FROM gameplay_ai_cache_components",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()
                    > 0
            );
        }
    }
}

#[test]
fn manual_refresh_does_not_publish_across_external_commit() {
    let (_dir, service) = fixture();
    let session = recording(&service);
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let (old, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    let item = old[0].clone();
    let path = service
        .gameplay_ai
        .context
        .connection()
        .unwrap()
        .path()
        .unwrap()
        .to_owned();
    let id = item["id"].as_str().unwrap().to_owned();
    let target = id.clone();
    *service.gameplay_ai.manual_hook.lock().unwrap() = Some(Arc::new(move || {
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE gameplay_ai_occurrences SET reason='external post commit' WHERE id=?",
                [&target],
            )
            .unwrap();
    }));
    service.gameplay_ai.review(&service, &json!({"occurrence_id":id,"expected_revision":item["revision"],"action":"manual","label":"Q"})).unwrap();
    {
        let cached = service
            .gameplay_ai
            .read_snapshot
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        assert!(Arc::ptr_eq(&cached.items, &old));
        let current = ReadSource::read(&service.gameplay_ai.context.connection().unwrap()).unwrap();
        assert!(cached.source != current);
    }
    let (result, groups) = service.gameplay_ai.read_snapshot(run).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let fresh = read_items(&conn, run).unwrap();
    assert_read_rows(&groups, &cache::group_work(&conn, fresh.clone()).unwrap());
    assert_read_rows(&result, &fresh);
    assert!(!Arc::ptr_eq(&old, &result));
}

#[test]
fn manual_refresh_updates_cached_other_run_sharing_alias() {
    let (_dir, service) = fixture();
    let first_session = recording(&service);
    let first = service
        .gameplay_ai
        .prepare(&service, &first_session)
        .unwrap();
    let second_session = recording(&service);
    let second = service
        .gameplay_ai
        .prepare(&service, &second_session)
        .unwrap();
    let first_run = first["run_id"].as_str().unwrap();
    let second_run = second["run_id"].as_str().unwrap();
    let (old, _) = service.gameplay_ai.read_snapshot(first_run).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let other = read_items(&conn, second_run).unwrap().remove(0);
    drop(conn);
    service.gameplay_ai.review(&service, &json!({"occurrence_id":other["id"],"expected_revision":other["revision"],"action":"manual","label":"Q"})).unwrap();
    {
        let source = ReadSource::read(&service.gameplay_ai.context.connection().unwrap()).unwrap();
        let cache = service.gameplay_ai.read_snapshot.lock().unwrap();
        assert!(cache
            .as_ref()
            .is_some_and(|s| s.source == source && !Arc::ptr_eq(&s.items, &old)));
    }
    let (current, groups) = service.gameplay_ai.read_snapshot(first_run).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert!(service
        .gameplay_ai
        .read_snapshot
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(
            |s| s.source == ReadSource::read(&conn).unwrap() && Arc::ptr_eq(&s.items, &current)
        ));
    let fresh = read_items(&conn, first_run).unwrap();
    assert_read_rows(&groups, &cache::group_work(&conn, fresh.clone()).unwrap());
    assert_read_rows(&current, &fresh);
    assert!(!Arc::ptr_eq(&old, &current));
}
