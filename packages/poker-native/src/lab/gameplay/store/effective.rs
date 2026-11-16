use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn initialize(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS frame_hand_projection (
        frame_id TEXT PRIMARY KEY REFERENCES frames(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,hand_id TEXT,occurrence_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=0));
        CREATE VIEW IF NOT EXISTS effective_frames AS SELECT
        f.rowid AS rowid,f.id,f.session_id,f.captured_at,
        CASE WHEN p.frame_id IS NOT NULL THEN p.hand_id ELSE f.hand_id END AS hand_id,
        f.hand_id AS captured_hand_id,f.ocr_status,f.error,f.width,f.height,
        f.image_sha256,f.results_json,f.config_hash,f.config_json,f.timings_json
        FROM frames f LEFT JOIN frame_hand_projection p ON p.frame_id=f.id;",
    )
    .map_err(err)
}

impl Store {
    /// Replace the current profile's complete accepted map, preserving captured IDs.
    /// An explicit null projection differs from absence: it means accepted unassigned.
    pub fn replace_effective_hands(
        &self,
        profile_id: &str,
        entries: &[(String, Option<String>, String, i64)],
    ) -> Result<()> {
        if profile_id.is_empty() {
            return Err("400:Missing effective hand profile".into());
        }
        let mut accepted = BTreeMap::new();
        for (frame, hand, occurrence, revision) in entries {
            if occurrence.is_empty()
                || *revision < 0
                || accepted
                    .insert(frame.clone(), (hand.clone(), occurrence.clone(), *revision))
                    .is_some()
            {
                return Err("400:Invalid or duplicate effective hand entry".into());
            }
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let snapshot = {
            let mut query=tx.prepare("SELECT frame_id,hand_id,occurrence_id,revision,profile_id FROM frame_hand_projection").map_err(err)?;
            let values = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        (
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                        ),
                    ))
                })
                .map_err(err)?
                .collect::<std::result::Result<BTreeMap<_, _>, _>>()
                .map_err(err)?;
            values
        };
        if snapshot.len() == accepted.len()
            && snapshot
                .iter()
                .all(|(id, (hand, occurrence, revision, profile))| {
                    profile == profile_id
                        && accepted.get(id).is_some_and(|entry| {
                            entry.0 == *hand && entry.1 == *occurrence && entry.2 == *revision
                        })
                })
        {
            return tx.commit().map_err(err);
        }
        let mut ids = {
            let mut query = tx
                .prepare("SELECT frame_id FROM frame_hand_projection")
                .map_err(err)?;
            let values = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(err)?
                .collect::<std::result::Result<BTreeSet<_>, _>>()
                .map_err(err)?;
            values
        };
        ids.extend(entries.iter().map(|entry| entry.0.clone()));
        let mut changed = false;
        for id in ids {
            let (captured, prior): (Option<String>,Option<String>)=tx.query_row(
                "SELECT f.hand_id,e.hand_id FROM frames f JOIN effective_frames e ON e.id=f.id WHERE f.id=?",
                [&id],|row|Ok((row.get(0)?,row.get(1)?)),
            ).optional().map_err(err)?.ok_or("404:Effective hand frame no longer exists")?;
            let next = accepted
                .get(&id)
                .map(|entry| entry.0.clone())
                .unwrap_or(captured);
            changed |= prior != next;
            if let Some((_, occurrence, revision)) = accepted.get(&id) {
                let previous:Option<(String,i64,String)>=tx.query_row("SELECT occurrence_id,revision,profile_id FROM frame_hand_projection WHERE frame_id=?",[&id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(err)?;
                if previous.is_some_and(|(old_occurrence, old_revision, old_profile)| {
                    old_profile == profile_id
                        && old_occurrence.as_str() == occurrence.as_str()
                        && old_revision > *revision
                }) {
                    return Err("409:Effective hand snapshot is stale".into());
                }
            }
        }
        tx.execute("DELETE FROM frame_hand_projection", [])
            .map_err(err)?;
        for (frame, hand, occurrence, revision) in entries {
            tx.execute("INSERT INTO frame_hand_projection(frame_id,profile_id,hand_id,occurrence_id,revision) VALUES(?,?,?,?,?)",params![frame,profile_id,hand,occurrence,revision]).map_err(err)?;
        }
        if changed {
            tx.execute(
                "UPDATE list_frame_revision SET revision=revision+1 WHERE id=1",
                [],
            )
            .map_err(err)?;
            tx.execute(
                "UPDATE list_session_revision SET revision=revision+1 WHERE id=1",
                [],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
}
