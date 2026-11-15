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
        let tx = conn.transaction().map_err(err)?;
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
        let row = self.collection(collection)?;
        if row["archived"] == true {
            return Err("409:Collection is archived".into());
        }
        self.connect()?
            .execute(
                "UPDATE sessions SET collection_id=? WHERE id=?",
                params![collection, id],
            )
            .map_err(err)?;
        self.session(id)
    }
}
