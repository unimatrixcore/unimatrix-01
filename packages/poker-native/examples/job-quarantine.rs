use poker_native::lab::gameplay::ai::quarantine;
use rusqlite::{
    backup::Backup, types::ValueRef, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn hash_file(path: &Path) -> Result<String> {
    let mut reader = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        digest.update(&bytes[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn open_read(path: &Path) -> Result<Connection> {
    if !path.is_file() || path.file_name().and_then(|s| s.to_str()) != Some("ocr-evidence.sqlite3")
    {
        return Err("Select an existing global ocr-evidence.sqlite3 ledger".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    guard(&conn)?;
    Ok(conn)
}
fn guard(conn: &Connection) -> Result<()> {
    for table in [
        "gameplay_ai_runs",
        "gameplay_ai_occurrences",
        "queue_items",
        "pixel_assets",
        "ai_review_jobs",
        "ai_review_attempts",
        "gameplay_ai_cache_aliases",
    ] {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table],
            |r| r.get::<_, bool>(0),
        )? {
            return Err("This is not the global Gameplay OCR ledger".into());
        }
    }
    Ok(())
}
fn idle(conn: &Connection) -> Result<()> {
    let busy:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM ai_review_jobs WHERE state IN ('queued','running')) OR EXISTS(SELECT 1 FROM gameplay_ai_runs WHERE json_extract(scope,'$.phase')='preparing')",[],|r|r.get(0))?;
    if busy {
        return Err(
            "Pause preparation and paid jobs before backing up or activating cache features".into(),
        );
    }
    Ok(())
}
fn integrity(conn: &Connection) -> Result<()> {
    let rows = conn
        .prepare("PRAGMA integrity_check")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows != ["ok"] {
        return Err("SQLite integrity check failed".into());
    }
    Ok(())
}
fn snapshot(conn: &Connection) -> Result<Value> {
    let tables=conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='gameplay_ai_quarantine_receipts' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut output = BTreeMap::new();
    for table in tables {
        if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("Unexpected table name".into());
        }
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
        let columns = stmt.column_count();
        let mut rows = stmt.query([])?;
        let mut digest = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next()? {
            count += 1;
            for index in 0..columns {
                match row.get_ref(index)? {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(v) => {
                        digest.update([1]);
                        digest.update(v.to_be_bytes())
                    }
                    ValueRef::Real(v) => {
                        digest.update([2]);
                        digest.update(v.to_bits().to_be_bytes())
                    }
                    ValueRef::Text(v) => {
                        digest.update([3]);
                        digest.update((v.len() as u64).to_be_bytes());
                        digest.update(v)
                    }
                    ValueRef::Blob(v) => {
                        digest.update([4]);
                        digest.update((v.len() as u64).to_be_bytes());
                        digest.update(v)
                    }
                }
            }
        }
        output.insert(
            table,
            json!({"rows":count,"sha256":format!("{:x}",digest.finalize())}),
        );
    }
    Ok(json!(output))
}
fn durable_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

fn atomic_receipt(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    durable_write(&temporary, bytes)?;
    let published = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    published?;
    fs::File::open(path.parent().ok_or("Receipt directory missing")?)?.sync_all()?;
    Ok(())
}

fn dry_run(path: &Path, job: &str, directory: &Path) -> Result<Value> {
    let source = open_read(path)?;
    source.execute_batch("BEGIN")?;
    idle(&source)?;
    let plan = quarantine::inspect(&source, job).map_err(|e| e.message)?;
    let before = snapshot(&source)?;
    fs::create_dir(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let target = directory.join("ocr-evidence.sqlite3");
    let mut destination = Connection::open(&target)?;
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
    {
        Backup::new(&source, &mut destination)?.run_to_completion(
            256,
            Duration::from_millis(2),
            None,
        )?;
    }
    integrity(&destination)?;
    if snapshot(&destination)? != before {
        return Err("Backup snapshot mismatch".into());
    }
    drop(destination);
    source.execute_batch("ROLLBACK")?;
    fs::File::open(&target)?.sync_all()?;
    let receipt = json!({"source_path":fs::canonicalize(path)?,"backup_path":fs::canonicalize(&target)?,"backup_sha256":hash_file(&target)?,"snapshot":before,"plan":plan,"provider_calls":0});
    durable_write(
        &directory.join("dry-run-backup.json"),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    fs::File::open(directory)?.sync_all()?;
    Ok(receipt)
}
fn apply(path: &Path, job: &str, directory: &Path) -> Result<Value> {
    let receipt: Value = serde_json::from_slice(&fs::read(directory.join("dry-run-backup.json"))?)?;
    let target = directory.join("ocr-evidence.sqlite3");
    if receipt["source_path"] != json!(fs::canonicalize(path)?)
        || receipt["plan"]["job_id"] != job
        || receipt["backup_sha256"] != hash_file(&target)?
    {
        return Err("Backup identity mismatch".into());
    }
    let recovery = open_read(&target)?;
    integrity(&recovery)?;
    if snapshot(&recovery)? != receipt["snapshot"] {
        return Err("Backup semantic verification failed".into());
    }
    let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    idle(&tx)?;
    if quarantine::contains(&tx, job).map_err(|e| e.message)? {
        let applied_path = directory.join("applied-receipt.json");
        let mut previous: Value = match fs::read(&applied_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_ai_quarantine_receipts')",
                    [], |r| r.get(0),
                )?;
                let saved: Option<String> = if exists {
                    tx.query_row(
                        "SELECT receipt FROM gameplay_ai_quarantine_receipts WHERE job_id=?",
                        [job],
                        |r| r.get(0),
                    )
                    .optional()?
                } else {
                    None
                };
                serde_json::from_str(
                    &saved.ok_or("Quarantine has no durable applied receipt; audit required")?,
                )?
            }
            Err(error) => return Err(error.into()),
        };
        if previous["job_id"] != job || previous["backup_sha256"] != receipt["backup_sha256"] {
            return Err("Applied receipt identity mismatch".into());
        }
        if !applied_path.exists() {
            atomic_receipt(&applied_path, &serde_json::to_vec_pretty(&previous)?)?;
        }
        previous["already_applied"] = json!(true);
        return Ok(previous);
    }
    if snapshot(&tx)? != receipt["snapshot"] {
        return Err("Ledger changed since backup; repeat dry-run with a new directory".into());
    }
    let applied = quarantine::apply(
        &tx,
        job,
        "Bounded visual audit found wrong automatic labels; entire job provisional until audit",
    )
    .map_err(|e| e.message)?;
    let after = snapshot(&tx)?;
    let result = json!({"job_id":job,"backup_sha256":receipt["backup_sha256"],"before":receipt["snapshot"],"after":after,"result":applied,"provider_calls":0});
    // Excluded from snapshot because a receipt cannot hash its own serialized contents.
    tx.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_quarantine_receipts(job_id TEXT PRIMARY KEY,receipt TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS quarantine_receipt_no_update BEFORE UPDATE ON gameplay_ai_quarantine_receipts BEGIN SELECT RAISE(ABORT,'Quarantine receipt is append-only'); END; CREATE TRIGGER IF NOT EXISTS quarantine_receipt_no_delete BEFORE DELETE ON gameplay_ai_quarantine_receipts BEGIN SELECT RAISE(ABORT,'Quarantine receipt is append-only'); END;")?;
    tx.execute(
        "INSERT INTO gameplay_ai_quarantine_receipts VALUES(?,?)",
        rusqlite::params![job, result.to_string()],
    )?;
    tx.commit()?;
    integrity(&conn)?;
    atomic_receipt(
        &directory.join("applied-receipt.json"),
        &serde_json::to_vec_pretty(&result)?,
    )?;
    fs::File::open(directory)?.sync_all()?;
    Ok(result)
}
fn audit(path: &Path, job: &str) -> Result<Value> {
    use poker_native::lab::gameplay::ai::evidence_cache::{self, Truth};
    let conn = open_read(path)?;
    conn.execute_batch("BEGIN")?;
    if !quarantine::contains(&conn, job).map_err(|e| e.message)? {
        return Err("Job is not quarantined".into());
    }
    let keys=conn.prepare("SELECT DISTINCT a.sample_key FROM gameplay_ai_cache_aliases a WHERE a.cache_key IN (SELECT b.cache_key FROM gameplay_ai_cache_aliases b JOIN ai_review_items i USING(sample_key) WHERE i.job_id=?)")?.query_map([job],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut counts = BTreeMap::<String, usize>::new();
    for key in &keys {
        let kind = match evidence_cache::truth(&conn, key).map_err(|e| e.message)? {
            Truth::Accepted { human: true, .. } => "human",
            Truth::Accepted { human: false, .. } => "other_ai",
            Truth::NeedsReview { .. } => "needs_review",
            Truth::Blocked(_) => "conflict",
            Truth::Pending => "pending",
        };
        *counts.entry(kind.into()).or_default() += 1;
    }
    Ok(
        json!({"job_id":job,"quarantined":true,"alias_keys_audited":keys.len(),"truth_counts":counts,"provider_calls":0}),
    )
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 3 && args[0] == "audit" {
        println!(
            "{}",
            serde_json::to_string_pretty(&audit(Path::new(&args[1]), &args[2])?)?
        );
        return Ok(());
    }
    if args.len() != 4 {
        return Err("Usage: job-quarantine dry-run|apply DB JOB_ID BACKUP_DIRECTORY".into());
    }
    let path = PathBuf::from(&args[1]);
    let result = match args[0].as_str() {
        "dry-run" => dry_run(&path, &args[2], Path::new(&args[3]))?,
        "apply" => apply(&path, &args[2], Path::new(&args[3]))?,
        _ => return Err("Invalid operation".into()),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> PathBuf {
        let path = root.join("ocr-evidence.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE gameplay_ai_runs(run_id TEXT,job_id TEXT,scope TEXT);
CREATE TABLE gameplay_ai_occurrences(id TEXT,sample_key TEXT,revision INTEGER);
CREATE TABLE gameplay_ai_decisions(sample_key TEXT);
CREATE TABLE gameplay_ai_manual(sample_key TEXT);
CREATE TABLE gameplay_ai_cache_aliases(sample_key TEXT,cache_key TEXT);
CREATE TABLE gameplay_ai_cache_components(parent_key TEXT,component_key TEXT);
CREATE TABLE queue_items(sample_key TEXT,label TEXT,reviewed INTEGER,prediction_id TEXT);
CREATE TABLE queue_meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE pixel_assets(pixel_sha256 TEXT,png BLOB);
CREATE TABLE ai_review_jobs(id TEXT PRIMARY KEY,dataset_id TEXT,run_id TEXT,state TEXT,usage TEXT);
CREATE TABLE ai_review_items(job_id TEXT,ordinal INTEGER,sample_key TEXT,state TEXT,result TEXT,prior_label TEXT);
CREATE TABLE ai_review_attempts(id INTEGER,response TEXT);
CREATE TABLE model_predictions(id TEXT,payload TEXT);
CREATE TABLE label_review_events(id INTEGER PRIMARY KEY,sample_key TEXT,label TEXT,prior_label TEXT,pixel_sha256 TEXT,dataset_id TEXT,action TEXT,prediction_id TEXT,created_at INTEGER,schema_valid INTEGER,outside_contract INTEGER);
CREATE TABLE review_samples(sample_key TEXT,label TEXT);
INSERT INTO gameplay_ai_runs VALUES('run','job','{\"phase\":\"prepared\"}');
INSERT INTO gameplay_ai_occurrences VALUES('occ','sample',2);
INSERT INTO gameplay_ai_cache_aliases VALUES('sample','group');
INSERT INTO gameplay_ai_cache_aliases VALUES('child','component-group');
INSERT INTO gameplay_ai_cache_components VALUES('sample','child');
INSERT INTO gameplay_ai_occurrences VALUES('component-occ','child',4);
INSERT INTO queue_items VALUES('sample','Q',1,'prediction');
INSERT INTO pixel_assets VALUES('sha',X'001122');
INSERT INTO ai_review_jobs VALUES('job','gameplay-ai','run','cancelled','{\"requests\":2}');
INSERT INTO ai_review_items VALUES('job',0,'sample','corrected','{\"event_id\":1}','J');
INSERT INTO ai_review_attempts VALUES(1,'paid response preserved');
INSERT INTO model_predictions VALUES('prediction','{\"ai_review_job_id\":\"job\"}');
INSERT INTO label_review_events VALUES(1,'sample','Q','J','sha','gameplay-ai','accepted','prediction',0,1,0);
INSERT INTO review_samples VALUES('sample','Q');").unwrap();
        path
    }
    #[test]
    fn dry_run_backup_apply_preserve_originals_and_reject_changed_ledgers() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path());
        let backup = root.path().join("backup");
        let before = hash_file(&path).unwrap();
        let dry = dry_run(&path, "job", &backup).unwrap();
        assert_eq!(hash_file(&path).unwrap(), before);
        assert_eq!(dry["plan"]["events_to_supersede"], json!([1]));
        let result = apply(&path, "job", &backup).unwrap();
        assert_eq!(result["result"]["applied"], true);
        assert_eq!(result["result"]["revised_occurrences"], 2);
        assert_eq!(
            result["after"]["ai_review_attempts"],
            result["before"]["ai_review_attempts"]
        );
        assert_ne!(
            result["after"]["ai_review_items"],
            result["before"]["ai_review_items"]
        );
        assert_eq!(result["after"]["gameplay_ai_quarantine_items"]["rows"], 1);
        assert_eq!(
            result["after"]["pixel_assets"],
            result["before"]["pixel_assets"]
        );
        assert_eq!(
            hash_file(&backup.join("ocr-evidence.sqlite3")).unwrap(),
            dry["backup_sha256"]
        );
        let current = hash_file(&path).unwrap();
        let again = apply(&path, "job", &backup).unwrap();
        assert_eq!(again["already_applied"], true);
        assert_eq!(hash_file(&path).unwrap(), current);
        assert!(apply(&path, "different-job", &backup).is_err());
        let other = tempfile::tempdir().unwrap();
        let path = fixture(other.path());
        let backup = other.path().join("backup");
        dry_run(&path, "job", &backup).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute("UPDATE queue_items SET label='K'", [])
            .unwrap();
        assert!(apply(&path, "job", &backup).is_err());
        assert!(!quarantine::contains(&conn, "job").unwrap());
        conn.execute("UPDATE ai_review_jobs SET state='running'", [])
            .unwrap();
        assert!(dry_run(&path, "job", &other.path().join("busy")).is_err());
    }
    #[test]
    fn missing_receipt_recovers_committed_result_without_reapplying() {
        let root = tempfile::tempdir().unwrap();
        let path = fixture(root.path());
        let backup = root.path().join("backup");
        dry_run(&path, "job", &backup).unwrap();
        let applied = apply(&path, "job", &backup).unwrap();
        fs::remove_file(backup.join("applied-receipt.json")).unwrap();
        let committed = hash_file(&path).unwrap();
        let recovered = apply(&path, "job", &backup).unwrap();
        assert_eq!(recovered["already_applied"], true);
        assert_eq!(recovered["result"], applied["result"]);
        assert_eq!(recovered["after"], applied["after"]);
        assert_eq!(hash_file(&path).unwrap(), committed);
        let durable: Value =
            serde_json::from_slice(&fs::read(backup.join("applied-receipt.json")).unwrap())
                .unwrap();
        assert_eq!(durable, applied);
        assert_eq!(apply(&path, "job", &backup).unwrap(), recovered);
        let conn = Connection::open(&path).unwrap();
        assert!(conn
            .execute("DELETE FROM gameplay_ai_quarantine_receipts", [])
            .is_err());
        let mut mismatched = applied;
        mismatched["backup_sha256"] = json!("wrong-backup");
        fs::write(
            backup.join("applied-receipt.json"),
            serde_json::to_vec(&mismatched).unwrap(),
        )
        .unwrap();
        assert!(apply(&path, "job", &backup)
            .unwrap_err()
            .to_string()
            .contains("Applied receipt identity mismatch"));
    }
}
