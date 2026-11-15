use super::*;
use crate::lab::ai_review::AiReviewManager;
use image::{DynamicImage, Rgb, RgbImage};
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture(regions: Value, label: &str) -> (tempfile::TempDir, LabService, Arc<AtomicUsize>) {
    let directory = tempfile::tempdir().unwrap();
    let mut service = LabService::open_with_paths(
        directory.path().join("data"),
        directory.path().join("config"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        Default::default(),
    )
    .unwrap();
    fs::write(
        service.gameplay_ai.config.join("gameplay-regions.json"),
        json!({"viewport":{"width":40,"height":20},"regions":regions}).to_string(),
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let label = label.to_owned();
    service.ai_review = Arc::new(AiReviewManager::with_transport(
        service.registry.clone(),
        Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"model":"fixture","output_text":json!({"items":[{"id":"0","text":label,"clarity":"clear","reason":"fixture"}]}).to_string()}),
            )
        }),
        false,
    ));
    service
        .ai_review
        .configure(&json!({"api_key":"fixture","model":"fixture"}))
        .unwrap();
    (directory, service, calls)
}
fn region(id: &str, x: u32) -> Value {
    json!({"id":id,"presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}},"card_target_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]},"bounds":{"x":x,"y":2,"width":6,"height":6}})
}
fn record(service: &LabService, labels: Value) -> String {
    let store = service.gameplay.evidence_store().unwrap();
    let settings = json!({"regions":{}});
    let id = store
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
    let results = labels
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                json!({"prediction":{"text":value,"model_version":"original-model"}}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    store
        .admit(
            &id,
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
    id
}
fn run(service: &LabService, session: &str) -> Value {
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(service, session).unwrap();
    let started=service.gameplay_ai.start(service,&json!({"session_id":session,"run_id":prepared["run_id"],"max_requests":4,"auto_correct":true})).unwrap();
    if let Some(job) = started["job"]["id"].as_str() {
        service
            .ai_review
            .run_fixture(&service.gameplay_ai.context, job);
    }
    prepared
}

#[test]
fn table_line_ai_and_manual_truth_reuse_the_canonical_region_contract() {
    let original = "Tigard #17, NLHE - S 0.01/0.02";
    let corrected = "Tennessee #12345, NLHE - S 0.01/0.02";
    let (_directory, service, calls) = fixture(json!([region("table.info", 2)]), original);
    let first = record(&service, json!({"table.info": original}));
    let prepared = run(&service, &first);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let item = read_items(
        &service.gameplay_ai.context.connection().unwrap(),
        prepared["run_id"].as_str().unwrap(),
    )
    .unwrap()
    .remove(0);
    assert_eq!(item["state"], "unchanged");
    service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":item["id"],"expected_revision":item["revision"],"action":"manual","label":corrected}),
        )
        .unwrap();
    let second = record(&service, json!({"table.info": original}));
    let prepared = service.gameplay_ai.prepare(&service, &second).unwrap();
    assert_eq!(prepared["scope"]["exact_cache_hits"], 1);
    let items = read_items(
        &service.gameplay_ai.context.connection().unwrap(),
        prepared["run_id"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(items[0]["label"], corrected);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn exact_cross_seat_reuse_survives_prediction_profile_and_service_restart() {
    let (directory, service, calls) = fixture(
        json!([region("seats[0].bet", 2), region("seats[8].bet", 22)]),
        "S 2 BB",
    );
    let first = record(
        &service,
        json!({"seats[0].bet":"S 2 BB","seats[8].bet":"S 3 BB"}),
    );
    let prepared = run(&service, &first);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(items[0]["state"], "unchanged");
    assert_eq!(items[1]["state"], "corrected");
    assert_eq!(items[1]["original_label"], "S 3 BB");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM queue_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(conn);
    drop(service);
    let service = LabService::open_with_paths(
        directory.path().join("data"),
        directory.path().join("config"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        Default::default(),
    )
    .unwrap();
    fs::write(service.gameplay_ai.config.join("gameplay-regions.json"),json!({"viewport":{"width":40,"height":20},"model_revision":"changed","regions":[region("seats[3].bet",2),region("seats[7].bet",22)]}).to_string()).unwrap();
    let second = record(
        &service,
        json!({"seats[3].bet":"S 9 BB","seats[7].bet":"S 2 BB"}),
    );
    let prepared = run(&service, &second);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(prepared["scope"]["exact_cache_hits"], 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_attempts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap()[0]["label"],
        "S 2 BB"
    );
}

#[test]
fn board_hero_and_seat_card_positions_share_rank_and_suit_families() {
    for (left, right, text) in [
        ("community_cards[0]", "seats[4].cards[1]", "2"),
        ("community_cards[0].suit", "seats[4].cards[1].suit", "c"),
    ] {
        let (_directory, service, calls) =
            fixture(json!([region(left, 2), region(right, 22)]), text);
        let session = record(&service, json!({left:text,right:text}));
        let prepared = run(&service, &session);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(prepared["scope"]["unique_crops"], 1);
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert!(read_items(&conn, prepared["run_id"].as_str().unwrap())
            .unwrap()
            .iter()
            .all(|item| item["state"] == "unchanged"));
    }
    assert_ne!(
        cache::identity("rank", "same"),
        cache::identity("suit", "same")
    );
    assert_ne!(
        cache::identity("rank", "same"),
        cache::identity("money_scalar", "same")
    );
}

fn money_regions() -> Value {
    use crate::lab::gameplay::crop_mask::{from_resolved_panels, Rect, SourcePanel};
    let scalar = from_resolved_panels(
        SourcePanel::ChipColumnsValue,
        [0., 0.],
        &[Rect {
            x: 0.,
            y: 0.,
            width: 6.,
            height: 6.,
        }],
    )
    .unwrap();
    let group = from_resolved_panels(
        SourcePanel::ChipColumnsValue,
        [0., 0.],
        &[
            Rect {
                x: 0.,
                y: 0.,
                width: 6.,
                height: 6.,
            },
            Rect {
                x: 20.,
                y: 0.,
                width: 6.,
                height: 6.,
            },
        ],
    )
    .unwrap();
    let mut bet = region("seats[0].bet", 2);
    bet["crop_mask"] = json!(scalar);
    json!([bet,{"id":"split_pot","bounds":{"x":2,"y":2,"width":26,"height":6},"crop_mask":group}])
}
#[test]
fn bet_and_each_ordered_split_component_share_one_pair_of_blind_reads() {
    let (_directory, service, calls) = fixture(money_regions(), "S 2 BB");
    let session = record(
        &service,
        json!({"seats[0].bet":"S 2 BB","split_pot":"S 2 BB S 2 BB"}),
    );
    let prepared = run(&service, &session);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(
        items
            .iter()
            .find(|item| item["region_id"] == "split_pot")
            .unwrap()["label"],
        "S 2 BB S 2 BB"
    );
    assert!(items.iter().all(|item| item["state"] == "unchanged"));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_review_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(DISTINCT component_key) FROM gameplay_ai_cache_components",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn verified_ordered_list_seeds_scalar_only_with_exact_component_correspondence() {
    let (_directory, service, calls) = fixture(money_regions(), "S 2 BB");
    let session = record(
        &service,
        json!({"seats[0].bet":"S 9 BB","split_pot":"S 2 BB S 2 BB"}),
    );
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let split = read_items(&conn, prep["run_id"].as_str().unwrap())
        .unwrap()
        .into_iter()
        .find(|i| i["region_id"] == "split_pot")
        .unwrap();
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":split["id"],"expected_revision":0,"action":"manual","label":"S 2 BB S 2 BB"})).unwrap();
    let started = service
        .gameplay_ai
        .start(
            &service,
            &json!({"session_id":session,"run_id":prep["run_id"],"max_requests":4}),
        )
        .unwrap();
    assert_eq!(started["job"]["state"], "completed");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert!(items.iter().all(|i| i["label"]
        == if i["region_id"] == "split_pot" {
            "S 2 BB S 2 BB"
        } else {
            "S 2 BB"
        }));
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(cache::parse_money_list("S 2 B").is_none());
    assert!(cache::parse_money_list("2").is_none());
}

#[test]
fn old_alias_ids_human_conflicts_and_ambiguous_occurrences_stay_protected() {
    let (_directory, service, calls) = fixture(
        json!([region("seats[0].bet", 2), region("seats[8].bet", 22)]),
        "S 2 BB",
    );
    let session = record(
        &service,
        json!({"seats[0].bet":"S 2 BB","seats[8].bet":"S 3 BB"}),
    );
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let original = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    let key = original[0]["sample_key"].as_str().unwrap();
    conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at,active,reviewed,label,pixel_asset_sha) SELECT 'old-seat-alias','seats[8].bet',payload,crop,pixel_sha256,0,0,1,'S 3 BB',pixel_asset_sha FROM queue_items WHERE sample_key=?",[key]).unwrap();
    conn.execute(
        "UPDATE gameplay_ai_occurrences SET sample_key='old-seat-alias' WHERE id=?",
        [original[1]["id"].as_str().unwrap()],
    )
    .unwrap();
    cache::ensure(&conn).unwrap();
    let alias_id = conn
        .query_row(
            "SELECT queue_id FROM queue_items WHERE sample_key='old-seat-alias'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":original[0]["id"],"expected_revision":0,"action":"manual","label":"S 2 BB"})).unwrap();
    service.gameplay_ai.review(&service,&json!({"occurrence_id":original[1]["id"],"expected_revision":1,"action":"manual","label":"S 3 BB"})).unwrap();
    assert!(service.gameplay_ai.review(&service,&json!({"occurrence_id":original[0]["id"],"expected_revision":0,"action":"manual","label":"S 9 BB"})).is_err());
    let next = record(
        &service,
        json!({"seats[0].bet":"S 9 BB","seats[8].bet":"S 9 BB"}),
    );
    let nextprep = service.gameplay_ai.prepare(&service, &next).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, nextprep["run_id"].as_str().unwrap()).unwrap();
    assert!(items.iter().all(|i| i["state"] == "conflict"));
    assert_eq!(
        cache::group_work(&conn, items.clone()).unwrap()[0]["conflicting_labels"],
        json!(["S 2 BB", "S 3 BB"])
    );
    drop(conn);
    service
        .gameplay_ai
        .review(
            &service,
            &json!({"occurrence_id":items[0]["id"],"expected_revision":0,"action":"ambiguous"}),
        )
        .unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let old = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(old[0]["label"], "S 2 BB");
    assert_eq!(old[1]["label"], "S 3 BB");
    assert!(old.iter().all(|i| i["state"] == "manual"));
    let grouped = cache::group_work(&conn, old.clone()).unwrap();
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0]["state"], "conflict");
    assert_eq!(grouped[0]["reason"], "Conflicting manual readings");
    assert_eq!(
        grouped[0]["conflicting_labels"],
        json!(["S 2 BB", "S 3 BB"])
    );
    assert_eq!(grouped[0]["occurrence_count"], 2);
    assert_eq!(old[1]["sample_key"], "old-seat-alias");
    assert_eq!(
        conn.query_row(
            "SELECT queue_id FROM queue_items WHERE sample_key='old-seat-alias'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        alias_id
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM label_review_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn old_bare_money_truth_is_quarantined_and_exact_different_pixels_never_collide() {
    let (_directory, service, _calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prep = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, prep["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    let key = item["sample_key"].as_str().unwrap();
    conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) SELECT 'old-v4',0,0,queue_id,sample_key,region_id,'bet','2 BB',pixel_sha256,0,'unchanged','{\"label\":\"2 BB\"}' FROM queue_items WHERE sample_key=?",[key]).unwrap();
    assert!(matches!(
        cache::truth(&conn, key).unwrap(),
        cache::Truth::NeedsReview { .. }
    ));
    cache::coalesce_pending(&conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap()[0]["state"],
        "flagged"
    );
    let font = ab_glyph::FontArc::try_from_slice(include_bytes!("../ai_review/DejaVuSansMono.ttf"))
        .unwrap();
    for (left, right) in [
        ("2", "3"),
        ("6", "8"),
        ("2.0", "20"),
        ("BB", "B"),
        ("BB", "BE"),
        ("S", "G"),
        ("A", "a"),
        ("c", "s"),
    ] {
        let render = |text: &str| {
            let mut image = RgbImage::from_pixel(120, 40, Rgb([15, 33, 46]));
            imageproc::drawing::draw_text_mut(
                &mut image,
                Rgb([242, 242, 242]),
                8,
                4,
                ab_glyph::PxScale::from(28.),
                &font,
                text,
            );
            crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap()
        };
        let (a, b) = (render(left), render(right));
        assert!(
            !cache::strict_padding_equivalent(&a, &b),
            "{left} versus {right}"
        );
        assert_ne!(
            crate::lab::review::image_identity(&a).unwrap().1,
            crate::lab::review::image_identity(&b).unwrap().1
        );
    }
}

#[test]
fn uncertain_club_proposals_are_one_review_work_group_not_accepted_conflicts() {
    let regions = (0..5)
        .map(|i| region(&format!("community_cards[{i}].suit"), 2))
        .chain(std::iter::once(region("seats[0].cards[0].suit", 2)))
        .collect::<Vec<_>>();
    let (_directory, service, calls) = fixture(json!(regions), "c");
    let labels = (0..5)
        .map(|i| (format!("community_cards[{i}].suit"), json!("")))
        .chain(std::iter::once((
            "seats[0].cards[0].suit".into(),
            json!(""),
        )))
        .collect::<serde_json::Map<_, _>>();
    let session = record(&service, json!(labels));
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let before = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(before.len(), 6);
    assert!(before.iter().all(|item| item["state"] == "pending"));
    let key = before[0]["sample_key"].as_str().unwrap();
    conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) SELECT 'uncertain-club',0,0,queue_id,sample_key,region_id,'suit','',pixel_sha256,0,'flagged','{\"label\":\"\",\"proposed_label\":\"c\",\"reason\":\"Independent reading disagreed or was uncertain.\"}' FROM queue_items WHERE sample_key=?",[key]).unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert!(items.iter().all(|item| item["state"] == "flagged"
        && item["label"] == ""
        && item["proposed_text"] == "c"));
    cache::coalesce_pending(&conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let work = cache::group_work(&conn, items).unwrap();
    assert_eq!(work.len(), 1);
    assert_eq!(work[0]["occurrence_count"], 6);
    assert_eq!(work[0]["state"], "flagged");
    let group = work[0]["work_key"].clone();
    drop(conn);
    let request = |grouped: &str, cursor: &str| LabRequest {
        method: "GET".into(),
        path: "/api/gameplay/ai/items".into(),
        body: Value::Null,
        query: std::collections::BTreeMap::from([
            ("session_id".into(), session.clone()),
            ("grouped".into(), grouped.into()),
            ("work_key".into(), group.as_str().unwrap().into()),
            ("limit".into(), "2".into()),
            ("cursor".into(), cursor.into()),
        ]),
        headers: Default::default(),
    };
    let grouped = service
        .gameplay_ai
        .items(&service, &request("true", "0"))
        .unwrap();
    assert_eq!(grouped["total"], 1);
    assert_eq!(grouped["grouped"], true);
    let ungrouped = service
        .gameplay_ai
        .items(&service, &request("false", "0"))
        .unwrap();
    assert_eq!(ungrouped["total"], 6);
    assert_eq!(ungrouped["items"].as_array().unwrap().len(), 2);
    assert_eq!(ungrouped["hasMore"], true);
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["counts"]["needs_review"], 6);
    assert_eq!(status["group_counts"]["needs_review"], 1);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    for (job, label) in [("accepted-c", "c"), ("accepted-d", "d")] {
        conn.execute("INSERT INTO gameplay_ai_runs(run_id,session_id,profile_id,scope,job_id,created_at) VALUES(?,'fixture','fixture',?,?,0)",params![job,json!({"validation_sha256":sha256(crate::labels::CONTRACT_BYTES)}).to_string(),job]).unwrap();
        conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) SELECT ?,0,0,queue_id,sample_key,region_id,'suit','',pixel_sha256,0,'corrected',? FROM queue_items WHERE sample_key=?",params![job,json!({"label":label,"pixel_sha256":conn.query_row("SELECT pixel_sha256 FROM queue_items WHERE sample_key=?",[before[0]["sample_key"].as_str().unwrap()],|r|r.get::<_,String>(0)).unwrap(),"first_reading":{"text":label,"clarity":"clear"},"verification":{"text":label,"clarity":"clear"}}).to_string(),before[0]["sample_key"].as_str().unwrap()]).unwrap();
    }
    assert!(matches!(
        cache::truth(&conn, before[0]["sample_key"].as_str().unwrap()).unwrap(),
        cache::Truth::Blocked(_)
    ));
    assert_eq!(
        conn.query_row(
            "SELECT state FROM ai_review_items WHERE job_id='uncertain-club'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "flagged"
    );
}

