use super::*;

pub(super) fn request_evidence(guide: &Value, pixels: &str, sample: &str, group: &str) -> Value {
    json!({"guide_sha256":super::super::sha256(guide.to_string().as_bytes()),"pixel_sha256":pixels,"sample_key":sample,"group_name":group})
}
fn original_raw(row: &Value) -> LabResult<&str> {
    row["raw_text"]
        .as_str()
        .ok_or_else(|| conflict("Saved raw transcription is missing; recovery rejected"))
}

pub(super) fn import(
    conn: &Connection,
    ctx: &DatasetContext,
    source: &str,
    target: &str,
) -> LabResult<()> {
    if ctx.id != "gameplay-ai" || !super::super::gameplay::ai::quarantine::contains(conn, source)? {
        return Err(conflict("Recovery requires a quarantined Gameplay job"));
    }
    let old = AiReviewManager::job(conn, ctx, source)?;
    let new = AiReviewManager::job(conn, ctx, target)?;
    if old["model"] != new["model"] {
        return Err(conflict("Recovery model changed; fresh review required"));
    }
    let scopes: Vec<Value> = rows(
        conn,
        "SELECT profile_id,session_id,scope FROM gameplay_ai_runs WHERE job_id IN (?,?)",
        params![source, target],
    )?;
    if scopes.len() != 2 {
        return Err(conflict("Recovery requires two frozen scopes"));
    }
    let left: Value = serde_json::from_str(scopes[0]["scope"].as_str().unwrap())?;
    let right: Value = serde_json::from_str(scopes[1]["scope"].as_str().unwrap())?;
    if scopes[0]["session_id"] != scopes[1]["session_id"]
        || scopes[0]["profile_id"] != scopes[1]["profile_id"]
        || left["validation_sha256"] != right["validation_sha256"]
        || left["validation_sha256"] != super::super::sha256(crate::labels::CONTRACT_BYTES)
    {
        return Err(conflict(
            "Recovery extraction or validation changed; fresh bounded reads required",
        ));
    }
    if left["review_policy"] != super::super::gameplay::ai::evidence_cache::REVIEW_POLICY
        && right["review_policy"] != super::super::gameplay::ai::evidence_cache::REVIEW_POLICY
    {
        return Err(conflict("Recovery target must use current review policy"));
    }
    let usage: Value = serde_json::from_str(old["usage"].as_str().unwrap_or("{}"))?;
    if usage
        .get("reading_contract")
        .is_some_and(|v| v != protocol::READING_CONTRACT)
        || usage["diagnostic_only"] == true
        || usage["evidence_policy"].as_str().unwrap_or("") != "gameplay_family_blind_v1"
    {
        return Err(conflict(
            "Recovery prompt semantics are incompatible; fresh bounded reads required",
        ));
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ai_review_recovered_observations(target_job TEXT NOT NULL,target_ordinal INTEGER NOT NULL,phase TEXT NOT NULL,source_job TEXT NOT NULL,source_batch INTEGER NOT NULL,source_ordinal INTEGER NOT NULL,response_id TEXT NOT NULL,reading TEXT NOT NULL,PRIMARY KEY(target_job,target_ordinal,phase));
CREATE TRIGGER IF NOT EXISTS recovered_no_update BEFORE UPDATE ON ai_review_recovered_observations BEGIN SELECT RAISE(ABORT,'Recovery provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS recovered_no_delete BEFORE DELETE ON ai_review_recovered_observations BEGIN SELECT RAISE(ABORT,'Recovery provenance is immutable'); END;")?;
    let pending_table: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_ai_request_intents')",
        [],
        |r| r.get(0),
    )?;
    if pending_table && conn.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_request_intents WHERE job_id=? AND state!='received')",[source],|r|r.get::<_,bool>(0))? {
        return Err(conflict("Quarantined provider request has unknown outcome; recovery blocked"));
    }
    let mut query=conn.prepare(&format!("SELECT i.*,{} AS crop,q.payload AS visual_evidence FROM ai_review_items i JOIN queue_items q ON q.queue_id=i.queue_id WHERE i.job_id=? ORDER BY ordinal",super::super::pixel_assets::expression(conn,"q")?))?;
    let current = query
        .query_map([target], item)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for item in current {
        if super::super::review::image_identity(&item.crop)?.1 != item.pixel_sha256 {
            return Err(conflict("Recovery pixel identity changed"));
        }
        let previous:Option<(i64,i64,Option<String>,Option<String>)>=conn.query_row("SELECT i.ordinal,i.batch_index,b.response,b.verification FROM ai_review_items i JOIN ai_review_batches b USING(job_id,batch_index) WHERE i.job_id=? AND i.sample_key=? AND i.pixel_sha256=? AND i.group_name=?",params![source,item.sample_key,item.pixel_sha256,item.group_name],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((ordinal, batch, first, second)) = previous else {
            continue;
        };
        for (phase, saved) in [("review", first), ("verification", second)] {
            let Some(saved) = saved else { continue };
            let saved: Value = serde_json::from_str(&saved)?;
            let row = &saved[ordinal.to_string()];
            if row.is_null() {
                continue;
            }
            let Some(response) = saved["_response"]["id"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            if phase == "verification" && conn.query_row("SELECT EXISTS(SELECT 1 FROM ai_review_recovered_observations WHERE target_job=? AND target_ordinal=? AND phase='review' AND response_id=?)",params![target,item.ordinal,response],|r|r.get::<_,bool>(0))? { continue; }
            let original = original_raw(row)?;
            let evidence = request_evidence(
                &item.guide,
                &item.pixel_sha256,
                &item.sample_key,
                &item.group_name,
            );
            if row["request_evidence"] != evidence {
                // Missing historical request evidence requires a fresh bounded read.
                continue;
            }
            let raw = json!({"id":item.ordinal.to_string(),"text":original,"clarity":row["clarity"],"reason":row["reason"]});
            let response_body = json!({"output_text":json!({"items":[raw]}).to_string()});
            let Ok(parsed) = protocol::parse(&response_body, std::slice::from_ref(&item)) else {
                continue;
            };
            let mut reading = parsed[&item.ordinal.to_string()].clone();
            reading["_response"] = saved["_response"].clone();
            reading["request_evidence"] = evidence;
            reading["observation_provenance"] = json!({"job_id":source,"batch_index":batch,"ordinal":ordinal,"phase":phase,"response_id":response,"reading_contract":protocol::READING_CONTRACT,"guide_sha256":super::super::sha256(item.guide.to_string().as_bytes()),"pixel_sha256":item.pixel_sha256});
            conn.execute(
                "INSERT OR IGNORE INTO ai_review_recovered_observations VALUES(?,?,?,?,?,?,?,?)",
                params![
                    target,
                    item.ordinal,
                    phase,
                    source,
                    batch,
                    ordinal,
                    response,
                    reading.to_string()
                ],
            )?;
            let column = if phase == "review" {
                "response"
            } else {
                "verification"
            };
            let existing: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT {column} FROM ai_review_batches WHERE job_id=? AND batch_index=?"
                    ),
                    params![target, item.batch_index],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let mut value: Value = existing
                .map(|v| serde_json::from_str(&v))
                .transpose()?
                .unwrap_or_else(|| json!({}));
            value[item.ordinal.to_string()] = reading;
            conn.execute(&format!("INSERT INTO ai_review_batches(job_id,batch_index,{column}) VALUES(?,?,?) ON CONFLICT(job_id,batch_index) DO UPDATE SET {column}=excluded.{column}"),params![target,item.batch_index,value.to_string()])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_raw_text_is_not_a_blank() {
        assert!(original_raw(&json!({"clarity":"blank"})).is_err());
        assert!(original_raw(&json!({"clarity":"blank","raw_text":null})).is_err());
        assert_eq!(
            original_raw(&json!({"clarity":"blank","raw_text":""})).unwrap(),
            ""
        );
    }
    #[test]
    fn original_guide_is_required_and_target_changes_are_distinct() {
        let original = request_evidence(
            &json!({"anchor":{"x":1,"y":2}}),
            "pixels",
            "sample",
            "family",
        );
        assert_ne!(original, Value::Null);
        assert_ne!(
            original,
            request_evidence(
                &json!({"anchor":{"x":8,"y":2}}),
                "pixels",
                "sample",
                "family"
            )
        );
        assert_ne!(
            original,
            request_evidence(
                &json!({"anchor":{"x":1,"y":2}}),
                "other",
                "sample",
                "family"
            )
        );
    }
}
