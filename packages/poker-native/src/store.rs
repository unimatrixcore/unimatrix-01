use crate::{capture, labels::validate_label, media, session, types::*};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct NativeStore {
    root: PathBuf,
    lock_path: PathBuf,
}
pub fn safe_name(name: &str) -> std::result::Result<(), String> {
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
        || name.chars().any(char::is_control)
        || Path::new(name)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe file name".into());
    }
    Ok(())
}
fn plain(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        bail!("Symlinks are not allowed: {}", path.display());
    }
    Ok(())
}
fn safe_child(dir: &Path, name: &str) -> Result<PathBuf> {
    safe_name(name).map_err(|e| anyhow!(e))?;
    plain(dir)?;
    let path = dir.join(name);
    if path.exists() || fs::symlink_metadata(&path).is_ok() {
        plain(&path)?;
    }
    Ok(path)
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn changed(n: impl serde::Serialize) -> Value {
    json!({"changed":n})
}
fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
    Ok(serde_json::from_value(v.clone())?)
}
fn empty(v: &Value) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    let _: Empty = parse(v)?;
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;
    let outcome = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(tmp);
    }
    outcome
}
impl NativeStore {
    pub fn open(root: PathBuf) -> std::result::Result<Self, String> {
        Self::open_inner(root).map_err(|e| format!("{e:#}"))
    }
    fn open_inner(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() {
            bail!("Dataset path must be absolute");
        }
        if root.components().any(|c| matches!(c, Component::ParentDir)) {
            bail!("Dataset path contains parent traversal");
        }
        // Every existing component is checked before creating managed storage.
        for ancestor in root.ancestors() {
            if ancestor.exists() {
                plain(ancestor)?;
            }
        }
        fs::create_dir_all(&root)?;
        plain(&root)?;
        let root = root.canonicalize()?;
        let lock_path = root.with_extension("poker-lock");
        if lock_path.exists() {
            plain(&lock_path)?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        lock.lock()?;
        let marker = root.join(".poker-managed");
        if !marker.exists() {
            if fs::read_dir(&root)?.next().is_some() {
                bail!("Refusing to adopt nonempty unmanaged dataset; import it into a new managed directory");
            }
            fs::write(&marker, b"unimatrix-poker-v1\n")?;
        } else {
            plain(&marker)?;
        }
        for name in ["images", "full_captures"] {
            let path = root.join(name);
            if path.exists() {
                plain(&path)?;
            }
            fs::create_dir_all(path)?;
        }
        let store = Self { root, lock_path };
        store.connect()?;
        Ok(store)
    }
    pub fn data_dir(&self) -> &Path {
        &self.root
    }
    fn connect(&self) -> Result<Connection> {
        plain(&self.root.join(".poker-managed"))?;
        for name in ["data.db", "data.db-wal", "data.db-shm"] {
            let path = self.root.join(name);
            if path.exists() || fs::symlink_metadata(&path).is_ok() {
                plain(&path)?;
            }
        }
        let conn = Connection::open(self.root.join("data.db"))?;
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS full_captures(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT UNIQUE,monitor TEXT,timestamp INTEGER,regions_hash TEXT);
CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT UNIQUE,phash TEXT,label TEXT,region_id TEXT,source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER,FOREIGN KEY(source_id) REFERENCES full_captures(id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS session_progress(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT);
CREATE TABLE IF NOT EXISTS session_history(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,data TEXT);
CREATE TABLE IF NOT EXISTS unimatrix_decisions(filename TEXT PRIMARY KEY,decision TEXT CHECK(decision IN ('label','blank')),provenance TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS unimatrix_imports(id INTEGER PRIMARY KEY,source_path TEXT,imported_at INTEGER,raw_session TEXT);
CREATE TABLE IF NOT EXISTS unimatrix_session_archive(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,data TEXT);")?;
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(images)")?
            .query_map([], |row| row.get(1))?
            .collect::<rusqlite::Result<_>>()?;
        for col in ["x", "y", "w", "h"] {
            if !columns.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE images ADD COLUMN {col} INTEGER"))?;
            }
        }
        Ok(conn)
    }
    pub fn request(
        &mut self,
        operation: &str,
        payload: &Value,
    ) -> std::result::Result<Value, String> {
        let outcome = (|| {
            plain(&self.lock_path)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.lock_path)?;
            lock.lock()?;
            self.dispatch(operation, payload)
        })();
        outcome.map_err(|e: anyhow::Error| format!("{e:#}"))
    }
    fn regions(&self) -> Result<RegionSettings> {
        let path = self.root.join("regions.json");
        if !path.exists() {
            return Ok(RegionSettings::default());
        }
        plain(&path)?;
        let config: RegionSettings = serde_json::from_slice(&fs::read(path)?)?;
        config.validate().map_err(|e| anyhow!(e))?;
        Ok(config)
    }
    fn read_session(conn: &Connection) -> Result<Session> {
        let raw: Option<String> = conn
            .query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw
            .map(|r| serde_json::from_str::<Value>(&r))
            .transpose()?
            .map(|v| session::normalize(&v))
            .unwrap_or_default())
    }
    fn write_session(conn: &Connection, s: &Session) -> Result<()> {
        conn.execute("INSERT INTO session_progress(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[serde_json::to_string(s)?])?;
        Ok(())
    }
    fn settings(conn: &Connection) -> Result<Settings> {
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='config'", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw
            .map(|r| serde_json::from_str::<Value>(&r))
            .transpose()?
            .map(|v| session::settings(&v))
            .unwrap_or_default())
    }
    fn stats(conn: &Connection) -> Result<Value> {
        let images: i64 = conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
        let captures: i64 =
            conn.query_row("SELECT COUNT(*) FROM full_captures", [], |r| r.get(0))?;
        let empty: i64 = conn.query_row(
            "SELECT COUNT(*) FROM images WHERE COALESCE(label,'')=''",
            [],
            |r| r.get(0),
        )?;
        let by_region: BTreeMap<String, i64> = conn
            .prepare("SELECT COALESCE(region_id,''),COUNT(*) FROM images GROUP BY region_id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(
            json!({"images":images,"captures":captures,"emptyLabels":empty,"byRegion":by_region,"metrics":crate::statistics::dataset_metrics(conn)?}),
        )
    }
    fn dispatch(&mut self, operation: &str, payload: &Value) -> Result<Value> {
        match operation {
            "bootstrap" => {
                empty(payload)?;
                let conn = self.connect()?;
                let config = self.regions()?;
                let (monitors, mut warnings) = match capture::monitors() {
                    Ok(m) if !m.is_empty() => (m, vec![]),
                    Ok(m) => (
                        m,
                        vec!["No monitors available; capture is disabled".to_owned()],
                    ),
                    Err(e) => (vec![], vec![e]),
                };
                let report_path = self.root.join("import-report.json");
                if report_path.exists() {
                    plain(&report_path)?;
                    let report: Value = serde_json::from_slice(&fs::read(report_path)?)?;
                    let images = report["missingImageCount"].as_u64().unwrap_or(0);
                    let captures = report["missingCaptureCount"].as_u64().unwrap_or(0);
                    if images > 0 || captures > 0 {
                        warnings.push(format!("Imported legacy dataset references {images} missing crop files and {captures} missing master captures. Original rows are preserved; see import-report.json."));
                    }
                }
                let mut settings = Self::settings(&conn)?;
                if settings.monitor.is_empty() {
                    if let Some(m) = monitors.first() {
                        settings.monitor = m.name.clone();
                    }
                }
                let history: Vec<Value> = conn
                    .prepare("SELECT timestamp,data FROM session_history ORDER BY timestamp DESC")?
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                    .map(|r| {
                        let (ts, data) = r?;
                        Ok(json!({"timestamp":ts,"data":serde_json::from_str::<Value>(&data)?}))
                    })
                    .collect::<Result<_>>()?;
                Ok(
                    json!({"dataDir":self.root,"monitors":monitors,"warnings":warnings,"settings":settings,"session":Self::read_session(&conn)?,"history":history,"stats":Self::stats(&conn)?,"regions":config.regions,"screenWidth":config.screen_width,"screenHeight":config.screen_height}),
                )
            }
            "entries" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    search: String,
                    offset: u32,
                    limit: u32,
                }
                let p: P = parse(payload)?;
                if !(1..=250).contains(&p.limit) || p.search.len() > 512 {
                    bail!("Invalid entry query");
                }
                let conn = self.connect()?;
                let pattern = format!("%{}%", p.search);
                let total:i64=conn.query_row("SELECT COUNT(*) FROM images WHERE filename LIKE ?1 OR COALESCE(label,'') LIKE ?1 OR region_id LIKE ?1",[&pattern],|r|r.get(0))?;
                let items:Vec<Value>=conn.prepare("SELECT i.filename,COALESCE(i.region_id,''),COALESCE(i.label,''),COALESCE(i.phash,''),c.filename,i.x,i.y,i.w,i.h,d.decision FROM images i LEFT JOIN full_captures c ON i.source_id=c.id LEFT JOIN unimatrix_decisions d ON d.filename=i.filename WHERE i.filename LIKE ?1 OR COALESCE(i.label,'') LIKE ?1 OR i.region_id LIKE ?1 ORDER BY i.timestamp DESC,i.id DESC LIMIT ?2 OFFSET ?3")?.query_map(params![pattern,p.limit,p.offset],|r|{let rect=match(r.get::<_,Option<u32>>(5)?,r.get::<_,Option<u32>>(6)?,r.get::<_,Option<u32>>(7)?,r.get::<_,Option<u32>>(8)?){(Some(x),Some(y),Some(w),Some(h)) if w>0&&h>0=>Some(Rect{x,y,w,h}),_=>None};Ok(json!({"filename":r.get::<_,String>(0)?,"regionId":r.get::<_,String>(1)?,"label":r.get::<_,String>(2)?,"phash":r.get::<_,String>(3)?,"source":r.get::<_,Option<String>>(4)?,"rect":rect,"decision":r.get::<_,Option<String>>(9)?}))})?.collect::<rusqlite::Result<_>>()?;
                Ok(json!({"items":items,"total":total}))
            }
            "image" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    filename: String,
                    kind: String,
                }
                let p: P = parse(payload)?;
                let folder = match p.kind.as_str() {
                    "crop" => "images",
                    "capture" => "full_captures",
                    _ => bail!("Invalid image kind"),
                };
                let path = safe_child(&self.root.join(folder), &p.filename)?;
                let bytes = read_bounded(&path)?;
                let image = media::decode_image(&bytes).map_err(|e| anyhow!(e))?;
                Ok(json!({"dataUrl":media::data_url(&media::png(&image).map_err(|e|anyhow!(e))?)}))
            }
            "save_settings" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    settings: Settings,
                }
                let p: P = parse(payload)?;
                if !(1000..=60000).contains(&p.settings.capture_interval_ms)
                    || p.settings.monitor.len() > 255
                    || p.settings.username.len() > 256
                    || serde_json::to_vec(&p.settings)?.len() > 1024 * 1024
                {
                    bail!("Invalid settings");
                }
                let conn = self.connect()?;
                conn.execute("INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&p.settings)?])?;
                Ok(changed(1))
            }
            "save_regions" => {
                let config: RegionSettings = parse(payload)?;
                config.validate().map_err(|e| anyhow!(e))?;
                atomic_write(
                    &self.root.join("regions.json"),
                    &serde_json::to_vec_pretty(&config)?,
                )?;
                Ok(changed(config.regions.len()))
            }
            "save_session" => {
                let s = parse_session(payload)?;
                session::validate(&s).map_err(|e| anyhow!(e))?;
                let mut conn = self.connect()?;
                let tx = conn.transaction()?;
                Self::write_session(&tx, &s)?;
                tx.commit()?;
                Ok(changed(1))
            }
            "clear_session" => {
                empty(payload)?;
                let mut conn = self.connect()?;
                let tx = conn.transaction()?;
                archive_session(&tx)?;
                Self::write_session(&tx, &Session::default())?;
                tx.commit()?;
                Ok(changed(1))
            }
            "commit_session" => {
                let s = parse_session(payload)?;
                self.commit_session(s)
            }
            "update_labels" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    filenames: Vec<String>,
                    label: String,
                }
                let p: P = parse(payload)?;
                validate_names(&p.filenames)?;
                let mut conn = self.connect()?;
                let tx = conn.transaction()?;
                let mut count = 0;
                for name in &p.filenames {
                    let region: Option<String> = tx
                        .query_row(
                            "SELECT region_id FROM images WHERE filename=?",
                            [name],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(region) = region {
                        validate_label(&region, &p.label).map_err(|e| anyhow!(e))?;
                        count += tx.execute(
                            "UPDATE images SET label=? WHERE filename=?",
                            params![p.label, name],
                        )?;
                        decision(
                            &tx,
                            name,
                            if p.label.is_empty() { "blank" } else { "label" },
                            "manual-database-review",
                        )?;
                    }
                }
                tx.commit()?;
                Ok(changed(count))
            }
            "delete_entries" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    filenames: Vec<String>,
                }
                let p: P = parse(payload)?;
                validate_names(&p.filenames)?;
                let mut conn = self.connect()?;
                let tx = conn.transaction()?;
                let mut paths = Vec::new();
                let mut n = 0;
                for name in &p.filenames {
                    paths.push(safe_child(&self.root.join("images"), name)?);
                    n += tx.execute("DELETE FROM images WHERE filename=?", [name])?;
                    tx.execute("DELETE FROM unimatrix_decisions WHERE filename=?", [name])?;
                }
                let current = Self::read_session(&tx)?;
                let retained: HashSet<&str> = current
                    .frames
                    .iter()
                    .map(|f| f.source.as_str())
                    .chain(current.pool.iter().map(|s| s.source.as_str()))
                    .collect();
                let unused:Vec<(i64,String)>=tx.prepare("SELECT c.id,c.filename FROM full_captures c WHERE NOT EXISTS(SELECT 1 FROM images i WHERE i.source_id=c.id)")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
                for (id, name) in unused {
                    if !retained.contains(name.as_str()) {
                        paths.push(safe_child(&self.root.join("full_captures"), &name)?);
                        tx.execute("DELETE FROM full_captures WHERE id=?", [id])?;
                    }
                }
                tx.commit()?;
                for path in paths {
                    if path.exists() {
                        fs::remove_file(path)?;
                    }
                }
                Ok(changed(n))
            }
            "clear_database" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    confirmation: String,
                }
                let p: P = parse(payload)?;
                if p.confirmation != "CLEAR" {
                    bail!("CLEAR confirmation required");
                }
                self.clear_database()
            }
            "import_dataset" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    path: String,
                }
                let p: P = parse(payload)?;
                self.import_dataset(Path::new(&p.path))
            }
            "recrop" => {
                empty(payload)?;
                self.recrop()
            }
            "capture" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    monitor: String,
                }
                let p: P = parse(payload)?;
                self.collect(&p.monitor)
            }
            "game_state" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct P {
                    monitor: String,
                    username: String,
                }
                let p: P = parse(payload)?;
                if p.username.len() > 256 {
                    bail!("Username too long");
                }
                let config = self.regions()?;
                let (bytes, image) = capture::screenshot(&p.monitor).map_err(|e| anyhow!(e))?;
                validate_image_regions(&config, &image)?;
                let state = crate::vision::process_game_state(
                    &bytes,
                    &p.username,
                    &config.vision_config().map_err(|e| anyhow!(e))?,
                )
                .map_err(|e| anyhow!(e))?;
                Ok(json!({"state":state,"screenshot":media::data_url(&bytes)}))
            }
            _ => bail!("Unknown operation: {operation}"),
        }
    }
    fn import_dataset(&mut self, source: &Path) -> Result<Value> {
        if !source.is_absolute() {
            bail!("Import path must be absolute");
        }
        for path in source.ancestors() {
            if path.exists() {
                plain(path)?;
            }
        }
        let source = source.canonicalize()?;
        if source.starts_with(&self.root) || self.root.starts_with(&source) {
            bail!("Import source and managed destination must be separate directories");
        }
        let conn = self.connect()?;
        let count: i64 = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM images)+(SELECT COUNT(*) FROM full_captures)",
            [],
            |r| r.get(0),
        )?;
        let session = Self::read_session(&conn)?;
        if count != 0 || !session.frames.is_empty() || !session.pool.is_empty() {
            bail!("Import requires an empty managed dataset");
        }
        drop(conn);
        let stage = self
            .root
            .with_extension(format!("import-{}", Uuid::new_v4()));
        fs::create_dir(&stage)?;
        let outcome = (|| -> Result<Value> {
            let db_path = source.join("data.db");
            plain(&db_path)?;
            let read_only = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let mut dest = Connection::open(stage.join("data.db"))?;
            {
                let backup = Backup::new(&read_only, &mut dest)?;
                backup.run_to_completion(256, Duration::from_millis(2), None)?;
            }
            let check: String = dest.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if check != "ok" {
                bail!("Imported SQLite integrity check failed: {check}");
            }
            // The standalone snapshot is retained before adding native-owned metadata.
            let mut snapshot = Connection::open(stage.join("legacy-snapshot.db"))?;
            {
                let backup = Backup::new(&dest, &mut snapshot)?;
                backup.run_to_completion(256, Duration::from_millis(2), None)?;
            }
            drop(snapshot);
            for item in fs::read_dir(&source)? {
                let item = item?;
                let name = item.file_name();
                let name = name
                    .to_str()
                    .ok_or_else(|| anyhow!("Non-UTF8 dataset filename"))?;
                if [
                    "data.db",
                    "data.db-wal",
                    "data.db-shm",
                    ".poker-managed",
                    "legacy-snapshot.db",
                    "regions.json",
                ]
                .contains(&name)
                {
                    continue;
                }
                copy_tree(&item.path(), &stage.join(name))?;
            }
            for name in ["images", "full_captures"] {
                if !stage.join(name).is_dir() {
                    bail!("Import must contain {name}/");
                }
            }
            let mut missing_images = Vec::new();
            let mut missing_captures = Vec::new();
            for (table, folder) in [("images", "images"), ("full_captures", "full_captures")] {
                let names: Vec<String> = dest
                    .prepare(&format!("SELECT filename FROM {table}"))?
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                for name in names {
                    let path = safe_child(&stage.join(folder), &name)?;
                    if !path.exists() {
                        if folder == "images" {
                            missing_images.push(name);
                        } else {
                            missing_captures.push(name);
                        }
                    } else if !path.is_file() {
                        bail!("Referenced {folder} path is not a regular file: {name}");
                    }
                }
            }
            atomic_write(
                &stage.join("import-report.json"),
                &serde_json::to_vec_pretty(
                    &json!({"sourcePath":source,"importedAt":now(),"missingImageCount":missing_images.len(),"missingCaptureCount":missing_captures.len(),"missingImages":missing_images,"missingCaptures":missing_captures}),
                )?,
            )?;
            let n: i64 = dest.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
            drop(dest);
            fs::write(stage.join(".poker-managed"), b"unimatrix-poker-v1\n")?;
            let staging = Self {
                root: stage.clone(),
                lock_path: self.lock_path.clone(),
            };
            let conn = staging.connect()?;
            let raw: Option<String> = conn
                .query_row("SELECT data FROM session_progress WHERE id=1", [], |r| {
                    r.get(0)
                })
                .optional()?;
            conn.execute(
                "INSERT INTO unimatrix_imports(source_path,imported_at,raw_session) VALUES(?,?,?)",
                params![source.to_string_lossy(), now(), raw],
            )?;
            // Import provenance remains unknown; a legacy empty label is not a blank.
            conn.execute("DELETE FROM unimatrix_decisions", [])?;
            if let Some(raw) = raw {
                let session = session::normalize(&serde_json::from_str::<Value>(&raw)?);
                Self::write_session(&conn, &session)?;
            }
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(conn);
            // Keep the current region config if one was explicitly saved in the destination.
            if self.root.join("regions.json").exists() {
                fs::copy(self.root.join("regions.json"), stage.join("regions.json"))?;
            }
            let old = self
                .root
                .with_extension(format!("empty-{}", Uuid::new_v4()));
            fs::rename(&self.root, &old)?;
            if let Err(e) = fs::rename(&stage, &self.root) {
                let _ = fs::rename(&old, &self.root);
                return Err(e.into());
            }
            fs::remove_dir_all(old)?;
            Ok(changed(n))
        })();
        if stage.exists() {
            let _ = fs::remove_dir_all(&stage);
        }
        outcome
    }
    fn commit_session(&mut self, s: Session) -> Result<Value> {
        session::validate(&s).map_err(|e| anyhow!(e))?;
        let samples: Vec<_> = if s.pool.is_empty() {
            s.frames.iter().flat_map(|f| f.crops.iter()).collect()
        } else {
            s.pool.iter().collect()
        };
        let mut seen = HashSet::new();
        let mut ready = Vec::new();
        let mut conn = self.connect()?;
        for sample in samples {
            if !seen.insert(sample.key.clone()) {
                bail!("Duplicate sample key in session");
            }
            match sample.decision {
                Decision::Pending => bail!("Session still contains pending decisions"),
                Decision::Discard => continue,
                Decision::Blank if !sample.label.is_empty() => {
                    bail!("Blank decision requires an empty label")
                }
                Decision::Label if sample.label.is_empty() => bail!("Label decision requires text"),
                _ => {}
            }
            validate_label(&sample.region_id, &sample.label).map_err(|e| anyhow!(e))?;
            let bytes = media::from_data_url(&sample.image).map_err(|e| anyhow!(e))?;
            let img = media::decode_image(&bytes).map_err(|e| anyhow!(e))?;
            if img.width() != sample.rect.w || img.height() != sample.rect.h {
                bail!("Sample image dimensions differ from region");
            }
            let source: i64 = conn
                .query_row(
                    "SELECT id FROM full_captures WHERE filename=?",
                    [&sample.source],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| anyhow!("Sample references an unknown managed capture"))?;
            let path = safe_child(&self.root.join("full_captures"), &sample.source)?;
            if !path.is_file() {
                bail!("Sample master capture is missing");
            }
            let name = format!("crop_{}_{}.png", now(), Uuid::new_v4());
            let hash = media::dhash(&img);
            let png = media::png(&img).map_err(|e| anyhow!(e))?;
            ready.push((sample.clone(), name, hash, png, source));
        }
        let mut published = Vec::new();
        let result = (|| -> Result<Value> {
            let tx = conn.transaction()?;
            for (sample, name, hash, bytes, source) in &ready {
                let path = safe_child(&self.root.join("images"), name)?;
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)?;
                published.push(path);
                file.write_all(bytes)?;
                file.sync_all()?;
                let r = sample.rect;
                tx.execute("INSERT INTO images(filename,phash,label,region_id,source_id,timestamp,x,y,w,h) VALUES(?,?,?,?,?,?,?,?,?,?)",params![name,hash,sample.label,sample.region_id,source,now(),r.x,r.y,r.w,r.h])?;
                decision(
                    &tx,
                    name,
                    if sample.decision == Decision::Blank {
                        "blank"
                    } else {
                        "label"
                    },
                    "explicit-session-review",
                )?;
            }
            archive_session(&tx)?;
            tx.execute("INSERT INTO session_history(timestamp,data) VALUES(?,?)",params![now(),serde_json::to_string(&json!({"points":s.points,"streak":s.streak,"elapsedMs":s.elapsed_ms,"committed":ready.len(),"discarded":s.pool.iter().filter(|s|s.decision==Decision::Discard).count()}))?])?;
            Self::write_session(&tx, &Session::default())?;
            tx.commit()?;
            Ok(changed(ready.len()))
        })();
        if result.is_err() {
            for path in published {
                let _ = fs::remove_file(path);
            }
        }
        result
    }
    fn clear_database(&self) -> Result<Value> {
        let mut conn = self.connect()?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))?;
        let mut paths = Vec::new();
        for folder in ["images", "full_captures"] {
            let dir = self.root.join(folder);
            plain(&dir)?;
            for item in fs::read_dir(dir)? {
                let item = item?;
                plain(&item.path())?;
                if !item.file_type()?.is_file() {
                    bail!("Unexpected directory in managed corpus");
                }
                paths.push(item.path());
            }
        }
        let tx = conn.transaction()?;
        archive_session(&tx)?;
        tx.execute_batch("DELETE FROM images;DELETE FROM full_captures;DELETE FROM unimatrix_decisions;DELETE FROM session_history;DELETE FROM session_progress;")?;
        tx.commit()?;
        for path in paths {
            fs::remove_file(path)?;
        }
        Ok(changed(n))
    }
    fn collect(&mut self, monitor: &str) -> Result<Value> {
        if monitor.len() > 255 {
            bail!("Invalid monitor name");
        }
        let config = self.regions()?;
        let (bytes, img) = capture::screenshot(monitor).map_err(|e| anyhow!(e))?;
        validate_image_regions(&config, &img)?;
        let rect = config
            .regions
            .get("round_id")
            .ok_or_else(|| anyhow!("Game ID region is not configured"))?;
        let crop = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
        let mut grayscale = media::collector_grayscale(&crop);
        for pixel in grayscale.pixels_mut() {
            pixel.0[0] = if pixel.0[0] > 120 { 255 } else { 0 };
        }
        let threshold = image::DynamicImage::ImageLuma8(grayscale);
        let mut child = Command::new("tesseract")
            .args(["stdin", "stdout", "--psm", "7"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Tesseract CLI unavailable")?;
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Missing Tesseract input"))?
            .write_all(&media::png(&threshold).map_err(|e| anyhow!(e))?)?;
        let output = child.wait_with_output()?;
        if !output.status.success() {
            bail!(
                "Tesseract game-ID OCR failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let text = String::from_utf8(output.stdout)?.trim().to_owned();
        if !regex::Regex::new(r"#\s*\d{6,15}")?.is_match(&text) {
            bail!("Game ID not verified. OCR saw: {text}");
        }
        // No files or database rows are created until the game ID is accepted.
        let mut conn = self.connect()?;
        let mut current = Self::read_session(&conn)?;
        let mut hashes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT COALESCE(region_id,''),COALESCE(phash,'') FROM images")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, hash) in rows {
            hashes.entry(canonical_id(&id)).or_default().push(hash);
        }
        for sample in current
            .pool
            .iter()
            .chain(current.frames.iter().flat_map(|f| f.crops.iter()))
        {
            hashes
                .entry(canonical_id(&sample.region_id))
                .or_default()
                .push(sample.phash.clone());
        }
        let colors: crate::vision::ColorConfig =
            serde_json::from_str(include_str!("../assets/colors.json"))?;
        let target_colors = vec![colors.nameplate, colors.in_turn, colors.in_turn_urgent];
        let mut active = HashSet::new();
        for n in 0..9 {
            if let Some(r) = config.regions.get(&format!("seat.{n}.nameplate")) {
                if crate::cv_utils::color_density(
                    &img.crop_imm(r.x, r.y, r.w, r.h),
                    &target_colors,
                    5,
                ) >= 0.05
                {
                    active.insert(n);
                }
            }
        }
        let source = format!("capture_{}_{}.png", now(), Uuid::new_v4());
        let mut crops = Vec::new();
        for (id, r) in &config.regions {
            if id.ends_with("nameplate") {
                continue;
            }
            if let Some(seat) = id
                .strip_prefix("seat.")
                .and_then(|x| x.split('.').next())
                .and_then(|x| x.parse::<usize>().ok())
            {
                if !active.contains(&seat) && !id.ends_with(".bet") {
                    continue;
                }
            }
            let crop = img.crop_imm(r.x, r.y, r.w, r.h);
            let phash = media::dhash(&crop);
            if hashes
                .get(id)
                .is_some_and(|h| h.iter().any(|old| media::hamming(old, &phash) <= 2))
            {
                continue;
            }
            hashes.entry(id.clone()).or_default().push(phash.clone());
            let image = media::data_url(&media::png(&crop).map_err(|e| anyhow!(e))?);
            crops.push(Sample {
                key: Uuid::new_v4().to_string(),
                region_id: id.clone(),
                label: if id == "round_id" {
                    text.clone()
                } else {
                    String::new()
                },
                phash,
                source: source.clone(),
                rect: *r,
                image,
                decision: Decision::Pending,
            });
        }
        let thumbnail =
            media::data_url(&media::png(&img.thumbnail(400, 400)).map_err(|e| anyhow!(e))?);
        let frame = Frame {
            key: Uuid::new_v4().to_string(),
            source: source.clone(),
            game_id: text,
            thumbnail,
            crops,
        };
        let path = safe_child(&self.root.join("full_captures"), &source)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let outcome = (|| -> Result<Value> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            let tx = conn.transaction()?;
            tx.execute("INSERT INTO full_captures(filename,monitor,timestamp,regions_hash) VALUES(?,?,?,?)",params![source,monitor,now(),serde_json::to_string(&config)?])?;
            current.frames.push(frame.clone());
            current.pool.extend(frame.crops.clone());
            Self::write_session(&tx, &current)?;
            tx.commit()?;
            Ok(serde_json::to_value(&frame)?)
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(path);
        }
        outcome
    }
    fn recrop(&mut self) -> Result<Value> {
        let config = self.regions()?;
        let mut conn = self.connect()?;
        let rows:Vec<(i64,String,String,Option<String>)>=conn.prepare("SELECT i.id,i.filename,COALESCE(i.region_id,''),c.filename FROM images i LEFT JOIN full_captures c ON i.source_id=c.id")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut skipped = 0;
        let mut plans = Vec::new();
        let mut grouped: BTreeMap<String, Vec<(i64, String, Rect)>> = BTreeMap::new();
        for (id, old_name, region, source) in rows {
            let Some(rect) = config.regions.get(&canonical_id(&region)).copied() else {
                skipped += 1;
                continue;
            };
            let Some(source) = source else {
                skipped += 1;
                continue;
            };
            grouped
                .entry(source)
                .or_default()
                .push((id, old_name, rect));
        }
        // Hold one master image at a time, including when recropping a large corpus.
        for (source, items) in grouped {
            let image = (|| -> Result<_> {
                let path = safe_child(&self.root.join("full_captures"), &source)?;
                media::decode_image(&read_bounded(&path)?).map_err(|e| anyhow!(e))
            })();
            let Ok(image) = image else {
                skipped += items.len();
                continue;
            };
            for (id, old_name, rect) in items {
                let outcome = (|| -> Result<_> {
                    let old = safe_child(&self.root.join("images"), &old_name)?;
                    rect.validate(image.width(), image.height())
                        .map_err(|e| anyhow!(e))?;
                    let crop = image.crop_imm(rect.x, rect.y, rect.w, rect.h);
                    let before =
                        media::decode_image(&read_bounded(&old)?).map_err(|e| anyhow!(e))?;
                    let pixels_changed = crop.to_rgba8() != before.to_rgba8();
                    let phash = media::dhash(&crop);
                    let bytes = if pixels_changed {
                        media::png(&crop).map_err(|e| anyhow!(e))?
                    } else {
                        Vec::new()
                    };
                    Ok((id, old_name, rect, pixels_changed, phash, bytes))
                })();
                match outcome {
                    Ok(plan) => plans.push(plan),
                    Err(_) => skipped += 1,
                }
            }
        }
        let mut published = Vec::new();
        let mut obsolete = Vec::new();
        let mut count = 0;
        let outcome = (|| -> Result<Value> {
            let tx = conn.transaction()?;
            for (id, old, rect, pixels_changed, phash, bytes) in &plans {
                let name = if *pixels_changed {
                    let name = format!("recrop_{}_{}.png", now(), Uuid::new_v4());
                    let path = safe_child(&self.root.join("images"), &name)?;
                    let mut file = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&path)?;
                    published.push(path);
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    obsolete.push(safe_child(&self.root.join("images"), old)?);
                    name
                } else {
                    old.clone()
                };
                if *pixels_changed {
                    tx.execute(
                        "UPDATE images SET filename=?,label='',phash=?,x=?,y=?,w=?,h=? WHERE id=?",
                        params![name, phash, rect.x, rect.y, rect.w, rect.h, id],
                    )?;
                    tx.execute("DELETE FROM unimatrix_decisions WHERE filename=?", [old])?;
                    count += 1;
                } else {
                    tx.execute(
                        "UPDATE images SET x=?,y=?,w=?,h=? WHERE id=?",
                        params![rect.x, rect.y, rect.w, rect.h, id],
                    )?;
                }
            }
            tx.commit()?;
            Ok(json!({"changed":count,"skipped":skipped}))
        })();
        if outcome.is_err() {
            for path in published {
                let _ = fs::remove_file(path);
            }
        } else {
            for path in obsolete {
                fs::remove_file(path)?;
            }
        }
        outcome
    }
}
fn validate_image_regions(config: &RegionSettings, img: &image::DynamicImage) -> Result<()> {
    config.validate().map_err(|e| anyhow!(e))?;
    if img.width() != config.screen_width || img.height() != config.screen_height {
        bail!("Selected monitor image dimensions differ from active region configuration; adjust regions first");
    }
    for rect in config.regions.values() {
        rect.validate(img.width(), img.height())
            .map_err(|e| anyhow!(e))?;
    }
    Ok(())
}
fn parse_session(value: &Value) -> Result<Session> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        session: Session,
    }
    let p: P = parse(value)?;
    Ok(p.session)
}
fn archive_session(conn: &Connection) -> Result<()> {
    conn.execute("INSERT INTO unimatrix_session_archive(timestamp,data) SELECT ?,data FROM session_progress WHERE id=1",[now()])?;
    Ok(())
}
fn decision(conn: &Connection, name: &str, value: &str, provenance: &str) -> Result<()> {
    conn.execute("INSERT INTO unimatrix_decisions(filename,decision,provenance,updated_at) VALUES(?,?,?,?) ON CONFLICT(filename) DO UPDATE SET decision=excluded.decision,provenance=excluded.provenance,updated_at=excluded.updated_at",params![name,value,provenance,now()])?;
    Ok(())
}
fn validate_names(names: &[String]) -> Result<()> {
    if names.is_empty() || names.len() > 250 {
        bail!("Choose 1 to 250 files");
    }
    for name in names {
        safe_name(name).map_err(|e| anyhow!(e))?;
    }
    Ok(())
}
fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    plain(path)?;
    if fs::metadata(path)?.len() > media::MAX_IMAGE_BYTES as u64 {
        bail!("Image exceeds file-size limit");
    }
    Ok(fs::read(path)?)
}
fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    plain(source)?;
    let meta = fs::symlink_metadata(source)?;
    if meta.is_dir() {
        fs::create_dir(dest)?;
        for item in fs::read_dir(source)? {
            let item = item?;
            copy_tree(&item.path(), &dest.join(item.file_name()))?;
        }
    } else if meta.is_file() {
        fs::copy(source, dest)?;
    } else {
        bail!("Unsupported file type in import: {}", source.display());
    }
    Ok(())
}
