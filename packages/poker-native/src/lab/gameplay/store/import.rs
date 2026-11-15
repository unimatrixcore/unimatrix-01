use super::{err, Store};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportCollection {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportSession {
    pub id: String,
    pub name: String,
    pub source: String,
    pub created_at: String,
    pub stopped_at: String,
    pub config: Value,
    pub config_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportFrame {
    pub origin: String,
    pub fingerprint: String,
    pub id: String,
    pub session_id: String,
    pub captured_at: String,
    pub hand_id: Option<String>,
    pub source_path: PathBuf,
    pub image_sha256: String,
    pub width: u32,
    pub height: u32,
    pub config: Value,
    pub config_hash: String,
    pub evidence: Value,
    pub labels: Vec<ImportLabel>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportLabel {
    pub region_id: String,
    pub label: String,
    pub source_path: PathBuf,
    pub image_sha256: String,
    pub pixel_sha256: String,
    pub encoded_png: Option<String>,
    pub provenance: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportEvidence {
    pub origin: String,
    pub fingerprint: String,
    pub reason: String,
    pub evidence: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportBatch {
    pub collection: ImportCollection,
    pub sessions: Vec<ImportSession>,
    pub frames: Vec<ImportFrame>,
    pub unresolved: Vec<ImportEvidence>,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Store {
    /// Import prepared evidence without changing original OCR or source files.
    /// Published files precede the transaction; a crashed publication is reused
    /// only after its hash is checked against the same deterministic origin.
    pub fn import_legacy(&self, batch: &ImportBatch) -> Result<Value, String> {
        self.import_legacy_checked(batch, || Ok(()))
    }
    pub fn import_legacy_checked(
        &self,
        batch: &ImportBatch,
        validate_source: impl FnOnce() -> Result<(), String>,
    ) -> Result<Value, String> {
        if !safe_id(&batch.collection.id)
            || batch.sessions.iter().any(|s| !safe_id(&s.id))
            || batch
                .frames
                .iter()
                .any(|f| !safe_id(&f.id) || !safe_id(&f.session_id))
        {
            return Err("400:Invalid deterministic import identity".into());
        }
        let mut conn = self.connect()?;
        initialize(&conn)?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_import_origins(origin TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,frame_id TEXT UNIQUE,evidence_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS gameplay_import_unresolved(origin TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL);").map_err(err)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        for frame in &batch.frames {
            let prior: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT fingerprint,frame_id FROM gameplay_import_origins WHERE origin=?",
                    [&frame.origin],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            if let Some((fingerprint, id)) = prior {
                if fingerprint != frame.fingerprint || id.as_deref() != Some(&frame.id) {
                    return Err(format!(
                        "409:Source revision conflicts with imported origin {}",
                        frame.origin
                    ));
                }
            } else if tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM frames WHERE id=?)",
                    [&frame.id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
            {
                return Err(format!("409:Frame identity collision {}", frame.id));
            }
        }
        let existing_collection: Option<(String, String)> = tx
            .query_row(
                "SELECT name,kind FROM collections WHERE id=?",
                [&batch.collection.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((name, kind)) = existing_collection {
            if name != batch.collection.name || kind != batch.collection.kind {
                return Err("409:Import collection identity collision".into());
            }
        } else {
            tx.execute(
                "INSERT INTO collections(id,name,kind,archived,created_at) VALUES(?,?,?,0,?)",
                params![
                    batch.collection.id,
                    batch.collection.name,
                    batch.collection.kind,
                    batch
                        .sessions
                        .first()
                        .map(|s| s.created_at.as_str())
                        .unwrap_or("1970-01-01T00:00:00Z")
                ],
            )
            .map_err(err)?;
        }
        for session in &batch.sessions {
            let existing: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT collection_id,source,created_at FROM sessions WHERE id=?",
                    [&session.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(err)?;
            if let Some((collection, source, created)) = existing {
                if collection != batch.collection.id
                    || source != session.source
                    || created != session.created_at
                {
                    return Err(format!("409:Recording identity collision {}", session.id));
                }
            } else {
                tx.execute("INSERT INTO sessions(id,name,source,interval_ms,status,created_at,stopped_at,config_hash,config_json,archived,collection_id) VALUES(?,?,?,0,'stopped',?,?,?,?,0,?)", params![session.id,session.name,session.source,session.created_at,session.stopped_at,session.config_hash,session.config.to_string(),batch.collection.id]).map_err(err)?;
            }
        }
        let (mut inserted, mut reused) = (0usize, 0usize);
        for frame in &batch.frames {
            let bytes = fs::read(&frame.source_path).map_err(err)?;
            if format!("{:x}", Sha256::digest(&bytes)) != frame.image_sha256 {
                return Err(format!(
                    "409:Source image changed after planning: {}",
                    frame.source_path.display()
                ));
            }
            let image = image::load_from_memory(&bytes).map_err(err)?;
            if image.width() != frame.width || image.height() != frame.height {
                return Err("409:Source image dimensions changed".into());
            }
            let destination = self.root.join("frames").join(format!("{}.png", frame.id));
            if destination.exists() {
                if format!("{:x}", Sha256::digest(fs::read(&destination).map_err(err)?))
                    != frame.image_sha256
                {
                    return Err(format!(
                        "409:Published frame conflicts with import {}",
                        frame.id
                    ));
                }
            } else {
                let temporary = destination
                    .with_extension(format!("{}.import.tmp", uuid::Uuid::new_v4().simple()));
                {
                    use std::io::Write;
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)
                        .map_err(err)?;
                    file.write_all(&bytes).map_err(err)?;
                    file.sync_all().map_err(err)?;
                }
                fs::rename(&temporary, &destination).map_err(err)?;
            }
            for label in &frame.labels {
                let png = label_png(label)?;
                if crate::lab::sha256(&png) != label.image_sha256 {
                    return Err("409:Legacy annotation pixels changed after planning".into());
                }
                crate::lab::pixel_assets::put(&tx, &png, &label.pixel_sha256).map_err(err)?;
            }
            if tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM gameplay_import_origins o JOIN frames f ON f.id=o.frame_id WHERE o.origin=?)",
                    [&frame.origin],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
            {
                reused += 1;
                continue;
            }
            tx.execute("INSERT INTO frames(id,session_id,captured_at,hand_id,ocr_status,error,width,height,image_sha256,results_json,config_hash,config_json,timings_json) VALUES(?,?,?,?,'error','Legacy capture requires OCR processing',?,?,?,'{}',?,?,'{}')",params![frame.id,frame.session_id,frame.captured_at,frame.hand_id,frame.width,frame.height,frame.image_sha256,frame.config_hash,frame.config.to_string()]).map_err(err)?;
            tx.execute("INSERT OR IGNORE INTO gameplay_import_origins(origin,fingerprint,frame_id,evidence_json) VALUES(?,?,?,?)",params![frame.origin,frame.fingerprint,frame.id,frame.evidence.to_string()]).map_err(err)?;
            for label in &frame.labels {
                tx.execute("INSERT INTO gameplay_import_labels(frame_id,region_id,label,provenance_json,pixel_sha256) VALUES(?,?,?,?,?)",params![frame.id,label.region_id,label.label,label.provenance.to_string(),label.pixel_sha256]).map_err(err)?;
            }
            inserted += 1;
        }
        for item in &batch.unresolved {
            let prior: Option<String> = tx
                .query_row(
                    "SELECT fingerprint FROM gameplay_import_unresolved WHERE origin=?",
                    [&item.origin],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?;
            if prior.as_ref().is_some_and(|p| p != &item.fingerprint) {
                return Err(format!(
                    "409:Unresolved source revision conflicts {}",
                    item.origin
                ));
            }
            tx.execute("INSERT OR IGNORE INTO gameplay_import_unresolved(origin,fingerprint,reason,evidence_json) VALUES(?,?,?,?)",params![item.origin,item.fingerprint,item.reason,item.evidence.to_string()]).map_err(err)?;
        }
        validate_source()?;
        tx.commit().map_err(err)?;
        Ok(
            json!({"inserted":inserted,"reused":reused,"unresolved":batch.unresolved.len(),"collection_id":batch.collection.id,"ocr_started":false,"verification_started":false}),
        )
    }
}

pub(super) fn initialize(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS pixel_assets(pixel_sha256 TEXT PRIMARY KEY,width INTEGER NOT NULL,height INTEGER NOT NULL,png_sha256 TEXT NOT NULL,png BLOB NOT NULL); CREATE TABLE IF NOT EXISTS gameplay_import_labels(frame_id TEXT NOT NULL REFERENCES frames(id) ON DELETE CASCADE,region_id TEXT NOT NULL,label TEXT NOT NULL,provenance_json TEXT NOT NULL,pixel_sha256 TEXT NOT NULL REFERENCES pixel_assets(pixel_sha256),PRIMARY KEY(frame_id,region_id));").map_err(err)?;
    crate::lab::pixel_assets::install(conn).map_err(err)
}

pub fn labels(
    conn: &rusqlite::Connection,
    frame: &str,
) -> Result<std::collections::BTreeMap<String, Value>, String> {
    let mut query = conn
        .prepare(
            "SELECT region_id,label,provenance_json FROM gameplay_import_labels WHERE frame_id=?",
        )
        .map_err(err)?;
    let rows = query
        .query_map([frame], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?;
    rows.map(|r| { let (region,label,provenance)=r.map_err(err)?; Ok((region,json!({"label":label,"provenance":serde_json::from_str::<Value>(&provenance).map_err(err)?}))) }).collect()
}

fn label_png(label: &ImportLabel) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if let Some(encoded) = &label.encoded_png {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(err)
    } else {
        fs::read(&label.source_path).map_err(err)
    }
}