#[test]
fn absent_occurrences_have_no_queue_or_payload_and_manual_conflicts_stay_visible() {
    let (_directory, service, calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, run).unwrap().remove(0);
    let queue_before: i64 = conn
        .query_row("SELECT count(*) FROM queue_items", [], |r| r.get(0))
        .unwrap();
    let assets_before: i64 = conn
        .query_row("SELECT count(*) FROM pixel_assets", [], |r| r.get(0))
        .unwrap();
    let presence = json!({"state":"absent","reason":"Source field hidden","policy":super::super::presence::POLICY});
    let bounds = json!({"x":0,"y":0,"width":0,"height":0});
    let frame = item["frame_id"].as_str().unwrap();
    assert!(!cache::record_absence(
        &conn,
        "absent-unique",
        run,
        &session,
        frame,
        "seats[1].bet",
        "bet",
        "presence-profile",
        &bounds,
        &json!({"text":""}),
        &presence
    )
    .unwrap());
    assert!(!cache::record_absence(
        &conn,
        "absent-unique",
        run,
        &session,
        frame,
        "seats[1].bet",
        "bet",
        "presence-profile",
        &bounds,
        &json!({"text":""}),
        &presence
    )
    .unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        queue_before
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        assets_before
    );
    let projected = read_items(&conn, run).unwrap();
    assert_eq!(
        projected.iter().filter(|v| v["state"] == "absent").count(),
        1
    );
    assert_eq!(cache::group_work(&conn, projected).unwrap().len(), 1);
    let summary = verification_summary("fixture", ["absent", "manual"].into_iter());
    assert_eq!(summary["total"], 1);
    assert_eq!(summary["absent_count"], 1);
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":"S 2 BB"})).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let profile: String = conn
        .query_row(
            "SELECT profile_id FROM gameplay_ai_occurrences WHERE id=?",
            [item["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(cache::record_absence(
        &conn,
        item["id"].as_str().unwrap(),
        run,
        &session,
        frame,
        "seats[0].bet",
        "bet",
        &profile,
        &bounds,
        &json!({"text":""}),
        &presence
    )
    .unwrap());
    let projected = read_items(&conn, run).unwrap();
    let protected = projected.iter().find(|v| v["id"] == item["id"]).unwrap();
    assert_eq!(protected["state"], "ambiguous");
    assert_eq!(protected["label"], "S 2 BB");
    assert_eq!(protected["sample_key"], item["sample_key"]);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM gameplay_ai_decisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
#[ignore = "requires the read-only source-controlled 158-crop evidence corpus"]
fn real_source_bet_split_share_one_fake_request_and_keep_original_crops_after_restart() {
    let manifest: Value = serde_json::from_slice(
        &fs::read("/tmp/poker-cache-source-fixtures/manifest-final.json").unwrap(),
    )
    .unwrap();
    let entries = manifest["entries"].as_array().unwrap();
    let choose = |role: &str, w: u32| {
        entries
            .iter()
            .find(|e| {
                e["role"] == role
                    && e["expected_transcription"] == "S 2 BB"
                    && e["opacity"] == 1
                    && image::image_dimensions(e["crop_path"].as_str().unwrap())
                        .unwrap()
                        .0
                        == w
            })
            .unwrap()
            .clone()
    };
    let (bet, split) = (choose("bet", 99), choose("split_pot", 96));
    let (directory, service, calls) = fixture(json!([]), "S 2 BB");
    let images = [&bet, &split].map(|e| {
        image::open(e["crop_path"].as_str().unwrap())
            .unwrap()
            .to_rgb8()
    });
    assert!(
        cache::money_shape::equivalent(
            &cache::money_shape::extract(&images[0], &bet["crop_mask"]).unwrap(),
            &cache::money_shape::extract(&images[1], &split["crop_mask"]).unwrap()
        ),
        "selected source pair must have registered equal glyph channels"
    );
    let regions = json!([{"id":"seats[0].bet","bounds":{"x":0,"y":0,"width":99,"height":35},"crop_mask":bet["crop_mask"]},{"id":"split_pot","bounds":{"x":130,"y":0,"width":96,"height":29},"crop_mask":split["crop_mask"]}]);
    fs::write(
        service.gameplay_ai.config.join("gameplay-regions.json"),
        json!({"viewport":{"width":240,"height":50},"regions":regions}).to_string(),
    )
    .unwrap();
    let mut frame = RgbImage::from_pixel(240, 50, Rgb([15, 33, 46]));
    let raw_images = [&bet, &split].map(|e| {
        let source = image::open(e["frame_path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        let b = &e["bounds"];
        image::imageops::crop_imm(
            &source,
            b["x"].as_u64().unwrap() as u32,
            b["y"].as_u64().unwrap() as u32,
            b["width"].as_u64().unwrap() as u32,
            b["height"].as_u64().unwrap() as u32,
        )
        .to_image()
    });
    image::imageops::replace(&mut frame, &raw_images[0], 0, 0);
    image::imageops::replace(&mut frame, &raw_images[1], 130, 0);
    let store = service.gameplay.evidence_store().unwrap();
    let settings = json!({"regions":{}});
    let session = store
        .create("fixture", 1000, "Source fixture", &settings, "fixture")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    store.admit(&session,&crate::media::png(&DynamicImage::ImageRgb8(frame)).unwrap(),240,50,"2026-11-14T00:00:00Z",&settings,"fixture",&json!({"seats[0].bet":{"prediction":{"text":"S 2 BB"}},"split_pot":{"prediction":{"text":"S 9 BB"}}}),"12345678",&json!({})).unwrap();
    {
        let conn = service.gameplay_ai.context.connection().unwrap();
        cache::enable_normalized(&conn).unwrap();
    }
    let probe = service.gameplay_ai.prepare(&service, &session).unwrap();
    {
        let conn = service.gameplay_ai.context.connection().unwrap();
        let active: i64 = conn
            .query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let rows = conn
            .prepare("SELECT region_id,payload FROM queue_items")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let features: i64 = conn
            .query_row(
                "SELECT count(*) FROM gameplay_ai_cache_normalized",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            active, 1,
            "one scalar claim expected: {}; {:?}; normalized={features}",
            probe, rows
        );
    }
    let prepared = run(&service, &session);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| i["label"] == "S 2 BB"));
    assert_eq!(
        items
            .iter()
            .find(|i| i["region_id"] == "seats[0].bet")
            .unwrap()["state"],
        "unchanged"
    );
    assert_eq!(
        items
            .iter()
            .find(|i| i["region_id"] == "split_pot")
            .unwrap()["state"],
        "corrected"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ai_review_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(DISTINCT component_key) FROM gameplay_ai_cache_components",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    for item in &items {
        let ctx = cache::context(&conn, item["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let png = cache::context_crop(&conn, &ctx, vec![]).unwrap();
        let expected = if item["region_id"] == "split_pot" {
            &images[1]
        } else {
            &images[0]
        };
        assert_eq!(image::load_from_memory(&png).unwrap().to_rgb8(), *expected);
    }
    drop(conn);
    drop(service);
    let reopened = LabService::open_with_paths(
        directory.path().join("data"),
        directory.path().join("config"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        Default::default(),
    )
    .unwrap();
    let repeated = reopened.gameplay_ai.prepare(&reopened, &session).unwrap();
    assert_eq!(repeated["run_id"], prepared["run_id"]);
    let conn = reopened.gameplay_ai.context.connection().unwrap();
    assert!(read_items(&conn, repeated["run_id"].as_str().unwrap())
        .unwrap()
        .iter()
        .all(|i| i["label"] == "S 2 BB"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn interrupted_preparation_restores_pending_components_from_skipped_frames() {
    let mut regions = money_regions();
    regions.as_array_mut().unwrap().remove(0);
    let (_directory, service, calls) = fixture(regions, "S 2 BB");
    let session = record(&service, json!({"split_pot":"S 2 BB S 2 BB"}));
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    {
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute("UPDATE queue_items SET active=0", []).unwrap();
        conn.execute(
            "UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','paused') WHERE run_id=?",
            [prepared["run_id"].as_str().unwrap()],
        )
        .unwrap();
    }
    let resumed = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(resumed["run_id"], prepared["run_id"]);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM queue_items WHERE region_id='split_pot' AND active=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn stop_preparation(service: &LabService, run: &str) -> LabResponse {
    service
        .gameplay_ai
        .handle(
            service,
            &LabRequest {
                method: "POST".into(),
                path: "/api/gameplay/ai/stop".into(),
                body: json!({"job_id":run}),
                query: Default::default(),
                headers: Default::default(),
            },
        )
        .unwrap()
}

#[test]
fn stop_recovers_orphaned_preparation_without_a_worker_or_provider_request() {
    let (_directory, service, calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    service.gameplay_ai.context.connection().unwrap().execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.phase','preparing') WHERE run_id=?",[run]).unwrap();
    let response = stop_preparation(&service, run);
    assert_eq!(response.body["job"]["state"], "paused");
    assert_eq!(response.body["job"]["preparation"]["inflight"], false);
    assert_eq!(
        response.body["job"]["preparation"]["pause_requested"],
        false
    );
    assert_eq!(
        stop_preparation(&service, run).body["job"]["state"],
        "paused"
    );
    let resumed = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(resumed["run_id"], prepared["run_id"]);
    assert_eq!(resumed["scope"]["phase"], "prepared");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn live_pause_rolls_back_partial_frame_and_resume_is_idempotent_without_spending() {
    let (_directory, service, calls) = fixture(
        json!([region("seats[0].bet", 2), region("seats[8].bet", 22)]),
        "S 2 BB",
    );
    let session = record(
        &service,
        json!({"seats[0].bet":"S 2 BB","seats[8].bet":"S 3 BB"}),
    );
    let reached = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let hook_reached = reached.clone();
    let hook_release = release.clone();
    *service.gameplay_ai.preparation_hook.lock().unwrap() = Some(Arc::new(move |index| {
        if index == 1 {
            hook_reached.wait();
            hook_release.wait();
        }
    }));
    std::thread::scope(|scope| {
        let preparing = scope.spawn(|| service.gameplay_ai.prepare(&service, &session).unwrap());
        reached.wait();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let run: String = conn
            .query_row(
                "SELECT run_id FROM gameplay_ai_runs ORDER BY created_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        let response = stop_preparation(&service, &run);
        assert_eq!(response.body["job"]["preparation"]["inflight"], true);
        assert_eq!(response.body["job"]["preparation"]["pause_requested"], true);
        release.wait();
        let paused = preparing.join().unwrap();
        assert_eq!(paused["scope"]["phase"], "paused");
        assert_eq!(paused["scope"]["processed_frames"], 0);
        assert_eq!(paused["scope"]["occurrences"], 0);
        let conn = service.gameplay_ai.context.connection().unwrap();
        for table in [
            "queue_items",
            "gameplay_ai_occurrences",
            "gameplay_ai_cache_aliases",
            "gameplay_ai_cache_context",
            "pixel_assets",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "partial {table} must rollback"
            );
        }
        drop(conn);
        *service.gameplay_ai.preparation_hook.lock().unwrap() = None;
        let resumed = service.gameplay_ai.prepare(&service, &session).unwrap();
        assert_eq!(resumed["run_id"], run);
        assert_eq!(resumed["scope"]["processed_frames"], 1);
        assert_eq!(resumed["scope"]["occurrences"], 2);
        assert_eq!(
            service.gameplay_ai.prepare(&service, &session).unwrap()["run_id"],
            run
        );
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM gameplay_ai_occurrences", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn unsupported_panel_has_frame_context_without_advertising_a_crop() {
    let mut unsupported = region("seats[0].bet", 2);
    unsupported["localization_error"] = json!("Panel is missing, merged, clipped, or ambiguous");
    let (_directory, service, calls) = fixture(json!([unsupported]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, prepared["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    assert_eq!(item["state"], "ambiguous");
    assert_eq!(item["crop_available"], false);
    assert!(item["crop_url"].is_null());
    assert!(item["image_url"].as_str().unwrap().contains("/frames/"));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn prepared_scope_switch_restores_pending_claims_and_stream_without_new_material_or_calls() {
    let (_directory, service, calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let a = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    let prepared_a = service.gameplay_ai.prepare(&service, &a).unwrap();
    let b = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    let root = service.gameplay.evidence_root().unwrap();
    let source = Connection::open(root.join("gameplay.sqlite3")).unwrap();
    let frame: String = source
        .query_row("SELECT id FROM frames WHERE session_id=?", [&b], |r| {
            r.get(0)
        })
        .unwrap();
    let path = root.join("frames").join(format!("{frame}.png"));
    let mut image = image::open(&path).unwrap().to_rgb8();
    image.put_pixel(4, 4, Rgb([93, 7, 181]));
    let png = crate::media::png(&DynamicImage::ImageRgb8(image)).unwrap();
    fs::write(path, &png).unwrap();
    source
        .execute(
            "UPDATE frames SET image_sha256=? WHERE id=?",
            params![sha256(&png), frame],
        )
        .unwrap();
    let prepared_b = service.gameplay_ai.prepare(&service, &b).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let key_a = read_items(&conn, prepared_a["run_id"].as_str().unwrap()).unwrap()[0]["sample_key"]
        .as_str()
        .unwrap()
        .to_owned();
    let key_b = read_items(&conn, prepared_b["run_id"].as_str().unwrap()).unwrap()[0]["sample_key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(key_a, key_b);
    let active = |conn: &Connection, key: &str| {
        conn.query_row(
            "SELECT active FROM queue_items WHERE sample_key=?",
            [key],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(active(&conn, &key_a), 0);
    assert_eq!(active(&conn, &key_b), 1);
    drop(conn);
    let queued_b=service.gameplay_ai.start(&service,&json!({"session_id":b,"run_id":prepared_b["run_id"],"max_requests":1,"auto_correct":true})).unwrap();
    assert!(service
        .gameplay_ai
        .prepare(&service, &a)
        .unwrap_err()
        .message
        .contains("Stop the active Gameplay review"));
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(active(&conn, &key_a), 0);
    assert_eq!(active(&conn, &key_b), 1);
    let current: String = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key='active_stream'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&current).unwrap(),
        prepared_b["run_id"]
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ai_review_attempts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(conn);
    service
        .ai_review
        .cancel(
            &service.gameplay_ai.context,
            queued_b["job"]["id"].as_str().unwrap(),
        )
        .unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let stream_key = format!("stream:{}", prepared_a["run_id"].as_str().unwrap());
    let old_stream: String = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key=?",
            [&stream_key],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "UPDATE queue_meta SET value='invalid' WHERE key=?",
        [&stream_key],
    )
    .unwrap();
    drop(conn);
    assert!(service.gameplay_ai.prepare(&service, &a).is_err());
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(active(&conn, &key_a), 0);
    assert_eq!(active(&conn, &key_b), 1);
    conn.execute(
        "UPDATE queue_meta SET value=? WHERE key=?",
        params![old_stream, stream_key],
    )
    .unwrap();
    drop(conn);
    *service.gameplay_ai.preparation_hook.lock().unwrap() = Some(Arc::new(|_| {
        panic!("prepared reactivation must not recrop")
    }));
    let repeated = service.gameplay_ai.prepare(&service, &a).unwrap();
    assert_eq!(repeated["run_id"], prepared_a["run_id"]);
    assert_eq!(repeated["scope"], prepared_a["scope"]);
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert_eq!(active(&conn, &key_a), 1);
    assert_eq!(active(&conn, &key_b), 0);
    let current: String = conn
        .query_row(
            "SELECT value FROM queue_meta WHERE key='active_stream'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&current).unwrap(),
        prepared_a["run_id"]
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM gameplay_ai_occurrences", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(conn);
    let started=service.gameplay_ai.start(&service,&json!({"session_id":a,"run_id":prepared_a["run_id"],"max_requests":1,"auto_correct":true})).unwrap();
    assert!(started["job"]["id"].is_string());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn frame_only_manual_readings_preserve_raw_predictions_and_stay_occurrence_owned_after_restart() {
    let mut left = region("community_cards[0]", 2);
    left["localization_error"] = json!("Target cannot be isolated");
    let mut right = region("seats[4].cards[1]", 22);
    right["localization_error"] = json!("Target cannot be isolated");
    let (directory, service, calls) = fixture(json!([left, right]), "A");
    let session = record(
        &service,
        json!({"community_cards[0]":"A","seats[4].cards[1]":"A"}),
    );
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let original = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    let raw_before = conn
        .prepare("SELECT original_prediction FROM gameplay_ai_occurrences ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    // Simulate an existing occurrence from before per-frame anchors were recorded.
    conn.execute(
        "DELETE FROM gameplay_ai_cache_context WHERE occurrence_id=?",
        [original[0]["id"].as_str().unwrap()],
    )
    .unwrap();
    drop(conn);
    for (item, label) in original.iter().zip(["Q", "J"]) {
        let result=service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":label})).unwrap();
        assert_eq!(result["affected_count"], 1);
        assert_eq!(result["revision"], 1);
        assert_eq!(result["item"]["state"], "manual");
        assert_eq!(result["item"]["label"], label);
        assert_eq!(result["item"]["review_evidence"]["source"], "manual_frame");
        assert_eq!(result["item"]["review_evidence"]["frame"]["width"], 40);
        assert!(result["item"]["crop_url"].is_null());
    }
    assert!(service.gameplay_ai.review(&service,&json!({"occurrence_id":original[0]["id"],"expected_revision":0,"action":"manual","label":"K"})).is_err());
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["counts"]["manual"], 2);
    assert_eq!(status["counts"]["pending"], 0);
    assert_eq!(status["counts"]["frames_completed"], 1);
    let conn = service.gameplay_ai.context.connection().unwrap();
    for table in [
        "queue_items",
        "review_samples",
        "label_review_events",
        "gameplay_ai_manual",
        "gameplay_ai_cache_aliases",
        "pixel_assets",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "no fabricated crop truth in {table}"
        );
    }
    let raw_after = conn
        .prepare("SELECT original_prediction FROM gameplay_ai_occurrences ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(raw_before, raw_after);
    assert_eq!(
        cache::group_work(
            &conn,
            read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap()
        )
        .unwrap()
        .len(),
        2
    );
    drop(conn);
    drop(service);
    let service = LabService::open_with_paths(
        directory.path().join("data"),
        directory.path().join("config"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker"),
        Default::default(),
    )
    .unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let restored = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(restored[0]["label"], "Q");
    assert_eq!(restored[1]["label"], "J");
    assert!(restored
        .iter()
        .all(|i| i["revision"] == 1 && i["state"] == "manual"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn frame_only_manual_requires_original_available_hash_and_dimensions_even_without_old_anchor() {
    for failure in [
        "missing",
        "changed",
        "metadata_changed",
        "dimensions_changed",
    ] {
        let mut region = region("seats[0].bet", 2);
        region["localization_error"] = json!("Target cannot be isolated");
        let (_directory, service, calls) = fixture(json!([region]), "S 2 BB");
        let session = record(&service, json!({"seats[0].bet":"S 9 BB"}));
        let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
        let conn = service.gameplay_ai.context.connection().unwrap();
        let item = read_items(&conn, prepared["run_id"].as_str().unwrap())
            .unwrap()
            .remove(0);
        conn.execute(
            "DELETE FROM gameplay_ai_cache_context WHERE occurrence_id=?",
            [item["id"].as_str().unwrap()],
        )
        .unwrap();
        drop(conn);
        let root = service.gameplay.evidence_root().unwrap();
        let path = root
            .join("frames")
            .join(format!("{}.png", item["frame_id"].as_str().unwrap()));
        let source = Connection::open(root.join("gameplay.sqlite3")).unwrap();
        match failure {
            "missing" => fs::remove_file(&path).unwrap(),
            "changed" | "metadata_changed" => {
                let bytes = crate::media::png(&DynamicImage::ImageRgb8(RgbImage::from_pixel(
                    40,
                    20,
                    Rgb([0, 0, 0]),
                )))
                .unwrap();
                fs::write(&path, &bytes).unwrap();
                if failure == "metadata_changed" {
                    source
                        .execute(
                            "UPDATE frames SET image_sha256=? WHERE id=?",
                            params![sha256(&bytes), item["frame_id"].as_str().unwrap()],
                        )
                        .unwrap();
                    let fresh = service.gameplay_ai.prepare(&service, &session).unwrap();
                    assert_ne!(fresh["run_id"], prepared["run_id"]);
                }
            }
            _ => {
                source
                    .execute(
                        "UPDATE frames SET width=41 WHERE id=?",
                        [item["frame_id"].as_str().unwrap()],
                    )
                    .unwrap();
            }
        }
        assert!(service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":"S 2 BB"})).is_err(),"{failure}");
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM gameplay_ai_decisions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap()[0]["revision"],
            0
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn preparation_lease_rejection_does_not_begin_scope_or_spend() {
    if std::env::var_os("POKER_PREPARATION_LEASE_REJECTION_CHILD").is_none() {
        let result=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","lab::gameplay::ai::evidence_cache_tests::preparation_lease_rejection_does_not_begin_scope_or_spend","--nocapture"])
            .env("POKER_PREPARATION_LEASE_REJECTION_CHILD","1").env("POKER_LAB_LAUNCHER_NODE","/missing/fixture-node").env_remove("POKER_LAB_LAUNCHER_PATH").env_remove("POKER_LAB_GIT_DIR").output().unwrap();
        assert!(
            result.status.success(),
            "child must reject before work: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let (_directory, service, calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 2 BB"}));
    assert!(service
        .gameplay_ai
        .prepare(&service, &session)
        .unwrap_err()
        .message
        .contains("partially configured"));
    let conn = service.gameplay_ai.context.connection().unwrap();
    for table in [
        "gameplay_ai_runs",
        "gameplay_ai_occurrences",
        "queue_items",
        "ai_review_attempts",
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "no preparation side effects in {table}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(service.gameplay_ai.context.operation.try_lock().is_ok());
}

#[test]
fn frame_only_manual_verifies_original_scope_before_presence_and_normalization_policies() {
    let mut region = region("seats[0].bet", 2);
    region["localization_error"] = json!("Target cannot be isolated");
    let (_directory, service, calls) = fixture(json!([region]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 9 BB"}));
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, prepared["run_id"].as_str().unwrap())
        .unwrap()
        .remove(0);
    conn.execute(
        "DELETE FROM gameplay_ai_cache_context WHERE occurrence_id=?",
        [item["id"].as_str().unwrap()],
    )
    .unwrap();
    let source = Connection::open_with_flags(
        service
            .gameplay
            .evidence_root()
            .unwrap()
            .join("gameplay.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let frames=source.prepare("SELECT id,width,height,image_sha256,results_json FROM frames WHERE session_id=? ORDER BY captured_at,id").unwrap().query_map([&session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,u32>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let mut scope = prepared["scope"].clone();
    scope.as_object_mut().unwrap().remove("presence_policy");
    scope.as_object_mut().unwrap().remove("review_policy");
    scope
        .as_object_mut()
        .unwrap()
        .remove("normalization_policy");
    scope["source_scope_sha"] = json!(sha256(
        format!(
            "{}:{}:{}:{}:{frames:?}",
            cache::POLICY,
            scope["profile_id"].as_str().unwrap(),
            scope["selection_sha256"].as_str().unwrap(),
            scope["validation_sha256"].as_str().unwrap()
        )
        .as_bytes()
    ));
    conn.execute(
        "UPDATE gameplay_ai_runs SET scope=? WHERE run_id=?",
        params![scope.to_string(), prepared["run_id"].as_str().unwrap()],
    )
    .unwrap();
    drop(conn);
    let result=service.gameplay_ai.review(&service,&json!({"occurrence_id":item["id"],"expected_revision":0,"action":"manual","label":"S 2 BB"})).unwrap();
    assert_eq!(result["item"]["state"], "manual");
    assert_eq!(result["item"]["review_evidence"]["source"], "manual_frame");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn card_rank_and_suit_ignore_obsolete_presence_absence_and_ambiguity() {
    let mut rank = region("community_cards[0]", 2);
    rank["presence"] = json!({"state":"absent","policy":"source_pixel_presence_v1","reason":"Old pixel classifier","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}});
    let mut suit = region("community_cards[0].suit", 22);
    suit["presence"] = json!({"state":"ambiguous","policy":"source_pixel_presence_v1","reason":"Old pixel classifier","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}});
    let (_directory, service, calls) = fixture(json!([rank, suit]), "2");
    let session = record(
        &service,
        json!({"community_cards[0]":"2","community_cards[0].suit":"c"}),
    );
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    assert_eq!(
        prepared["scope"]["presence_policy"],
        super::super::presence::POLICY
    );
    assert_ne!(
        prepared["scope"]["presence_policy"],
        "source_pixel_presence_v1"
    );
    assert_eq!(prepared["scope"]["absent_count"], 0);
    assert_eq!(prepared["scope"]["ambiguous"], 0);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|v| v["state"] == "pending" && v["crop_available"] == true));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn off_contract_human_override_stays_owned_and_compatible_pixels_require_review_without_repayment()
{
    let (_directory, service, calls) = fixture(
        json!([region("seats[0].status", 2), region("seats[8].status", 22)]),
        "Fold",
    );
    let session = record(
        &service,
        json!({"seats[0].status":"Fold","seats[8].status":"Fold"}),
    );
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let original = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    drop(conn);
    service.gameplay_ai.review(&service,&json!({"occurrence_id":original[0]["id"],"expected_revision":0,"action":"manual","label":"Waiting For Players"})).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, prepared["run_id"].as_str().unwrap()).unwrap();
    assert_eq!(items[0]["state"], "manual");
    assert_eq!(items[0]["label"], "Waiting For Players");
    assert_eq!(items[0]["schema_valid"], false);
    assert_eq!(items[1]["state"], "flagged");
    assert_eq!(items[1]["proposed_text"], "Waiting For Players");
    assert_eq!(items[1]["label"], "Fold");
    cache::coalesce_pending(&conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM queue_items WHERE active=1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(conn);
    let next = record(
        &service,
        json!({"seats[0].status":"Fold","seats[8].status":"Fold"}),
    );
    let repeated = service.gameplay_ai.prepare(&service, &next).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert!(read_items(&conn, repeated["run_id"].as_str().unwrap())
        .unwrap()
        .iter()
        .all(|i| i["state"] == "flagged" && i["proposed_text"] == "Waiting For Players"));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ai_review_attempts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM label_review_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn job_for(conn: &Connection, run: &Value) -> String {
    conn.query_row(
        "SELECT job_id FROM gameplay_ai_runs WHERE run_id=?",
        [run["run_id"].as_str().unwrap()],
        |r| r.get(0),
    )
    .unwrap()
}
fn apply_quarantine(conn: &mut Connection, job: &str) -> Value {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let receipt = quarantine::apply(&tx, job, "fixture audit").unwrap();
    tx.commit().unwrap();
    receipt
}

#[test]
fn quarantine_blocks_cross_seat_and_global_alias_truth_preserves_paid_evidence_and_resume() {
    let (directory, service, calls) = fixture(
        json!([region("seats[0].bet", 2), region("seats[8].bet", 22)]),
        "S 2 BB",
    );
    let session = record(
        &service,
        json!({"seats[0].bet":"S 3 BB","seats[8].bet":"S 4 BB"}),
    );
    let prep = run(&service, &session);
    let mut conn = service.gameplay_ai.context.connection().unwrap();
    let job = job_for(&conn, &prep);
    conn.execute(
        "UPDATE ai_review_jobs SET state='cancelled' WHERE id=?",
        [&job],
    )
    .unwrap();
    let before = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    let key = before[0]["sample_key"].as_str().unwrap();
    conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at,active,reviewed,label,pixel_asset_sha) SELECT 'global-alias','seats[5].bet',payload,crop,pixel_sha256,0,0,0,'S 9 BB',pixel_asset_sha FROM queue_items WHERE sample_key=?",[key]).unwrap();
    cache::ensure(&conn).unwrap();
    assert!(matches!(
        cache::truth(&conn, "global-alias").unwrap(),
        cache::Truth::Accepted { human: false, .. }
    ));
    let results: String = conn
        .query_row(
            "SELECT result FROM ai_review_items WHERE job_id=?",
            [&job],
            |r| r.get(0),
        )
        .unwrap();
    let batch: (String, String) = conn
        .query_row(
            "SELECT response,verification FROM ai_review_batches WHERE job_id=?",
            [&job],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let dry = quarantine::inspect(&conn, &job).unwrap();
    assert_eq!(dry["events_to_supersede"].as_array().unwrap().len(), 1);
    let receipt = apply_quarantine(&mut conn, &job);
    assert_eq!(receipt["applied"], true);
    assert_eq!(receipt["revised_occurrences"], 2);
    assert!(matches!(
        cache::truth(&conn, "global-alias").unwrap(),
        cache::Truth::NeedsReview { .. }
    ));
    let after = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
    for (old, new) in before.iter().zip(&after) {
        assert_eq!(new["state"], "flagged");
        assert_eq!(new["label"], new["original_label"]);
        assert!(new["revision"].as_i64().unwrap() > old["revision"].as_i64().unwrap());
    }
    assert_eq!(
        conn.query_row(
            "SELECT original_result FROM gameplay_ai_quarantine_items WHERE job_id=?",
            [&job],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        results
    );
    assert_eq!(
        conn.query_row(
            "SELECT response,verification FROM ai_review_batches WHERE job_id=?",
            [&job],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        )
        .unwrap(),
        batch
    );
    assert_eq!(
        conn.query_row(
            "SELECT reviewed FROM queue_items WHERE sample_key=?",
            [key],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(conn
        .execute(
            "UPDATE ai_review_jobs SET state='queued' WHERE id=?",
            [&job]
        )
        .is_err());
    assert!(conn
        .execute(
            "DELETE FROM gameplay_ai_job_quarantines WHERE job_id=?",
            [&job]
        )
        .is_err());
    let revisions = after
        .iter()
        .map(|i| i["revision"].clone())
        .collect::<Vec<_>>();
    assert_eq!(apply_quarantine(&mut conn, &job)["applied"], false);
    assert_eq!(
        read_items(&conn, prep["run_id"].as_str().unwrap())
            .unwrap()
            .iter()
            .map(|i| i["revision"].clone())
            .collect::<Vec<_>>(),
        revisions
    );
    drop(conn);
    let resume = LabRequest {
        method: "POST".into(),
        path: "/api/gameplay/ai/resume".into(),
        body: json!({"job_id":job}),
        query: Default::default(),
        headers: Default::default(),
    };
    assert!(service.gameplay_ai.handle(&service, &resume).is_err());
    assert!(service
        .ai_review
        .resume(&service.gameplay_ai.context, &job)
        .is_err());
    assert!(service.gameplay_ai.start(&service,&json!({"run_id":prep["run_id"],"session_id":session,"repair_occurrence_ids":[before[0]["id"]]})).is_err());
    let status = service.gameplay_ai.status(&service, &session).unwrap();
    assert_eq!(status["state"], "quarantined");
    assert_eq!(status["quarantined"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let path = directory.path().join("data/ocr-evidence.sqlite3");
    let mut reopened = Connection::open(path).unwrap();
    assert!(quarantine::contains(&reopened, &job).unwrap());
    assert_eq!(apply_quarantine(&mut reopened, &job)["applied"], false);
}

#[test]
fn quarantine_protects_human_conflicts_and_other_job_accepted_truth() {
    for human in [false, true] {
        let (_directory, service, calls) = fixture(
            json!([region("seats[0].bet", 2), region("seats[8].bet", 22)]),
            "S 2 BB",
        );
        let session = record(
            &service,
            json!({"seats[0].bet":"S 3 BB","seats[8].bet":"S 4 BB"}),
        );
        let prep = run(&service, &session);
        let mut conn = service.gameplay_ai.context.connection().unwrap();
        let job = job_for(&conn, &prep);
        conn.execute(
            "UPDATE ai_review_jobs SET state='cancelled' WHERE id=?",
            [&job],
        )
        .unwrap();
        let items = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
        if human {
            for (item, label) in items.iter().zip(["S 7 BB", "S 8 BB"]) {
                conn.execute("INSERT INTO gameplay_ai_decisions(occurrence_id,sample_key,label,state,created_at) VALUES(?,?,?,'manual',0)",params![item["id"].as_str().unwrap(),item["sample_key"].as_str().unwrap(),label]).unwrap();
            }
        } else {
            conn.execute("INSERT INTO gameplay_ai_runs(run_id,session_id,profile_id,scope,job_id,created_at) SELECT 'other-run',session_id,profile_id,scope,'other-job',0 FROM gameplay_ai_runs WHERE job_id=?",[&job]).unwrap();
            conn.execute("INSERT INTO ai_review_items SELECT 'other-job',ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,prior_prediction_id,pixel_sha256,prior_event_id,state,result FROM ai_review_items WHERE job_id=?",[&job]).unwrap();
        }
        apply_quarantine(&mut conn, &job);
        let after = read_items(&conn, prep["run_id"].as_str().unwrap()).unwrap();
        if human {
            assert_eq!(after[0]["state"], "manual");
            assert_eq!(after[1]["state"], "manual");
            assert_eq!(after[0]["label"], "S 7 BB");
            assert_eq!(after[1]["label"], "S 8 BB");
            assert!(matches!(
                cache::truth(&conn, after[0]["sample_key"].as_str().unwrap()).unwrap(),
                cache::Truth::Blocked(_)
            ));
        } else {
            assert!(after
                .iter()
                .all(|i| i["state"] == "corrected" && i["label"] == "S 2 BB"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

#[test]
fn automatic_truth_requires_current_contract_pixels_localization_and_matching_blind_reads() {
    let (_directory, service, calls) = fixture(json!([region("seats[0].bet", 2)]), "S 2 BB");
    let session = record(&service, json!({"seats[0].bet":"S 3 BB"}));
    let prep = run(&service, &session);
    let conn = service.gameplay_ai.context.connection().unwrap();
    let job = job_for(&conn, &prep);
    let key: String = conn
        .query_row(
            "SELECT sample_key FROM ai_review_items WHERE job_id=?",
            [&job],
            |r| r.get(0),
        )
        .unwrap();
    let raw: String = conn
        .query_row(
            "SELECT result FROM ai_review_items WHERE job_id=?",
            [&job],
            |r| r.get(0),
        )
        .unwrap();
    let original: Value = serde_json::from_str(&raw).unwrap();
    for second in [
        Value::Null,
        json!({"clarity":"uncertain","text":"S 2 BB"}),
        json!({"clarity":"clear","text":"S 3 BB"}),
    ] {
        let mut invalid = original.clone();
        invalid["verification"] = second;
        conn.execute(
            "UPDATE ai_review_items SET result=? WHERE job_id=?",
            params![invalid.to_string(), job],
        )
        .unwrap();
        assert!(matches!(
            cache::truth(&conn, &key).unwrap(),
            cache::Truth::NeedsReview { .. }
        ));
    }
    conn.execute(
        "UPDATE ai_review_items SET result=? WHERE job_id=?",
        params![raw, job],
    )
    .unwrap();
    for (sql,restore) in [
        ("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.validation_sha256','old')","UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.validation_sha256',?1)"),
        ("UPDATE ai_review_items SET pixel_sha256='wrong'","UPDATE ai_review_items SET pixel_sha256=?1"),
        ("UPDATE queue_items SET payload=json_set(payload,'$.localization_error','untrusted')","UPDATE queue_items SET payload=json_remove(payload,'$.localization_error') WHERE ?1 IS NOT NULL")
    ] {
        let pixels:String=conn.query_row("SELECT pixel_sha256 FROM queue_items WHERE sample_key=?",[&key],|r|r.get(0)).unwrap();
        conn.execute(sql,[]).unwrap();
        assert!(matches!(cache::truth(&conn,&key).unwrap(),cache::Truth::NeedsReview{..}), "{sql}");
        conn.execute(restore,[if sql.contains("validation_sha256"){sha256(crate::labels::CONTRACT_BYTES)}else{pixels}]).unwrap();
    }
    assert!(matches!(
        cache::truth(&conn, &key).unwrap(),
        cache::Truth::Accepted { human: false, .. }
    ));
    let mut blank = original;
    blank["label"] = json!("");
    blank["first_reading"] = json!({"text":"","clarity":"blank"});
    blank["verification"] = blank["first_reading"].clone();
    conn.execute(
        "UPDATE ai_review_items SET result=? WHERE job_id=?",
        params![blank.to_string(), job],
    )
    .unwrap();
    assert_eq!(
        cache::truth(&conn, &key).unwrap(),
        cache::Truth::Accepted {
            label: String::new(),
            human: false
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
#[ignore = "Requires card worker external four-failure proof, no private pixels in source"]
fn four_source_failure_proofs_never_support_automatic_truth() {
    let path = std::env::var("POKER_CARD_SUPPORT_PROOF").unwrap();
    let rows: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 4);
    for row in rows {
        assert!(!cache::automatic_support(
            row["region_id"].as_str().unwrap(),
            row
        ));
        assert_eq!(row["presence"]["state"], "present");
        assert_eq!(row["pixel_sha_before"], row["pixel_sha_after"]);
    }
}

#[test]
fn accepted_split_and_scalar_disagreement_conflicts_in_both_projections() {
    let (_directory, service, calls) = fixture(money_regions(), "S 2 BB");
    let session = record(
        &service,
        json!({"seats[0].bet":"S 2 BB","split_pot":"S 2 BB S 2 BB"}),
    );
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run = prepared["run_id"].as_str().unwrap();
    let (items, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    let split = items
        .iter()
        .find(|i| i["region_id"] == "split_pot")
        .unwrap();
    service.gameplay_ai.review(&service, &json!({"occurrence_id":split["id"],"expected_revision":split["revision"],"action":"manual","label":"S 2 BB S 2 BB"})).unwrap();
    let (items, _) = service.gameplay_ai.read_snapshot(run).unwrap();
    let scalar = items
        .iter()
        .find(|i| i["region_id"] == "seats[0].bet")
        .unwrap();
    service.gameplay_ai.review(&service, &json!({"occurrence_id":scalar["id"],"expected_revision":scalar["revision"],"action":"manual","label":"S 3 BB"})).unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let fresh = read_items(&conn, run).unwrap();
    let groups = cache::group_work(&conn, fresh.clone()).unwrap();
    for region in ["split_pot", "seats[0].bet"] {
        let item = fresh.iter().find(|i| i["region_id"] == region).unwrap();
        assert_eq!(item["state"], "conflict", "{region}: {item}");
        let group = groups.iter().find(|i| i["region_id"] == region).unwrap();
        assert_eq!(group["state"], "conflict", "{region}: {group}");
    }
    let scalar_key = fresh
        .iter()
        .find(|i| i["region_id"] == "seats[0].bet")
        .unwrap()["sample_key"]
        .as_str()
        .unwrap();
    conn.execute("INSERT INTO gameplay_ai_decisions(occurrence_id,sample_key,label,state,created_at) VALUES('other-human',?,'S 4 BB','manual',0)", [scalar_key]).unwrap();
    let conflicted = read_items(&conn, run).unwrap();
    let parent = conflicted
        .iter()
        .find(|i| i["region_id"] == "split_pot")
        .unwrap();
    assert_eq!(parent["state"], "conflict");
    assert_eq!(parent["reason"], "Conflicting manual readings");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn historical_supported_boundary_contact_blocks_automatic_reuse_but_keeps_human_truth() {
    let (_directory, service, calls) = fixture(json!([region("community_cards[0].suit", 2)]), "c");
    let session = record(&service, json!({"community_cards[0].suit":"c"}));
    let prepared = run(&service, &session);
    let run_id = prepared["run_id"].as_str().unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let item = read_items(&conn, run_id).unwrap().remove(0);
    let key = item["sample_key"].as_str().unwrap().to_owned();
    assert!(matches!(
        cache::truth(&conn, &key).unwrap(),
        cache::Truth::Accepted { human: false, .. }
    ));
    conn.execute("UPDATE queue_items SET payload=json_set(payload,'$.presence.card_evidence.boundary_contact',json('[true,false,false,false]')) WHERE sample_key=?", [&key]).unwrap();
    conn.execute("UPDATE gameplay_ai_cache_context SET payload=json_set(payload,'$.presence.card_evidence.boundary_contact',json('[true,false,false,false]')) WHERE occurrence_id=?", [item["id"].as_str().unwrap()]).unwrap();
    assert!(matches!(
        cache::truth(&conn, &key).unwrap(),
        cache::Truth::NeedsReview { .. }
    ));
    let blocked = read_items(&conn, run_id).unwrap().remove(0);
    assert_eq!(blocked["state"], "flagged");
    drop(conn);
    let reviewed = service.gameplay_ai.review(&service, &json!({"occurrence_id":blocked["id"],"expected_revision":blocked["revision"],"action":"manual","label":"c"})).unwrap();
    assert_eq!(reviewed["item"]["state"], "manual");
    let conn = service.gameplay_ai.context.connection().unwrap();
    assert!(matches!(
        cache::truth(&conn, &key).unwrap(),
        cache::Truth::Accepted { human: true, .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn automatic_card_support_requires_four_clear_boundary_flags() {
    let mut evidence = json!({"presence":{"target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}}});
    for id in ["community_cards[0]", "community_cards[0].suit"] {
        assert!(cache::automatic_support(id, &evidence));
        for flags in [
            json!([true, false, false, false]),
            json!([false, false, false]),
            Value::Null,
            json!([false, false, false, "false"]),
        ] {
            evidence["presence"]["card_evidence"]["boundary_contact"] = flags;
            assert!(!cache::automatic_support(id, &evidence));
        }
        evidence["presence"]["card_evidence"]["boundary_contact"] =
            json!([false, false, false, false]);
    }
    assert!(cache::automatic_support("seats[0].bet", &json!({})));
}

#[test]
fn real_clipped_uniform_pixels_cannot_inherit_historical_supported_reading() {
    use crate::lab::gameplay::{card_crop as plane, card_fields, presence};
    use std::collections::BTreeMap;
    let quad = [
        plane::Point { x: 0., y: 0. },
        plane::Point { x: 100., y: 0. },
        plane::Point { x: 100., y: 100. },
        plane::Point { x: 0., y: 100. },
    ];
    let pose = plane::CardPose {
        policy: plane::POLICY.into(),
        prior_quad: quad,
        quad,
        rank: plane::LocalRect {
            x: 0.1,
            y: 0.05,
            width: 0.2,
            height: 0.2,
        },
        suit: plane::LocalRect {
            x: 0.1,
            y: 0.23,
            width: 0.2,
            height: 0.25,
        },
        prior_angle_degrees: 0.,
        measured_angle_degrees: 0.,
        applied_angle_degrees: 0.,
        adjusted: false,
        top_edge: None,
        left_edge: None,
    };
    let mut pixels = RgbImage::from_pixel(120, 120, Rgb([255; 3]));
    for y in 8..17 {
        for x in 10..13 {
            pixels.put_pixel(x, y, Rgb([20; 3]));
        }
    }
    let before = pixels.clone();
    let region = json!({"id":"community_cards[0]","category":"card","ocr":true,"card_prior_id":"card","card_field":"rank","guide":{"family":"card.rank"},"bounds":{"x":10,"y":5,"width":20,"height":20}});
    let poses = BTreeMap::from([("card".to_owned(), plane::CardResolution::Pose { pose })]);
    let resolved = card_fields::resolve(&pixels, &json!({}), &region, &poses).unwrap();
    assert_eq!(resolved["card_target_evidence"]["surface"]["uniform"], true);
    assert_eq!(
        resolved["card_target_evidence"]["target_support"],
        "ambiguous"
    );
    assert!(resolved["card_target_evidence"]["boundary_contact"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| *v == true));
    let current_presence = presence::assess(&DynamicImage::ImageRgb8(pixels.clone()), &resolved);
    assert_eq!(current_presence["target_support"], "ambiguous");
    assert_eq!(pixels, before);
    let target = card_fields::sample(&pixels, &resolved).unwrap().unwrap();
    let target_png = crate::media::png(&target).unwrap();
    let expected_pixel_sha = crate::lab::review::image_identity(&target_png).unwrap().1;

    let (_directory, service, calls) = fixture(json!([region.clone()]), "A");
    let mut historical = resolved.clone();
    // Reconstruct the former uniform-face exception while retaining measured flags.
    historical["card_target_evidence"]["target_support"] = json!("supported");
    historical["presence"] = current_presence.clone();
    historical["presence"]["target_support"] = json!("supported");
    historical["presence"]["card_evidence"]["target_support"] = json!("supported");
    historical
        .as_object_mut()
        .unwrap()
        .remove("guideUnsupportedReason");
    fs::write(
        service.gameplay_ai.config.join("gameplay-regions.json"),
        json!({"viewport":{"width":120,"height":120},"regions":[historical]}).to_string(),
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
    let png = crate::media::png(&DynamicImage::ImageRgb8(pixels)).unwrap();
    store
        .admit(
            &session,
            &png,
            120,
            120,
            "2026-11-14T00:00:00Z",
            &settings,
            "fixture",
            &json!({"community_cards[0]":{"prediction":{"text":"K"}}}),
            "12345678",
            &json!({}),
        )
        .unwrap();
    service
        .ai_review
        .ensure(&service.gameplay_ai.context)
        .unwrap();
    let prepared = service.gameplay_ai.prepare(&service, &session).unwrap();
    let run_id = prepared["run_id"].as_str().unwrap();
    let conn = service.gameplay_ai.context.connection().unwrap();
    let items = read_items(&conn, run_id).unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    let key = item["sample_key"].as_str().unwrap();
    let (queue_id, sha, payload): (i64, String, String) = conn
        .query_row(
            "SELECT queue_id,pixel_sha256,payload FROM queue_items WHERE sample_key=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(sha, expected_pixel_sha);
    assert!(payload["guide"]["guideUnsupportedReason"].is_null());
    assert!(payload["guide"]["localization_error"].is_null());

    assert_eq!(
        payload["presence"]["card_evidence"]["target_support"],
        "supported"
    );
    assert!(payload["presence"]["card_evidence"]["boundary_contact"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| *v == true));
    conn.execute("INSERT INTO ai_review_jobs(id,dataset_id,run_id,state,model,batch_size,auto_correct,created_at,updated_at) VALUES('old-supported','gameplay-ai',?,'completed','fixture',1,1,0,0)",[run_id]).unwrap();
    conn.execute(
        "UPDATE gameplay_ai_runs SET job_id='old-supported' WHERE run_id=?",
        [run_id],
    )
    .unwrap();
    let result = json!({"label":"A","pixel_sha256":sha,"first_reading":{"text":"A","clarity":"clear"},"verification":{"text":"A","clarity":"clear"}});
    conn.execute("INSERT INTO ai_review_items(job_id,ordinal,batch_index,queue_id,sample_key,region_id,group_name,prior_label,pixel_sha256,prior_event_id,state,result) VALUES('old-supported',0,0,?,?,?,'rank','K',?,0,'corrected',?)",params![queue_id,key,"community_cards[0]",sha,result.to_string()]).unwrap();
    assert!(matches!(
        cache::truth(&conn, key).unwrap(),
        cache::Truth::NeedsReview { .. }
    ));
    conn.execute("UPDATE gameplay_ai_cache_context SET payload=json_set(payload,'$.presence',json(?)) WHERE occurrence_id=?", params![current_presence.to_string(), item["id"].as_str().unwrap()]).unwrap();
    let current = read_items(&conn, run_id).unwrap();
    assert_eq!(current[0]["state"], "flagged");
    assert_eq!(current[0]["presence"]["target_support"], "ambiguous");
    assert_eq!(
        current[0]["presence"]["card_evidence"]["surface"]["uniform"],
        true
    );

    assert_ne!(current[0]["label"], "A");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
