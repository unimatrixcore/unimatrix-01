use super::*;

impl Store {
    pub fn collections(&self, archived: bool) -> Result<Value> {
        let conn = self.connect()?;
        let mut q=conn.prepare("SELECT c.id,c.name,c.kind,c.archived,(SELECT COUNT(*) FROM sessions s WHERE s.collection_id=c.id),(SELECT COUNT(*) FROM frames f JOIN sessions s ON s.id=f.session_id WHERE s.collection_id=c.id) FROM collections c WHERE c.archived=? ORDER BY c.created_at,c.id").map_err(err)?;
        let items=q.query_map([i64::from(archived)],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"archived":r.get::<_,i64>(3)?!=0,"recording_count":r.get::<_,i64>(4)?,"frame_count":r.get::<_,i64>(5)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(json!({"collections":items,"default_collection_id":"current"}))
    }
    pub fn create_collection(&self, name: &str) -> Result<Value> {
        if name.trim().is_empty() || name.chars().count() > 100 {
            return Err("400:Collection name must contain1to100characters".into());
        }
        let id = Uuid::new_v4().simple().to_string();
        self.connect()?
            .execute(
                "INSERT INTO collections(id,name,kind,created_at) VALUES(?,?,'gameplay',?)",
                params![id, name.trim(), now()],
            )
            .map_err(err)?;
        self.collection(&id)
    }
    pub fn collection(&self, id: &str) -> Result<Value> {
        for archived in [false, true] {
            if let Some(row) = self.collections(archived)?["collections"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["id"] == id))
                .cloned()
            {
                return Ok(row);
            }
        }
        Err("404:Gameplay collection not found".into())
    }
    pub fn update_collection(&self, id: &str, body: &Value) -> Result<Value> {
        self.collection(id)?;
        if body["archived"] == true && id == "current" {
            return Err("409:The current collection cannot be archived".into());
        }
        let name = body.get("name").and_then(Value::as_str);
        if name.is_some_and(|name| name.trim().is_empty() || name.chars().count() > 100) {
            return Err("400:Invalid collection name".into());
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        if let Some(name) = name {
            tx.execute(
                "UPDATE collections SET name=? WHERE id=?",
                params![name.trim(), id],
            )
            .map_err(err)?;
        }
        if let Some(archived) = body.get("archived").and_then(Value::as_bool) {
            tx.execute(
                "UPDATE collections SET archived=? WHERE id=?",
                params![i64::from(archived), id],
            )
            .map_err(err)?;
            if archived {
                tx.execute("UPDATE sessions SET status='stopped',stopped_at=COALESCE(stopped_at,?) WHERE collection_id=?",params![now(),id]).map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        self.collection(id)
    }
    pub fn session_collection(&self, id: &str) -> Result<String> {
        self.connect()?
            .query_row("SELECT collection_id FROM sessions WHERE id=?", [id], |r| {
                r.get(0)
            })
            .map_err(err)
    }
    pub fn move_session(&self, id: &str, collection: &str) -> Result<Value> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let archived: Option<bool> = tx
            .query_row(
                "SELECT archived FROM collections WHERE id=?",
                [collection],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        match archived {
            None => return Err("404:Gameplay collection not found".into()),
            Some(true) => return Err("409:Collection is archived".into()),
            Some(false) => {}
        }
        if tx
            .execute(
                "UPDATE sessions SET collection_id=? WHERE id=?",
                params![collection, id],
            )
            .map_err(err)?
            != 1
        {
            return Err("404:Recording session not found".into());
        }
        tx.commit().map_err(err)?;
        self.session(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    fn session(store: &Store) -> String {
        store
            .create("fixture", 1000, "fixture", &json!({}), "hash")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }

    #[test]
    fn move_waits_for_archive_commit_before_checking_destination() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path().into()).unwrap();
        let id = session(&store);
        let collection = store.create_collection("destination").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut writer = store.connect().unwrap();
        let tx = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        tx.execute(
            "UPDATE collections SET archived=1 WHERE id=?",
            [&collection],
        )
        .unwrap();
        let (started, ready) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                started.send(()).unwrap();
                finished.send(store.move_session(&id, &collection)).unwrap();
            });
            ready.recv().unwrap();
            assert!(matches!(
                result.recv_timeout(Duration::from_millis(150)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ));
            tx.commit().unwrap();
            assert!(result
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err()
                .starts_with("409:"));
        });
        assert_eq!(store.session(&id).unwrap()["collection_id"], "current");
    }

    #[test]
    fn concurrent_move_and_archive_never_leave_active_sessions_in_archive() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path().into()).unwrap();
        for _ in 0..12 {
            let id = session(&store);
            let collection = store.create_collection("destination").unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let moved = scope.spawn(|| {
                    barrier.wait();
                    store.move_session(&id, &collection)
                });
                barrier.wait();
                store
                    .update_collection(&collection, &json!({"archived":true}))
                    .unwrap();
                if let Err(error) = moved.join().unwrap() {
                    assert!(error.starts_with("409:"), "{error}");
                }
            });
            let row = store.session(&id).unwrap();
            assert!(
                row["collection_id"] != collection
                    || (row["status"] == "stopped" && row["stopped_at"].is_string())
            );
            assert!(store
                .move_session(&id, &collection)
                .unwrap_err()
                .starts_with("409:"));
        }
        let id = session(&store);
        let collection = store.create_collection("move first").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        store.move_session(&id, &collection).unwrap();
        store
            .update_collection(&collection, &json!({"archived":true}))
            .unwrap();
        assert_eq!(store.session(&id).unwrap()["status"], "stopped");
    }

    #[test]
    fn moves_invalidate_both_collection_cursors_on_new_and_existing_databases() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::new(root.path().into()).unwrap();
        for existing in [false, true] {
            if existing {
                store.connect().unwrap().execute_batch("DROP TRIGGER list_session_update; CREATE TRIGGER list_session_update AFTER UPDATE OF name,archived,created_at ON sessions BEGIN UPDATE list_session_revision SET revision=revision+1; END;").unwrap();
                store = Store::new(root.path().into()).unwrap();
            }
            let collection = store.create_collection("target").unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let moved = session(&store);
            session(&store);
            for _ in 0..2 {
                let id = session(&store);
                store.move_session(&id, &collection).unwrap();
            }
            let page = |collection: &str, cursor: Option<&str>| {
                store.list_page_collection(
                    "sessions",
                    None,
                    None,
                    "desc",
                    false,
                    cursor,
                    1,
                    Some(collection),
                )
            };
            let old = page("current", None).unwrap();
            let new = page(&collection, None).unwrap();
            let old_cursor = old["next_cursor"].as_str().unwrap();
            let new_cursor = new["next_cursor"].as_str().unwrap();
            store.move_session(&moved, &collection).unwrap();
            assert!(page("current", Some(old_cursor))
                .unwrap_err()
                .starts_with("409:"));
            assert!(page(&collection, Some(new_cursor))
                .unwrap_err()
                .starts_with("409:"));
            let current = page(&collection, None).unwrap();
            store.move_session(&moved, &collection).unwrap();
            assert!(page(&collection, current["next_cursor"].as_str()).is_ok());
        }
    }
}
