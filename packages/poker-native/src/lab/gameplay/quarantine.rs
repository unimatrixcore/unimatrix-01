use crate::lab::{conflict, now_ms, LabResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    os::fd::AsRawFd,
    path::PathBuf,
};

pub struct LedgerOperationGuard {
    file: File,
    database: PathBuf,
}

impl Drop for LedgerOperationGuard {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn database_path(conn: &Connection) -> LabResult<PathBuf> {
    let path = conn
        .path()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| conflict("Preparation ownership requires a file-backed ledger"))?;
    Ok(std::fs::canonicalize(path)?)
}

/// Hold before preparation's first durable write until its final handoff or error.
/// The lock file must never be unlinked: all processes must lock the same inode.
pub fn lock_preparation(conn: &Connection) -> LabResult<LedgerOperationGuard> {
    let database = database_path(conn)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(database.with_extension("preparation.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err(conflict(
                "Stop active preparation or quarantine before ledger operation",
            ));
        }
        return Err(error.into());
    }
    Ok(LedgerOperationGuard { file, database })
}

pub fn lock_idle(conn: &Connection) -> LabResult<LedgerOperationGuard> {
    let guard = lock_preparation(conn)?;
    idle_jobs(conn)?;
    Ok(guard)
}

impl LedgerOperationGuard {
    fn check(&self, conn: &Connection) -> LabResult<()> {
        if database_path(conn)? != self.database {
            return Err(conflict("Preparation guard belongs to a different ledger"));
        }
        Ok(())
    }

    pub fn inspect(&self, conn: &Connection, job: &str) -> LabResult<Value> {
        self.check(conn)?;
        inspect_locked(conn, job)
    }

    pub fn apply(&self, conn: &Connection, job: &str, reason: &str) -> LabResult<Value> {
        self.check(conn)?;
        apply_locked(conn, job, reason)
    }
}

fn idle_jobs(conn: &Connection) -> LabResult<()> {
    let busy: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running'))",
        [],
        |r| r.get(0),
    )?;
    if busy {
        return Err(conflict("Stop active review before ledger quarantine"));
    }
    Ok(())
}

pub fn ensure(conn: &Connection) -> LabResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_job_quarantines(job_id TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at INTEGER NOT NULL,provenance TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gameplay_ai_quarantine_items(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,original_state TEXT NOT NULL,original_result TEXT,PRIMARY KEY(job_id,ordinal));
CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_items_no_update BEFORE UPDATE ON gameplay_ai_quarantine_items BEGIN SELECT RAISE(ABORT,'Quarantine item provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_items_no_delete BEFORE DELETE ON gameplay_ai_quarantine_items BEGIN SELECT RAISE(ABORT,'Quarantine item provenance is append-only'); END;
CREATE TABLE IF NOT EXISTS gameplay_ai_quarantine_supersessions(job_id TEXT NOT NULL,source_event_id INTEGER NOT NULL,superseding_event_id INTEGER NOT NULL UNIQUE,PRIMARY KEY(job_id,source_event_id));
CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_no_update BEFORE UPDATE ON gameplay_ai_job_quarantines BEGIN SELECT RAISE(ABORT,'Job quarantine is append-only'); END;
CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_no_delete BEFORE DELETE ON gameplay_ai_job_quarantines BEGIN SELECT RAISE(ABORT,'Job quarantine is append-only'); END;
CREATE TRIGGER IF NOT EXISTS gameplay_supersession_no_update BEFORE UPDATE ON gameplay_ai_quarantine_supersessions BEGIN SELECT RAISE(ABORT,'Quarantine provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS gameplay_supersession_no_delete BEFORE DELETE ON gameplay_ai_quarantine_supersessions BEGIN SELECT RAISE(ABORT,'Quarantine provenance is append-only'); END;
")?;
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ai_review_jobs')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        conn.execute_batch("CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_resume BEFORE UPDATE OF state ON ai_review_jobs WHEN NEW.state IN ('queued','running') AND EXISTS(SELECT 1 FROM gameplay_ai_job_quarantines WHERE job_id=NEW.id) BEGIN SELECT RAISE(ABORT,'Job quarantined; audit required before paid review'); END;
CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_start BEFORE INSERT ON ai_review_jobs WHEN EXISTS(SELECT 1 FROM gameplay_ai_runs r JOIN gameplay_ai_job_quarantines q ON q.job_id=r.job_id WHERE r.run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'Run quarantined; audit required before paid review'); END;
")?;
    }
    conn.execute_batch("CREATE TRIGGER IF NOT EXISTS gameplay_quarantine_queue BEFORE UPDATE OF reviewed ON queue_items WHEN NEW.reviewed=1 AND (SELECT action FROM label_review_events WHERE sample_key=NEW.sample_key ORDER BY id DESC LIMIT 1)='quarantined' BEGIN SELECT RAISE(ABORT,'Quarantined evidence cannot be marked reviewed'); END;")?;
    Ok(())
}

pub fn contains(conn: &Connection, job: &str) -> LabResult<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_ai_job_quarantines')",
        [],
        |r| r.get(0),
    )?;
    Ok(exists
        && conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM gameplay_ai_job_quarantines WHERE job_id=?)",
            [job],
            |r| r.get(0),
        )?)
}

