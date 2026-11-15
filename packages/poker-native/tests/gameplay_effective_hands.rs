use poker_native::lab::gameplay::store::Store;
use rusqlite::Connection;
use serde_json::{json, Value};

fn session(store: &Store, name: &str) -> String {
    store
        .create("fixture", 1000, name, &json!({}), "captured-config")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn frame(store: &Store, session: &str, hand: &str, at: &str) -> String {
    store
        .admit(
            session,
            b"fixture-png",
            12,
            8,
            at,
            &json!({"captured":true}),
            "captured-config",
            &json!({"round_id":{"prediction":{"text":format!("#{hand}"),"suggestion_only":true}}}),
            hand,
            &json!({}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn revisions(store: &Store) -> (i64, i64) {
    let conn = Connection::open(store.root().join("gameplay.sqlite3")).unwrap();
    (
        conn.query_row(
            "SELECT revision FROM list_frame_revision WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap(),
        conn.query_row(
            "SELECT revision FROM list_session_revision WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap(),
    )
}
fn apply(store: &Store, profile: &str, id: &str, hand: Option<&str>, revision: i64) {
    store
        .replace_effective_hands(
            profile,
            &[(
                id.into(),
                hand.map(str::to_string),
                "reading-event".into(),
                revision,
            )],
        )
        .unwrap();
}

#[test]
fn accepted_id_regroups_regular_and_paged_history_without_rewriting_capture() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "wrong", "2026-01-01T00:00:00Z");
    let b = frame(&store, &s, "right", "2026-01-01T00:00:01Z");
    session(&store, "Other recording");
    let original = store.frame(&a, true).unwrap();
    let first = store
        .list_page("frames", Some(&s), None, "asc", false, None, 1)
        .unwrap();
    let frame_cursor = first["next_cursor"].as_str().unwrap();
    let sessions = store
        .list_page("sessions", None, None, "asc", false, None, 1)
        .unwrap();
    let session_cursor = sessions["next_cursor"].as_str().unwrap();
    apply(&store, "profile-a", &a, Some("right"), 1);
    let groups = store.hands(&s).unwrap();
    assert_eq!(groups.as_array().unwrap().len(), 1);
    assert_eq!(groups[0]["hand_id"], "right");
    assert_eq!(groups[0]["frame_count"], 2);
    assert_eq!(
        store
            .frames(&s, Some(Some("wrong")), 0, 100, "asc")
            .unwrap()["total"],
        0
    );
    assert_eq!(
        store
            .frames(&s, Some(Some("right")), 0, 100, "asc")
            .unwrap()["total"],
        2
    );
    let paged = store
        .list_page("hands", Some(&s), None, "asc", false, None, 100)
        .unwrap();
    assert_eq!(paged["items"][0]["hand_id"], "right");
    assert_eq!(paged["items"][0]["frame_count"], 2);
    assert_eq!(
        store
            .list_page("frames", Some(&s), Some("right"), "asc", false, None, 100)
            .unwrap()["total"],
        2
    );
    assert_eq!(store.session(&s).unwrap()["hand_count"], 1);
    assert!(store
        .list_page(
            "frames",
            Some(&s),
            None,
            "asc",
            false,
            Some(frame_cursor),
            1
        )
        .unwrap_err()
        .starts_with("409:"));
    assert!(store
        .list_page(
            "sessions",
            None,
            None,
            "asc",
            false,
            Some(session_cursor),
            1
        )
        .unwrap_err()
        .starts_with("409:"));
    let effective = store.frame(&a, true).unwrap();
    assert_eq!(effective["hand_id"], "right");
    assert_eq!(effective["captured_hand_id"], "wrong");
    assert_eq!(effective["results"], original["results"]);
    assert_eq!(effective["config_snapshot"], original["config_snapshot"]);
    assert_eq!(store.frame(&b, false).unwrap()["hand_id"], "right");
    let conn = Connection::open(store.root().join("gameplay.sqlite3")).unwrap();
    assert_eq!(
        conn.query_row("SELECT hand_id FROM frames WHERE id=?", [&a], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "wrong"
    );
}

#[test]
fn accepted_blank_is_distinct_from_no_projection_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "captured", "then");
    apply(&store, "profile-a", &a, None, 1);
    assert_eq!(store.frame(&a, false).unwrap()["hand_id"], Value::Null);
    assert_eq!(
        store.frame(&a, false).unwrap()["captured_hand_id"],
        "captured"
    );
    assert_eq!(
        store.frames(&s, Some(None), 0, 100, "asc").unwrap()["total"],
        1
    );
    assert_eq!(
        store
            .list_page("frames", Some(&s), Some(""), "asc", false, None, 100)
            .unwrap()["total"],
        1
    );
    assert_eq!(store.hands(&s).unwrap()[0]["hand_id"], Value::Null);
    let reopened = Store::new(temp.path().into()).unwrap();
    assert_eq!(reopened.frame(&a, false).unwrap()["hand_id"], Value::Null);
    reopened.replace_effective_hands("profile-b", &[]).unwrap();
    assert_eq!(reopened.frame(&a, false).unwrap()["hand_id"], "captured");
}

#[test]
fn source_profile_changes_and_revocations_clear_all_stale_effective_ids() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "original", "then");
    apply(&store, "old-profile", &a, Some("corrected"), 1);
    let before = revisions(&store);
    store.replace_effective_hands("new-profile", &[]).unwrap();
    assert_eq!(store.frame(&a, false).unwrap()["hand_id"], "original");
    assert_eq!(revisions(&store), (before.0 + 1, before.1 + 1));
    apply(&store, "new-profile", &a, None, 1);
    assert_eq!(store.frame(&a, false).unwrap()["hand_id"], Value::Null);
    store.replace_effective_hands("new-profile", &[]).unwrap();
    assert_eq!(store.frame(&a, false).unwrap()["hand_id"], "original");
}

#[test]
fn provenance_only_updates_leave_cursors_valid_and_view_keeps_original_rowid_ceiling() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "same", "2026-01-01T00:00:00Z");
    let b = frame(&store, &s, "same", "2026-01-01T00:00:01Z");
    let first = store
        .list_page("frames", Some(&s), None, "asc", false, None, 1)
        .unwrap();
    let before = revisions(&store);
    apply(&store, "profile-a", &a, Some("same"), 1);
    apply(&store, "profile-b", &a, Some("same"), 5);
    assert_eq!(revisions(&store), before);
    frame(&store, &s, "same", "2026-01-01T00:00:02Z");
    let next = store
        .list_page(
            "frames",
            Some(&s),
            None,
            "asc",
            false,
            first["next_cursor"].as_str(),
            100,
        )
        .unwrap();
    assert_eq!(next["total"], 2);
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_eq!(next["items"][0]["id"], b);
    let db = Connection::open(store.root().join("gameplay.sqlite3")).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM frames f JOIN effective_frames e ON e.id=f.id WHERE f.rowid<>e.rowid",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn stale_invalid_and_duplicate_projection_snapshots_fail_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "captured", "then");
    apply(&store, "profile-a", &a, Some("current"), 5);
    let before = revisions(&store);
    assert!(store
        .replace_effective_hands(
            "profile-a",
            &[(a.clone(), Some("stale".into()), "reading-event".into(), 4)]
        )
        .unwrap_err()
        .starts_with("409:"));
    assert!(store
        .replace_effective_hands(
            "profile-a",
            &[
                (a.clone(), None, "x".into(), 6),
                (a.clone(), Some("duplicate".into()), "y".into(), 6)
            ]
        )
        .unwrap_err()
        .starts_with("400:"));
    assert!(store
        .replace_effective_hands(
            "profile-a",
            &[("unknown-frame".into(), None, "x".into(), 1)]
        )
        .unwrap_err()
        .starts_with("404:"));
    assert!(store
        .replace_effective_hands("", &[])
        .unwrap_err()
        .starts_with("400:"));
    assert_eq!(store.frame(&a, false).unwrap()["hand_id"], "current");
    assert_eq!(revisions(&store), before);
}

#[test]
fn identical_snapshot_is_a_database_noop_for_frequent_read_sync() {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::new(temp.path().into()).unwrap();
    let s = session(&store, "Recording");
    let a = frame(&store, &s, "captured", "then");
    apply(&store, "profile-a", &a, Some("corrected"), 1);
    let observer = Connection::open(store.root().join("gameplay.sqlite3")).unwrap();
    let version: i64 = observer
        .query_row("PRAGMA data_version", [], |r| r.get(0))
        .unwrap();
    apply(&store, "profile-a", &a, Some("corrected"), 1);
    assert_eq!(
        observer
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        version
    );
}
