//! Native gameplay evidence storage. Each operation owns a short-lived SQLite
//! connection so recording never holds a shared database mutex across OCR.
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

pub struct Store {
    root: PathBuf,
}

/// Convert dependency errors at the boundary while retaining their useful cause.
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn now() -> String {
    Utc::now().to_rfc3339()
}

impl Store {
    /// Additive migrations preserve existing Python-created recording evidence.
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("frames")).map_err(err)?;
        let store = Self { root };
        let mut conn = store.connect()?;
        conn.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,
                interval_ms INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,
                stopped_at TEXT,config_hash TEXT NOT NULL,config_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS frames (
                id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),
                captured_at TEXT NOT NULL,hand_id TEXT,ocr_status TEXT NOT NULL,error TEXT,
                width INTEGER NOT NULL,height INTEGER NOT NULL,image_sha256 TEXT NOT NULL,
                results_json TEXT NOT NULL,config_hash TEXT NOT NULL,config_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS frames_session_hand ON frames(session_id,hand_id,captured_at);")
            .map_err(err)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        for (table, column, migration) in [
            (
                "sessions",
                "archived",
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "frames",
                "timings_json",
                "ALTER TABLE frames ADD COLUMN timings_json TEXT NOT NULL DEFAULT '{}'",
            ),
        ] {
            let mut query = tx
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(err)?;
            let columns = query
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            drop(query);
            if !columns.iter().any(|name| name == column) {
                tx.execute_batch(migration).map_err(err)?;
            }
        }
        tx.execute("UPDATE frames SET ocr_status='error',error='OCR interrupted by server restart' WHERE ocr_status='pending'", []).map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS list_frame_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO list_frame_revision VALUES(1,0); CREATE TRIGGER IF NOT EXISTS list_frame_delete AFTER DELETE ON frames BEGIN UPDATE list_frame_revision SET revision=revision+1 WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS list_frame_update AFTER UPDATE OF session_id,hand_id,captured_at ON frames WHEN OLD.session_id IS NOT NEW.session_id OR OLD.hand_id IS NOT NEW.hand_id OR OLD.captured_at IS NOT NEW.captured_at BEGIN UPDATE list_frame_revision SET revision=revision+1 WHERE id=1; END;").map_err(err)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS list_session_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO list_session_revision VALUES(1,0); CREATE TRIGGER IF NOT EXISTS list_session_insert AFTER INSERT ON sessions BEGIN UPDATE list_session_revision SET revision=revision+1 WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS list_session_delete AFTER DELETE ON sessions BEGIN UPDATE list_session_revision SET revision=revision+1 WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS list_session_update AFTER UPDATE OF name,archived,created_at ON sessions WHEN OLD.name IS NOT NEW.name OR OLD.archived IS NOT NEW.archived OR OLD.created_at IS NOT NEW.created_at BEGIN UPDATE list_session_revision SET revision=revision+1 WHERE id=1; END;").map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(store)
    }

    /// Expose the evidence directory to the native binary-image route.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Fresh connections isolate request lifetimes and enforce foreign keys.
    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(self.root.join("gameplay.sqlite3")).map_err(err)?;
        conn.busy_timeout(Duration::from_secs(10)).map_err(err)?;
        conn.execute_batch("PRAGMA foreign_keys=ON").map_err(err)?;
        Ok(conn)
    }

    /// Read one summary without loading its potentially large config snapshot.
    pub fn session(&self, id: &str) -> Result<Value> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT s.id,s.name,s.source,s.interval_ms,s.status,s.created_at,s.stopped_at,
            s.config_hash,s.archived,COUNT(f.id),COUNT(DISTINCT f.hand_id)
            FROM sessions s LEFT JOIN frames f ON f.session_id=s.id WHERE s.id=? GROUP BY s.id",
            [id],
            |row| {
                Ok(
                    json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,
                "source":row.get::<_,String>(2)?,"interval_ms":row.get::<_,i64>(3)?,
                "status":row.get::<_,String>(4)?,"created_at":row.get::<_,String>(5)?,
                "stopped_at":row.get::<_,Option<String>>(6)?,"config_hash":row.get::<_,String>(7)?,
                "archived":row.get::<_,i64>(8)? != 0,"frame_count":row.get::<_,i64>(9)?,
                "hand_count":row.get::<_,i64>(10)?}),
                )
            },
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| "404:Recording session not found".into())
    }

    /// Match the historical newest-first, bounded session picker.
    pub fn sessions(&self, archived: bool) -> Result<Value> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT id FROM sessions WHERE archived=? ORDER BY created_at DESC LIMIT 200")
            .map_err(err)?;
        let ids = query
            .query_map([archived as i64], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(Value::Array(
            ids.iter()
                .map(|id| self.session(id))
                .collect::<Result<Vec<_>>>()?,
        ))
    }

    pub fn list_page(
        &self,
        kind: &str,
        session: Option<&str>,
        hand: Option<&str>,
        order: &str,
        archived: bool,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(err)?;
        let revision_table = if kind == "sessions" {
            "list_session_revision"
        } else {
            "list_frame_revision"
        };
        let revision: i64 = tx
            .query_row(
                &format!("SELECT revision FROM {revision_table} WHERE id=1"),
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        let table = if kind == "sessions" {
            "sessions"
        } else {
            "frames"
        };
        let (ceiling, offset) = if let Some(cursor) = cursor {
            let value: Value = serde_json::from_str(cursor).map_err(err)?;
            if value["revision"].as_i64() != Some(revision) {
                return Err("409:Gameplay history changed; reload the list".into());
            }
            let ceiling = value["ceiling"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or("400:Invalid page cursor")?;
            let offset = value["offset"]
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or("400:Invalid page cursor")?;
            (ceiling, offset)
        } else {
            (
                tx.query_row(
                    &format!("SELECT COALESCE(MAX(rowid),0) FROM {table}"),
                    [],
                    |r| r.get(0),
                )
                .map_err(err)?,
                0,
            )
        };
        let next_offset = offset
            .checked_add(limit as i64)
            .ok_or("400:Invalid page cursor")?;
        let (mut items, total): (Vec<Value>, i64) = match kind {
            "sessions" => {
                let total = tx
                    .query_row(
                        "SELECT COUNT(*) FROM sessions WHERE archived=?1 AND rowid<=?2",
                        params![archived as i64, ceiling],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                let mut q = tx.prepare("SELECT id,name,source,interval_ms,status,created_at,stopped_at,config_hash,archived,(SELECT COUNT(*) FROM frames WHERE session_id=sessions.id),(SELECT COUNT(DISTINCT hand_id) FROM frames WHERE session_id=sessions.id) FROM sessions WHERE archived=?1 AND rowid<=?2 ORDER BY created_at DESC,id DESC LIMIT ?3 OFFSET ?4").map_err(err)?;
                let rows = q.query_map(params![archived as i64,ceiling,(limit+1) as i64,offset], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"source":r.get::<_,String>(2)?,"interval_ms":r.get::<_,i64>(3)?,"status":r.get::<_,String>(4)?,"created_at":r.get::<_,String>(5)?,"stopped_at":r.get::<_,Option<String>>(6)?,"config_hash":r.get::<_,String>(7)?,"archived":r.get::<_,i64>(8)? != 0,"frame_count":r.get::<_,i64>(9)?,"hand_count":r.get::<_,i64>(10)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
                (rows, total)
            }
            "hands" => {
                let id = session.ok_or("400:Missing session")?;
                let total = tx.query_row("SELECT COUNT(*) FROM (SELECT hand_id FROM frames WHERE session_id=?1 AND rowid<=?2 GROUP BY hand_id)",params![id,ceiling],|r|r.get(0)).map_err(err)?;
                let mut q = tx.prepare("SELECT hand_id,COUNT(*),MIN(captured_at),MAX(captured_at) FROM frames WHERE session_id=?1 AND rowid<=?2 GROUP BY hand_id ORDER BY MAX(captured_at) DESC,hand_id DESC LIMIT ?3 OFFSET ?4").map_err(err)?;
                let rows = q.query_map(params![id,ceiling,(limit+1) as i64,offset],|r|Ok(json!({"hand_id":r.get::<_,Option<String>>(0)?,"frame_count":r.get::<_,i64>(1)?,"first_at":r.get::<_,String>(2)?,"last_at":r.get::<_,String>(3)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
                (rows, total)
            }
            "frames" => {
                let id = session.ok_or("400:Missing session")?;
                if !["asc", "desc"].contains(&order) {
                    return Err("400:Invalid frame order".into());
                }
                let predicate = if hand.is_some() {
                    "session_id=?1 AND rowid<=?2 AND hand_id IS ?3"
                } else {
                    "session_id=?1 AND rowid<=?2 AND ?3 IS NULL"
                };
                let selected = hand.filter(|s| !s.is_empty());
                let total = tx
                    .query_row(
                        &format!("SELECT COUNT(*) FROM frames WHERE {predicate}"),
                        params![id, ceiling, selected],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                let mut q = tx.prepare(&format!("SELECT id,session_id,captured_at,hand_id,ocr_status,error,width,height,image_sha256,config_hash,timings_json FROM frames WHERE {predicate} ORDER BY captured_at {order},id {order} LIMIT ?4 OFFSET ?5")).map_err(err)?;
                let rows = q
                    .query_map(
                        params![id, ceiling, selected, (limit + 1) as i64, offset],
                        |r| Self::row_frame(r, false),
                    )
                    .map_err(err)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(err)?;
                (rows, total)
            }
            _ => return Err("400:Unsupported gameplay list".into()),
        };
        let more = items.len() > limit;
        items.truncate(limit);
        tx.commit().map_err(err)?;
        let meta = if let Some(id) = session {
            json!({"session": self.session(id)?})
        } else {
            json!({})
        };
        Ok(
            json!({"items":items,"total":total,"next_cursor":if more {Some(json!({"ceiling":ceiling,"offset":next_offset,"revision":revision}).to_string())} else {None},"meta":meta}),
        )
    }

    /// Create a session while keeping its original configuration provenance.
    pub fn create(
        &self,
        source: &str,
        interval: u64,
        name: &str,
        config: &Value,
        hash: &str,
    ) -> Result<Value> {
        if !(1000..=60000).contains(&interval) {
            return Err("400:Capture interval must be between 1000 and 60000 milliseconds".into());
        }
        if name.chars().count() > 100 {
            return Err("400:Recording name must be at most 100 characters".into());
        }
        let id = Uuid::new_v4().simple().to_string();
        let name = if name.trim().is_empty() {
            "Gameplay recording"
        } else {
            name.trim()
        };
        self.connect()?.execute("INSERT INTO sessions (id,name,source,interval_ms,status,created_at,config_hash,config_json) VALUES (?,?,?,?,'ready',?,?,?)",
            params![id,name,source,interval as i64,now(),hash,config.to_string()]).map_err(err)?;
        self.session(&id)
    }

    /// Group saved evidence by its current-frame hand identity.
    pub fn hands(&self, id: &str) -> Result<Value> {
        self.session(id)?;
        let conn = self.connect()?;
        let mut query = conn.prepare("SELECT hand_id,COUNT(*),MIN(captured_at),MAX(captured_at) FROM frames WHERE session_id=? GROUP BY hand_id ORDER BY MIN(captured_at)").map_err(err)?;
        let values = query.query_map([id], |row| Ok(json!({"hand_id":row.get::<_,Option<String>>(0)?,
            "frame_count":row.get::<_,i64>(1)?,"first_at":row.get::<_,String>(2)?,"last_at":row.get::<_,String>(3)?}))).map_err(err)?
            .collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(Value::Array(values))
    }

    /// Rename only the presentation label, preserving recording provenance.
    pub fn rename(&self, id: &str, name: &str) -> Result<Value> {
        if name.trim().is_empty() || name.trim().chars().count() > 100 {
            return Err("400:Recording name must be between 1 and 100 characters".into());
        }
        self.session(id)?;
        self.connect()?
            .execute(
                "UPDATE sessions SET name=? WHERE id=?",
                params![name.trim(), id],
            )
            .map_err(err)?;
        self.session(id)
    }

    /// Stop is idempotent; its timestamp records the first stop request.
    pub fn stop(&self, id: &str) -> Result<Value> {
        self.session(id)?;
        self.connect()?
            .execute(
                "UPDATE sessions SET status='stopped',stopped_at=COALESCE(stopped_at,?) WHERE id=?",
                params![now(), id],
            )
            .map_err(err)?;
        self.session(id)
    }

    /// Archive and stop together so no capture can enter a hidden session.
    pub fn archive(&self, id: &str) -> Result<Value> {
        self.session(id)?;
        self.connect()?.execute("UPDATE sessions SET archived=1,status='stopped',stopped_at=COALESCE(stopped_at,?) WHERE id=?",params![now(),id]).map_err(err)?;
        self.session(id)
    }

    /// Restoring history deliberately leaves its recording loop stopped.
    pub fn restore(&self, id: &str) -> Result<Value> {
        self.session(id)?;
        self.connect()?
            .execute("UPDATE sessions SET archived=0 WHERE id=?", [id])
            .map_err(err)?;
        self.session(id)
    }

    /// Build metadata without decoding OCR/config JSON for grid and feed pages.
    fn row_frame(row: &Row<'_>, detail: bool) -> rusqlite::Result<Value> {
        let id: String = row.get("id")?;
        let timings: String = row.get("timings_json")?;
        let mut value = json!({"id":id,"session_id":row.get::<_,String>("session_id")?,
            "captured_at":row.get::<_,String>("captured_at")?,"hand_id":row.get::<_,Option<String>>("hand_id")?,
            "ocr_status":row.get::<_,String>("ocr_status")?,"error":row.get::<_,Option<String>>("error")?,
            "width":row.get::<_,u32>("width")?,"height":row.get::<_,u32>("height")?,
            "image_sha256":row.get::<_,String>("image_sha256")?,"config_hash":row.get::<_,String>("config_hash")?,
            "timings":serde_json::from_str::<Value>(&timings).unwrap_or_else(|_| json!({})),
            "image_url":format!("/api/gameplay/frames/{id}/image"),
            "thumbnail_url":format!("/api/gameplay/frames/{id}/thumbnail"),
            "preview_url":format!("/api/gameplay/frames/{id}/preview")});
        if detail {
            for (column, key) in [
                ("results_json", "results"),
                ("config_json", "config_snapshot"),
            ] {
                let raw: String = row.get(column)?;
                value[key] = serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            }
        }
        Ok(value)
    }

    /// Fetch a frame by immutable database identity, never a caller-built path.
    pub fn frame(&self, id: &str, detail: bool) -> Result<Value> {
        let columns = if detail {
            "*"
        } else {
            "id,session_id,captured_at,hand_id,ocr_status,error,width,height,image_sha256,config_hash,timings_json"
        };
        self.connect()?
            .query_row(
                &format!("SELECT {columns} FROM frames WHERE id=?"),
                [id],
                |row| Self::row_frame(row, detail),
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| "404:Gameplay frame not found".into())
    }

    /// A nested option distinguishes no hand filter from an explicit null hand.
    pub fn frames(
        &self,
        id: &str,
        hand: Option<Option<&str>>,
        offset: u64,
        limit: u64,
        order: &str,
    ) -> Result<Value> {
        if offset > i64::MAX as u64 || !(1..=100).contains(&limit) {
            return Err("400:Invalid frame page".into());
        }
        if !matches!(order, "asc" | "desc") {
            return Err("400:Invalid frame order".into());
        }
        self.session(id)?;
        let conn = self.connect()?;
        let where_sql = if hand.is_some() {
            "session_id=?1 AND hand_id IS ?2"
        } else {
            "session_id=?1 AND (?2 IS NULL)"
        };
        let selected = hand.flatten();
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM frames WHERE {where_sql}"),
                params![id, selected],
                |row| row.get(0),
            )
            .map_err(err)?;
        let mut query = conn.prepare(&format!("SELECT id,session_id,captured_at,hand_id,ocr_status,error,width,height,image_sha256,config_hash,timings_json FROM frames WHERE {where_sql} ORDER BY captured_at {order},id {order} LIMIT ?3 OFFSET ?4")).map_err(err)?;
        let frames = query
            .query_map(params![id, selected, limit as i64, offset as i64], |row| {
                Self::row_frame(row, false)
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(json!({"frames":frames,"total":total}))
    }

    /// Publish PNG evidence and its row only when the session is still active.
    /// The conditional INSERT shares SQLite's write boundary with stop/archive.
    pub fn admit(
        &self,
        session_id: &str,
        png: &[u8],
        width: u32,
        height: u32,
        captured_at: &str,
        config: &Value,
        hash: &str,
        results: &Value,
        hand_id: &str,
        timings: &Value,
    ) -> Result<Value> {
        let id = Uuid::new_v4().simple().to_string();
        let destination = self.root.join("frames").join(format!("{id}.png"));
        let temporary = destination.with_extension("tmp");
        let save = || -> Result<()> {
            fs::write(&temporary, png).map_err(err)?;
            fs::rename(&temporary, &destination).map_err(err)?;
            let rows = self.connect()?.execute("INSERT INTO frames (id,session_id,captured_at,hand_id,ocr_status,error,width,height,image_sha256,results_json,config_hash,config_json,timings_json)
                SELECT ?,?,?,?,'complete',NULL,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND status!='stopped' AND archived=0)",
                params![id,session_id,captured_at,hand_id,width,height,format!("{:x}",Sha256::digest(png)),results.to_string(),hash,config.to_string(),timings.to_string(),session_id]).map_err(err)?;
            if rows != 1 {
                return Err("409:Recording session has stopped".into());
            }
            Ok(())
        };
        let result = save();
        let _ = fs::remove_file(&temporary);
        if result.is_err() {
            let _ = fs::remove_file(&destination);
        }
        result?;
        self.frame(&id, false)
    }

    /// Dry runs count evidence without changing either rows or image files.
    pub fn prune(&self, dry: bool, session: Option<&str>) -> Result<Value> {
        if let Some(id) = session {
            self.session(id)?;
        }
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(err)?;
        let ids = {
            let mut query = tx.prepare("SELECT id FROM frames WHERE (hand_id IS NULL OR hand_id='' OR ocr_status!='complete') AND (?1 IS NULL OR session_id=?1)").map_err(err)?;
            let values = query
                .query_map([session], |row| row.get::<_, String>(0))
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            values
        };
        if !dry {
            for id in &ids {
                tx.execute("DELETE FROM frames WHERE id=?", [id])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        if !dry {
            for id in &ids {
                // Historical database IDs are checked before filesystem use.
                if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    continue;
                }
                for suffix in [".png", ".thumb.jpg", ".preview.jpg"] {
                    let path = self.root.join("frames").join(format!("{id}{suffix}"));
                    match fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(err(error)),
                    }
                }
            }
        }
        Ok(json!({"dry_run":dry,"count":ids.len()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Unique directories keep tests independent without a runtime temp crate.
    fn store() -> Store {
        Store::new(std::env::temp_dir().join(format!("poker-store-test-{}", Uuid::new_v4())))
            .unwrap()
    }
    fn session(store: &Store) -> String {
        store
            .create("monitor", 1000, "test", &json!({}), "hash")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn frame(store: &Store, id: &str) -> Value {
        store
            .admit(
                id,
                b"png",
                100,
                50,
                "2026-01-01T00:00:00Z",
                &json!({"regions":{}}),
                "hash",
                &json!({"round_id":{"text":"#123456"}}),
                "123456",
                &json!({"total_ms":1}),
            )
            .unwrap()
    }
    #[test]
    fn stopped_capture_cannot_publish_evidence() {
        let store = store();
        let id = session(&store);
        let first = frame(&store, &id);
        store.stop(&id).unwrap();
        assert!(store
            .admit(
                &id,
                b"late",
                100,
                50,
                "later",
                &json!({}),
                "hash",
                &json!({}),
                "123456",
                &json!({})
            )
            .unwrap_err()
            .starts_with("409:"));
        assert_eq!(store.session(&id).unwrap()["frame_count"], 1);
        assert_eq!(
            fs::read_dir(store.root().join("frames")).unwrap().count(),
            1
        );
        assert!(
            store.frame(first["id"].as_str().unwrap(), true).unwrap()["config_snapshot"]
                .is_object()
        );
        fs::remove_dir_all(store.root()).unwrap();
    }
    #[test]
    fn history_pages_and_archive_preserve_evidence() {
        let store = store();
        let id = session(&store);
        frame(&store, &id);
        assert_eq!(store.frames(&id, None, 0, 12, "desc").unwrap()["total"], 1);
        assert_eq!(
            store
                .frames(&id, Some(Some("other")), 0, 12, "desc")
                .unwrap()["total"],
            0
        );
        assert_eq!(
            store.frames(&id, Some(None), 0, 12, "desc").unwrap()["total"],
            0
        );
        let metadata = store.frames(&id, None, 0, 12, "desc").unwrap();
        assert!(metadata["frames"][0].get("results").is_none());
        assert_eq!(store.hands(&id).unwrap()[0]["frame_count"], 1);
        store.archive(&id).unwrap();
        assert_eq!(store.sessions(false).unwrap(), json!([]));
        assert_eq!(store.sessions(true).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(store.restore(&id).unwrap()["status"], "stopped");
        assert_eq!(store.prune(true, None).unwrap()["count"], 0);
        fs::remove_dir_all(store.root()).unwrap();
    }
    #[test]
    fn prune_dry_run_preserves_pixels_and_scopes_deletion_to_session() {
        let store = store();
        let first = session(&store);
        let second = session(&store);
        let invalid = frame(&store, &first);
        let retained = frame(&store, &second);
        let frame_id = invalid["id"].as_str().unwrap();
        store
            .connect()
            .unwrap()
            .execute("UPDATE frames SET hand_id=NULL WHERE id=?", [frame_id])
            .unwrap();
        for suffix in [".thumb.jpg", ".preview.jpg"] {
            fs::write(
                store
                    .root()
                    .join("frames")
                    .join(format!("{frame_id}{suffix}")),
                b"derivative",
            )
            .unwrap();
        }
        assert_eq!(store.prune(true, Some(&first)).unwrap()["count"], 1);
        assert_eq!(
            fs::read_dir(store.root().join("frames")).unwrap().count(),
            4
        );
        assert_eq!(store.prune(false, Some(&second)).unwrap()["count"], 0);
        assert_eq!(store.prune(false, Some(&first)).unwrap()["count"], 1);
        assert!(store
            .frame(frame_id, false)
            .unwrap_err()
            .starts_with("404:"));
        assert!(store.frame(retained["id"].as_str().unwrap(), false).is_ok());
        assert_eq!(
            fs::read_dir(store.root().join("frames")).unwrap().count(),
            1
        );
        fs::remove_dir_all(store.root()).unwrap();
    }
    #[test]
    fn migrates_existing_python_schema_without_losing_rows() {
        let root = std::env::temp_dir().join(format!("poker-store-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let conn = Connection::open(root.join("gameplay.sqlite3")).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,interval_ms INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,stopped_at TEXT,config_hash TEXT NOT NULL,config_json TEXT NOT NULL); INSERT INTO sessions VALUES ('old','History','monitor',1000,'stopped','then',NULL,'hash','{}');").unwrap();
        drop(conn);
        let store = Store::new(root).unwrap();
        assert_eq!(store.session("old").unwrap()["name"], "History");
        assert_eq!(store.session("old").unwrap()["archived"], false);
        fs::remove_dir_all(store.root()).unwrap();
    }
}