pub fn guard(conn: &Connection, job: &str) -> LabResult<()> {
    if contains(conn, job)? {
        return Err(conflict(
            "Job quarantined; automatic outcomes are provisional pending audit",
        ));
    }
    Ok(())
}

fn idle(conn: &Connection, job: &str) -> LabResult<()> {
    let state: Option<String> = conn
        .query_row(
            "SELECT state FROM ai_review_jobs WHERE id=? AND dataset_id='gameplay-ai'",
            [job],
            |r| r.get(0),
        )
        .optional()?;
    if !state
        .as_deref()
        .is_some_and(|s| ["cancelled", "interrupted", "failed", "completed"].contains(&s))
    {
        return Err(conflict("Quarantine requires a stopped Gameplay job"));
    }
    idle_jobs(conn)
}

const CURRENT_EVENTS: &str = "SELECT e.id,e.sample_key,e.label,e.prior_label,e.pixel_sha256,e.dataset_id FROM label_review_events e LEFT JOIN model_predictions p ON p.id=e.prediction_id WHERE e.action='accepted' AND json_extract(p.payload,'$.ai_review_job_id')=?1 AND e.id IN (SELECT json_extract(result,'$.event_id') FROM ai_review_items WHERE job_id=?1) AND e.id=(SELECT MAX(x.id) FROM label_review_events x WHERE x.sample_key=e.sample_key) AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.sample_key=e.sample_key) AND NOT EXISTS(SELECT 1 FROM gameplay_ai_manual m WHERE m.sample_key=e.sample_key)";
const AFFECTED: &str = "WITH RECURSIVE affected(cache_key) AS (SELECT a.cache_key FROM gameplay_ai_cache_aliases a JOIN ai_review_items i USING(sample_key) WHERE i.job_id=?1 UNION SELECT a.cache_key FROM affected f JOIN gameplay_ai_cache_aliases child ON child.cache_key=f.cache_key JOIN gameplay_ai_cache_components c ON c.component_key=child.sample_key JOIN gameplay_ai_cache_aliases a ON a.sample_key=c.parent_key UNION SELECT child.cache_key FROM affected f JOIN gameplay_ai_cache_aliases parent ON parent.cache_key=f.cache_key JOIN gameplay_ai_cache_components c ON c.parent_key=parent.sample_key JOIN gameplay_ai_cache_aliases child ON child.sample_key=c.component_key) SELECT DISTINCT o.id FROM gameplay_ai_occurrences o JOIN gameplay_ai_cache_aliases a USING(sample_key) JOIN affected f USING(cache_key)";

pub fn inspect(conn: &Connection, job: &str) -> LabResult<Value> {
    lock_idle(conn)?.inspect(conn, job)
}

