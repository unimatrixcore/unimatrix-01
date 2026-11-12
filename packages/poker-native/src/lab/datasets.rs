use super::{bad, conflict, not_found, uuid, LabResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct DatasetContext {
    pub id: String,
    pub directory: PathBuf,
    pub db: Mutex<Connection>,
    pub operation: Mutex<()>,
    pub state: Mutex<Value>,
}
impl DatasetContext {
    pub fn lock_operation(&self) -> LabResult<std::sync::MutexGuard<'_, ()>> {
        self.operation
            .lock()
            .map_err(|_| conflict("Dataset operation lock poisoned"))
    }
    pub fn ensure_active(&self) -> LabResult<()> {
        if self
            .state
            .lock()
            .map_err(|_| conflict("Dataset state lock poisoned"))?["_archived"]
            == true
        {
            return Err(conflict("Dataset is archived; restore it before use"));
        }
        Ok(())
    }
    pub fn images(&self) -> PathBuf {
        self.directory.join("images")
    }
    pub fn captures(&self) -> PathBuf {
        self.directory.join("full_captures")
    }
    pub fn connection(&self) -> LabResult<std::sync::MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| conflict("Dataset database lock poisoned"))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetRow {
    pub id: String,
    pub name: String,
    pub archived: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
pub struct DatasetRegistry {
    pub root: PathBuf,
    rows: Mutex<()>,
    contexts: Mutex<BTreeMap<String, Arc<DatasetContext>>>,
}
pub fn safe_filename(name: &str) -> LabResult<()> {
    crate::store::safe_name(name).map_err(bad)
}
pub fn plain(path: &Path) -> LabResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(bad("Symbolic links are not allowed in managed datasets"));
    }
    Ok(())
}
pub fn file(dir: &Path, name: &str) -> LabResult<PathBuf> {
    safe_filename(name)?;
    plain(dir)?;
    let path = dir.join(name);
    if fs::symlink_metadata(&path).is_ok() {
        plain(&path)?;
    }
    Ok(path)
}
pub fn atomic_json(path: &Path, value: &Value) -> LabResult<()> {
    let temp = path.with_extension(format!("tmp-{}", uuid()));
    fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(temp, path)?;
    Ok(())
}
impl DatasetRegistry {
    pub fn new(root: PathBuf) -> LabResult<Self> {
        if !root.is_absolute()
            || root
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(bad("Dataset root must be an absolute managed path"));
        }
        for ancestor in root.ancestors() {
            if ancestor.exists() {
                plain(ancestor)?;
            }
        }
        fs::create_dir_all(&root)?;
        let marker = root.join(".poker-lab-managed");
        if fs::symlink_metadata(&marker).is_ok() {
            plain(&marker)?;
            if fs::read(&marker)? != b"unimatrix-poker-lab-v1\n" {
                return Err(conflict("Unknown dataset registry marker version"));
            }
        } else if fs::read_dir(&root)?.next().is_none() {
            fs::write(&marker, b"unimatrix-poker-lab-v1\n")?;
        } else {
            let manifest = root.join("datasets.json");
            let legacy = root.join("legacy/data.db");
            if manifest.is_file() {
                plain(&manifest)?;
                let rows: Vec<DatasetRow> = serde_json::from_slice(&fs::read(&manifest)?)?;
                for row in rows {
                    if row.id != "legacy"
                        && (row.id.len() != 32
                            || !row
                                .id
                                .bytes()
                                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
                    {
                        return Err(bad("Unknown dataset identity in existing registry"));
                    }
                }
            } else if legacy.is_file() {
                plain(&legacy)?;
                let conn = Connection::open_with_flags(
                    &legacy,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                for table in ["images", "full_captures"] {
                    if conn.query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                        [table],
                        |r| r.get::<_, i64>(0),
                    )? != 1
                    {
                        return Err(conflict(
                            "Existing legacy store does not match the Poker dataset schema",
                        ));
                    }
                }
            } else {
                return Err(conflict(
                    "Existing directory is not a recognized Poker dataset registry",
                ));
            }
        }
        Ok(Self {
            root,
            rows: Mutex::new(()),
            contexts: Mutex::new(BTreeMap::new()),
        })
    }
    fn read(&self) -> LabResult<Vec<DatasetRow>> {
        let path = self.root.join("datasets.json");
        if path.exists() {
            plain(&path)?;
            Ok(serde_json::from_slice(&fs::read(path)?)?)
        } else {
            let rows = vec![DatasetRow {
                id: "legacy".into(),
                name: "Legacy corpus".into(),
                archived: false,
                extra: BTreeMap::new(),
            }];
            self.write(&rows)?;
            Ok(rows)
        }
    }
    fn write(&self, rows: &[DatasetRow]) -> LabResult<()> {
        atomic_json(
            &self.root.join("datasets.json"),
            &serde_json::to_value(rows)?,
        )
    }
    pub fn list(&self) -> LabResult<Value> {
        let _guard = self
            .rows
            .lock()
            .map_err(|_| conflict("Dataset registry lock poisoned"))?;
        Ok(serde_json::to_value(self.read()?)?)
    }
    fn name(name: &str) -> LabResult<String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(bad("Dataset name must contain 1 to 100 characters"));
        }
        Ok(name.into())
    }
    pub fn create(&self, name: &str) -> LabResult<Value> {
        let _guard = self
            .rows
            .lock()
            .map_err(|_| conflict("Dataset registry lock poisoned"))?;
        let mut rows = self.read()?;
        let row = DatasetRow {
            id: uuid(),
            name: Self::name(name)?,
            archived: false,
            extra: BTreeMap::new(),
        };
        rows.push(row.clone());
        self.write(&rows)?;
        Ok(serde_json::to_value(row)?)
    }
    pub fn update(&self, id: &str, changes: &Value) -> LabResult<Value> {
        let initial = self
            .rows
            .lock()
            .map_err(|_| conflict("Dataset registry lock poisoned"))?;
        let ctx = self
            .contexts
            .lock()
            .map_err(|_| conflict("Dataset contexts lock poisoned"))?
            .get(id)
            .cloned();
        if let Some(ctx) = ctx {
            drop(initial);
            let _operation = ctx.lock_operation()?;
            let _database = ctx.connection()?;
            let _rows = self
                .rows
                .lock()
                .map_err(|_| conflict("Dataset registry lock poisoned"))?;
            let row = self.update_rows(id, changes)?;
            ctx.state
                .lock()
                .map_err(|_| conflict("Dataset state lock poisoned"))?["_archived"] =
                row["archived"].clone();
            Ok(row)
        } else {
            self.update_rows(id, changes)
        }
    }
    fn update_rows(&self, id: &str, changes: &Value) -> LabResult<Value> {
        let mut rows = self.read()?;
        let row = rows
            .iter_mut()
            .find(|row| row.id == id)
            .ok_or_else(|| not_found("Unknown dataset"))?;
        if let Some(name) = changes.get("name") {
            row.name = Self::name(
                name.as_str()
                    .ok_or_else(|| bad("Dataset name must contain 1 to 100 characters"))?,
            )?;
        }
        if let Some(archived) = changes.get("archived") {
            row.archived = archived
                .as_bool()
                .ok_or_else(|| bad("archived must be boolean"))?;
        }
        let result = serde_json::to_value(&*row)?;
        self.write(&rows)?;
        Ok(result)
    }
    pub fn resolve(&self, id: &str) -> LabResult<Arc<DatasetContext>> {
        if id != "legacy"
            && (id.len() != 32
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        {
            return Err(not_found("Unknown dataset"));
        }
        let _guard = self
            .rows
            .lock()
            .map_err(|_| conflict("Dataset registry lock poisoned"))?;
        let rows = self.read()?;
        let row = rows
            .iter()
            .find(|row| row.id == id)
            .ok_or_else(|| not_found("Unknown dataset"))?;
        if row.archived {
            return Err(conflict("Dataset is archived; restore it before use"));
        }
        let mut contexts = self
            .contexts
            .lock()
            .map_err(|_| conflict("Dataset contexts lock poisoned"))?;
        if let Some(ctx) = contexts.get(id) {
            return Ok(ctx.clone());
        }
        let directory = self.root.join(id);
        if directory.exists() {
            plain(&directory)?;
        }
        fs::create_dir_all(&directory)?;
        for name in ["images", "full_captures"] {
            let path = directory.join(name);
            if path.exists() {
                plain(&path)?;
            }
            fs::create_dir_all(path)?;
        }
        for name in ["data.db", "data.db-wal", "data.db-shm"] {
            let path = directory.join(name);
            if path.exists() {
                plain(&path)?;
            }
        }
        let conn = Connection::open(directory.join("data.db"))?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        init_database(&conn)?;
        let ctx = Arc::new(DatasetContext {
            id: id.into(),
            directory,
            db: Mutex::new(conn),
            operation: Mutex::new(()),
            state: Mutex::new(json!({})),
        });
        contexts.insert(id.into(), ctx.clone());
        Ok(ctx)
    }
}

fn init_database(conn: &Connection) -> LabResult<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS full_captures(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT UNIQUE,monitor TEXT,timestamp INTEGER,regions_hash TEXT);CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT,filename TEXT UNIQUE,phash TEXT,label TEXT,region_id TEXT,source_id INTEGER,timestamp INTEGER,FOREIGN KEY(source_id) REFERENCES full_captures(id));CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS session_progress(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT);CREATE TABLE IF NOT EXISTS session_history(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,data TEXT);CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);CREATE INDEX IF NOT EXISTS idx_images_region_id ON images(region_id);")?;
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(images)")?
        .query_map([], |r| r.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    for name in ["x", "y", "w", "h"] {
        if !columns.iter().any(|c| c == name) {
            conn.execute_batch(&format!("ALTER TABLE images ADD COLUMN {name} INTEGER"))?;
        }
    }
    Ok(())
}
