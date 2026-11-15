use poker_native::lab::gameplay::ai::evidence_cache;
use rusqlite::{backup::Backup, types::ValueRef, Connection, OpenFlags, TransactionBehavior};
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
    let tables=conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') AND name!='gameplay_ai_cache_normalized' ORDER BY name")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
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
fn metrics(conn: &Connection) -> Result<Value> {
    Ok(
        json!({"attempts":conn.query_row("SELECT count(*) FROM ai_review_attempts",[],|r|r.get::<_,i64>(0))?,"normalized_enabled":evidence_cache::normalized_enabled(conn).map_err(|e|e.message)?,"normalized_rows":if evidence_cache::normalized_enabled(conn).map_err(|e|e.message)?{conn.query_row("SELECT count(*) FROM gameplay_ai_cache_normalized",[],|r|r.get::<_,i64>(0))?}else{0}}),
    )
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
fn backup(path: &Path, directory: &Path) -> Result<Value> {
    let source = open_read(path)?;
    source.execute_batch("BEGIN")?;
    idle(&source)?;
    let before = snapshot(&source)?;
    fs::create_dir(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let target = directory.join("ocr-evidence.sqlite3");
    let mut destination = Connection::open(&target)?;
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
    {
        let copy = Backup::new(&source, &mut destination)?;
        copy.run_to_completion(256, Duration::from_millis(2), None)?;
    }
    integrity(&destination)?;
    if snapshot(&destination)? != before {
        return Err("Backup semantic snapshot differs".into());
    }
    let before_metrics = metrics(&source)?;
    source.execute_batch("ROLLBACK")?;
    drop(destination);
    fs::File::open(&target)?.sync_all()?;
    let receipt = json!({"source_path":fs::canonicalize(path)?,"backup_path":fs::canonicalize(&target)?,"backup_sha256":hash_file(&target)?,"snapshot":before,"metrics":before_metrics,"provider_calls":0});
    durable_write(
        &directory.join("backup-receipt.json"),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    fs::File::open(directory)?.sync_all()?;
    Ok(receipt)
}
fn activate(path: &Path, directory: &Path) -> Result<Value> {
    let receipt: Value = serde_json::from_slice(&fs::read(directory.join("backup-receipt.json"))?)?;
    let target = directory.join("ocr-evidence.sqlite3");
    if receipt["source_path"] != json!(fs::canonicalize(path)?)
        || receipt["backup_sha256"] != hash_file(&target)?
    {
        return Err("Backup path or SHA verification failed".into());
    }
    let recovery = open_read(&target)?;
    integrity(&recovery)?;
    if snapshot(&recovery)? != receipt["snapshot"] {
        return Err("Backup semantic verification failed".into());
    }
    let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    guard(&conn)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    idle(&tx)?;
    let before = snapshot(&tx)?;
    let before_metrics = metrics(&tx)?;
    if before != receipt["snapshot"] || before_metrics["attempts"] != receipt["metrics"]["attempts"]
    {
        return Err("Ledger changed since backup; create a new consistent backup".into());
    }
    evidence_cache::enable_normalized(&tx).map_err(|e| e.message)?;
    if snapshot(&tx)? != before
        || metrics(&tx)?["normalized_rows"] != before_metrics["normalized_rows"]
    {
        return Err("Activation changed existing rows".into());
    }
    tx.commit()?;
    integrity(&conn)?;
    let result = json!({"source_path":fs::canonicalize(path)?,"backup_path":fs::canonicalize(&target)?,"backup_sha256":hash_file(&target)?,"before":before_metrics,"after":metrics(&conn)?,"snapshot":before,"policy":evidence_cache::money_shape::POLICY,"backfill_pixel_scans":0,"provider_calls":0});
    let output = directory.join("activation-receipt.json");
    if !output.exists() {
        durable_write(&output, &serde_json::to_vec_pretty(&result)?)?;
        fs::File::open(directory)?.sync_all()?;
    }
    Ok(result)
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 2 {
        return Err(
            "Usage: evidence-cache inspect DB | backup DB NEW_BACKUP_DIR | activate DB BACKUP_DIR"
                .into(),
        );
    }
    let path = PathBuf::from(&args[1]);
    let result = match (args[0].as_str(), args.len()) {
        ("inspect", 2) => {
            let conn = open_read(&path)?;
            json!({"metrics":metrics(&conn)?,"source_path":fs::canonicalize(path)?})
        }
        ("backup", 3) => backup(&path, Path::new(&args[2]))?,
        ("activate", 3) => activate(&path, Path::new(&args[2]))?,
        _ => return Err("Invalid arguments".into()),
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
        conn.execute_batch("CREATE TABLE gameplay_ai_runs(run_id TEXT PRIMARY KEY,scope TEXT);CREATE TABLE gameplay_ai_occurrences(id TEXT PRIMARY KEY,original_prediction TEXT);CREATE TABLE queue_items(sample_key TEXT PRIMARY KEY,crop BLOB,label TEXT);CREATE TABLE pixel_assets(pixel_sha256 TEXT PRIMARY KEY,png BLOB);CREATE TABLE ai_review_jobs(id TEXT PRIMARY KEY,state TEXT);CREATE TABLE ai_review_attempts(id INTEGER PRIMARY KEY,payload TEXT);CREATE TABLE gameplay_ai_cache_aliases(sample_key TEXT PRIMARY KEY,cache_key TEXT);CREATE TABLE gameplay_ai_decisions(id INTEGER PRIMARY KEY,label TEXT);INSERT INTO gameplay_ai_runs VALUES('paused','{\"phase\":\"paused\",\"processed_frames\":50}');INSERT INTO gameplay_ai_occurrences VALUES('original','{\"text\":\"J\",\"model\":\"original\"}');INSERT INTO queue_items VALUES('sample',X'00112233','Q');INSERT INTO pixel_assets VALUES('pixels',X'445566');INSERT INTO ai_review_jobs VALUES('terminal','completed');INSERT INTO gameplay_ai_decisions VALUES(1,'Q');INSERT INTO gameplay_ai_decisions VALUES(2,'J');").unwrap();
        for id in 0..7 {
            conn.execute(
                "INSERT INTO ai_review_attempts VALUES(?,?)",
                rusqlite::params![id, "preserved"],
            )
            .unwrap();
        }
        path
    }
    #[test]
    fn backup_activate_and_restart_preserve_every_original_row_and_require_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture(dir.path());
        let recovery = dir.path().join("backup");
        let original_hash = hash_file(&path).unwrap();
        let receipt = backup(&path, &recovery).unwrap();
        assert_eq!(hash_file(&path).unwrap(), original_hash);
        assert_eq!(
            fs::metadata(&recovery).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(recovery.join("ocr-evidence.sqlite3"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let enabled = activate(&path, &recovery).unwrap();
        assert_eq!(enabled["after"]["attempts"], 7);
        assert_eq!(enabled["snapshot"], receipt["snapshot"]);
        let enabled_hash = hash_file(&path).unwrap();
        activate(&path, &recovery).unwrap();
        assert_eq!(hash_file(&path).unwrap(), enabled_hash);
        assert_eq!(
            hash_file(&recovery.join("ocr-evidence.sqlite3")).unwrap(),
            receipt["backup_sha256"].as_str().unwrap()
        );
    }
    #[test]
    fn rejects_legacy_active_work_and_changed_or_corrupt_backups_before_activation() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        fs::create_dir(&legacy).unwrap();
        let legacy = legacy.join("ocr-evidence.sqlite3");
        Connection::open(&legacy)
            .unwrap()
            .execute_batch("CREATE TABLE samples(id TEXT)")
            .unwrap();
        assert!(open_read(&legacy).is_err());
        let path = fixture(dir.path());
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE gameplay_ai_runs SET scope='{\"phase\":\"preparing\"}'",
            [],
        )
        .unwrap();
        assert!(backup(&path, &dir.path().join("busy")).is_err());
        assert!(!dir.path().join("busy").exists());
        conn.execute(
            "UPDATE gameplay_ai_runs SET scope='{\"phase\":\"paused\"}'",
            [],
        )
        .unwrap();
        let recovery = dir.path().join("recovery");
        backup(&path, &recovery).unwrap();
        conn.execute("UPDATE queue_items SET label='K'", [])
            .unwrap();
        assert!(activate(&path, &recovery).is_err());
        assert!(!evidence_cache::normalized_enabled(&conn).unwrap());
        fs::write(recovery.join("ocr-evidence.sqlite3"), b"corrupt").unwrap();
        assert!(activate(&path, &recovery).is_err());
        assert!(!evidence_cache::normalized_enabled(&conn).unwrap());
    }
}