fn inspect_locked(conn: &Connection, job: &str) -> LabResult<Value> {
    idle(conn, job)?;
    let states = conn
        .prepare("SELECT state,count(*) FROM ai_review_items WHERE job_id=? GROUP BY state")?
        .query_map([job], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>()?;
    let events = conn
        .prepare(CURRENT_EVENTS)?
        .query_map([job], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let occurrences = conn
        .prepare(AFFECTED)?
        .query_map([job], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let usage: String =
        conn.query_row("SELECT usage FROM ai_review_jobs WHERE id=?", [job], |r| {
            r.get(0)
        })?;
    Ok(
        json!({"job_id":job,"already_quarantined":contains(conn,job)?,"item_states":states,"events_to_supersede":events,"affected_occurrence_ids":occurrences,"usage":serde_json::from_str::<Value>(&usage)?,"provider_calls":0}),
    )
}

// The caller holds an IMMEDIATE transaction so job transitions and projection updates are atomic.
pub fn apply(conn: &Connection, job: &str, reason: &str) -> LabResult<Value> {
    lock_idle(conn)?.apply(conn, job, reason)
}

fn apply_locked(conn: &Connection, job: &str, reason: &str) -> LabResult<Value> {
    if conn.is_autocommit() || reason.trim().is_empty() {
        return Err(conflict(
            "Quarantine requires a transaction and an audit reason",
        ));
    }
    let before = inspect_locked(conn, job)?;
    if contains(conn, job)? {
        return Ok(json!({"before":before,"applied":false,"provider_calls":0}));
    }
    ensure(conn)?;
    conn.execute(
        "INSERT INTO gameplay_ai_job_quarantines VALUES(?,?,?,?)",
        params![job, reason, now_ms(), before.to_string()],
    )?;
    let events = conn
        .prepare(CURRENT_EVENTS)?
        .query_map([job], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut supersessions = Vec::new();
    for (source, key, label, prior, pixels, dataset) in events {
        conn.execute("INSERT INTO label_review_events(sample_key,prior_label,label,action,pixel_sha256,dataset_id,created_at,schema_valid,outside_contract) VALUES(?,?,?,'quarantined',?,?,?,0,0)",params![key,label,prior,pixels,dataset,now_ms()])?;
        let event = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO gameplay_ai_quarantine_supersessions VALUES(?,?,?)",
            params![job, source, event],
        )?;
        conn.execute(
            "UPDATE review_samples SET label=? WHERE sample_key=?",
            params![prior, key],
        )?;
        conn.execute(
            "UPDATE queue_items SET label=?,reviewed=0,prediction_id=NULL WHERE sample_key=?",
            params![prior, key],
        )?;
        supersessions
            .push(json!({"source_event_id":source,"superseding_event_id":event,"sample_key":key}));
    }
    conn.execute("INSERT INTO gameplay_ai_quarantine_items SELECT job_id,ordinal,state,result FROM ai_review_items WHERE job_id=?",[job])?;
    let flagged=conn.execute("UPDATE ai_review_items SET state='flagged',result=json_set(COALESCE(result,'{}'),'$.state','flagged','$.outcome','flagged','$.label',prior_label,'$.quarantined',json('true'),'$.reason',?2) WHERE job_id=?1 AND state!='pending'",params![job,format!("Job quarantined; automatic outcomes are provisional pending audit: {reason}")])?;
    let affected = before["affected_occurrence_ids"].as_array().unwrap();
    for id in affected {
        conn.execute(
            "UPDATE gameplay_ai_occurrences SET revision=revision+1 WHERE id=?",
            [id.as_str().unwrap()],
        )?;
    }
    conn.execute("UPDATE gameplay_ai_runs SET scope=json_set(scope,'$.quarantined',json('true'),'$.quarantine_reason',?2) WHERE job_id=?1",params![job,reason])?;
    conn.execute("UPDATE queue_meta SET value=json_set(value,'$.paused',json('true'),'$.state','quarantined') WHERE key='gameplay_workflow' AND json_extract(value,'$.run_id') IN (SELECT run_id FROM gameplay_ai_runs WHERE job_id=?)",[job])?;
    conn.execute("INSERT INTO queue_meta(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(
        json!({"before":before,"applied":true,"supersessions":supersessions,"revised_occurrences":affected.len(),"flagged_current_items":flagged,"visually_verified":false,"provider_calls":0}),
    )
}
