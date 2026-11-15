use super::{
    ImportBatch, ImportCollection, ImportEvidence, ImportFrame, ImportLabel, ImportSession,
};
use chrono::{DateTime, Utc};
use md5::{Digest, Md5};
use rusqlite::{types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceSpec {
    pub id: String,
    pub name: String,
    pub directory: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceReceipt {
    pub id: String,
    pub directory: PathBuf,
    pub files: BTreeMap<String, String>,
    pub review_samples: Vec<Value>,
}
impl SourceReceipt {
    pub fn assert_unchanged(&self) -> Result<(), String> {
        if source_files(&self.directory)? != self.files {
            return Err(format!(
                "Source inventory changed since planning: {}",
                self.id
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub version: u32,
    pub sources: Vec<SourceReceipt>,
    pub batch: ImportBatch,
    pub summary: Value,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn identity(parts: &[&str]) -> String {
    hash(serde_json::to_vec(parts).unwrap())[..32].into()
}
fn source_files(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    for name in ["data.db", "data.db-wal", "data.db-shm", "data.db-journal"] {
        let path = root.join(name);
        if path.exists() {
            result.insert(name.into(), hash(fs::read(path).map_err(error)?));
        }
    }
    png_inventory(root, root, &mut result)?;
    if !result.contains_key("data.db") {
        return Err("Source data.db is missing".into());
    }
    Ok(result)
}
fn png_inventory(
    root: &Path,
    directory: &Path,
    result: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let path = entry.path();
        let kind = entry.file_type().map_err(error)?;
        if kind.is_dir() {
            png_inventory(root, &path, result)?;
        } else if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        {
            let canonical = fs::canonicalize(&path).map_err(error)?;
            if !canonical.starts_with(root) || !canonical.is_file() {
                return Err("Source PNG escapes its dataset or is not a file".into());
            }
            let name = path
                .strip_prefix(root)
                .map_err(error)?
                .to_str()
                .ok_or("Source PNG path is not UTF-8")?;
            result.insert(name.into(), hash(fs::read(canonical).map_err(error)?));
        }
    }
    Ok(())
}
fn rows(conn: &Connection, table: &str) -> Result<Vec<Value>, String> {
    if !conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            [table],
            |r| r.get::<_, bool>(0),
        )
        .map_err(error)?
    {
        return Ok(vec![]);
    }
    let mut statement = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
        .map_err(error)?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let result = statement
        .query_map([], |row| {
            let mut value = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let field = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(v) => json!({"bytes":v.len(),"sha256":hash(v)}),
                };
                value.insert(name.clone(), field);
            }
            Ok(Value::Object(value))
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error);
    result
}
fn filename(root: &Path, sub: &str, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || Path::new(name).components().count() != 1 || name == "." || name == ".." {
        return Err(format!("Unsafe source filename {name:?}"));
    }
    let folder = root.join(sub);
    let path = folder.join(name);
    if path.exists() {
        let canonical = fs::canonicalize(&path).map_err(error)?;
        if !canonical.starts_with(fs::canonicalize(&folder).map_err(error)?) {
            return Err("Source evidence symlink escapes its directory".into());
        }
        Ok(canonical)
    } else {
        Ok(path)
    }
}
fn timestamp(value: &Value) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value.as_i64()?).map(|t| t.to_rfc3339())
}
fn python_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(python_json)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(values) => format!(
            "{{{}}}",
            values
                .iter()
                .map(|(k, v)| format!("{}: {}", serde_json::to_string(k).unwrap(), python_json(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => serde_json::to_string(value).unwrap(),
    }
}
fn unresolved(out: &mut Vec<ImportEvidence>, origin: String, reason: &str, evidence: Value) {
    out.push(ImportEvidence {
        fingerprint: hash(evidence.to_string()),
        origin,
        reason: reason.into(),
        evidence,
    });
}

pub fn plan(specs: &[SourceSpec], configs: &[PathBuf]) -> Result<Plan, String> {
    if specs.is_empty() {
        return Err("At least one source dataset is required".into());
    }
    let mut known_configs = BTreeMap::new();
    for path in configs {
        let value: Value =
            serde_json::from_slice(&fs::read(path).map_err(error)?).map_err(error)?;
        known_configs.insert(format!("{:x}", Md5::digest(python_json(&value))), value);
    }
    let mut batch = ImportBatch {
        collection: ImportCollection {
            id: identity(&["legacy-benchmark-collection-v1"]),
            name: "Legacy Benchmark".into(),
            kind: "legacy_benchmark".into(),
        },
        sessions: vec![],
        frames: vec![],
        unresolved: vec![],
    };
    let mut sources = vec![];
    let mut seen_ids = BTreeSet::new();
    let mut seen_roots = BTreeSet::new();
    let mut inventory = vec![];
    for spec in specs {
        if spec.id.is_empty() || !seen_ids.insert(&spec.id) {
            return Err("Source dataset identities must be unique and nonempty".into());
        }
        let root = fs::canonicalize(&spec.directory).map_err(error)?;
        if !seen_roots.insert(root.clone()) {
            return Err("A source directory cannot be imported with multiple identities".into());
        }
        let before = source_files(&root)?;
        let database_receipt = before
            .iter()
            .filter(|(name, _)| !name.to_ascii_lowercase().ends_with(".png"))
            .map(|(name, digest)| (name.clone(), digest.clone()))
            .collect::<BTreeMap<_, _>>();
        let inventory_sha256 = hash(serde_json::to_vec(&before).map_err(error)?);
        if before.contains_key("data.db-journal") {
            return Err("Source has a rollback journal; stop its writer before planning".into());
        }
        let snapshot = std::env::temp_dir().join(format!(
            "poker-legacy-snapshot-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&snapshot).map_err(error)?;
        let mut retained_samples = vec![];
        let result = (|| {
            for name in ["data.db", "data.db-wal"] {
                if before.contains_key(name) {
                    fs::copy(root.join(name), snapshot.join(name)).map_err(error)?;
                }
            }
            if source_files(&root)? != before {
                return Err(
                    "Source changed while copying snapshot; retry after stopping its writer".into(),
                );
            }
            let conn = Connection::open(snapshot.join("data.db")).map_err(error)?;
            conn.execute_batch("PRAGMA query_only=ON; BEGIN")
                .map_err(error)?;
            let captures = rows(&conn, "full_captures")?;
            let images = rows(&conn, "images")?;
            let queue = rows(&conn, "queue_items")?;
            let reviews = rows(&conn, "label_review_events")?;
            let review_samples = rows(&conn, "review_samples")?;
            retained_samples = review_samples.clone();
            let mut game_ids: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            let capture_names: BTreeMap<i64, String> = captures
                .iter()
                .filter_map(|v| Some((v["id"].as_i64()?, v["filename"].as_str()?.into())))
                .collect();
            let mut by_capture: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
            let mut known_crop_names = BTreeSet::new();
            for image in &images {
                let id = image["id"]
                    .as_i64()
                    .ok_or("Image without integer primary key")?;
                let name = image["filename"].as_str().unwrap_or("");
                known_crop_names.insert(name.to_string());
                let crop_path = filename(&root, "images", name)?;
                let mut evidence = image.clone();
                evidence["file_present"] = json!(crop_path.is_file());
                if crop_path.is_file() {
                    evidence["file_sha256"] = json!(hash(fs::read(&crop_path).map_err(error)?));
                }
                evidence["source_path"] = json!(crop_path);
                if let Some(source) = image["source_id"]
                    .as_i64()
                    .filter(|source| capture_names.contains_key(source))
                {
                    by_capture.entry(source).or_default().push(evidence);
                    if image["region_id"] == "round_id" {
                        if let Some(label) =
                            image["label"].as_str().filter(|v| !v.trim().is_empty())
                        {
                            game_ids
                                .entry(capture_names[&source].clone())
                                .or_default()
                                .insert(label.trim().into());
                        }
                    }
                } else {
                    unresolved(
                        &mut batch.unresolved,
                        format!("{}:images:{id}", spec.id),
                        "crop_without_original_capture",
                        evidence,
                    );
                }
            }
            let mut queue_by_name: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            for item in &queue {
                let payload = item["payload"]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or(Value::Null);
                let name = item["source"]
                    .as_str()
                    .or_else(|| payload["source"].as_str())
                    .unwrap_or("");
                queue_by_name
                    .entry(name.into())
                    .or_default()
                    .push(item.clone());
            }
            let session_id = identity(&["legacy-benchmark-session-v1", &spec.id]);
            let valid_dates = captures
                .iter()
                .filter_map(|v| timestamp(&v["timestamp"]))
                .collect::<Vec<_>>();
            if valid_dates.is_empty() && !captures.is_empty() {
                return Err("Source has no valid original capture timestamps".into());
            }
            if let (Some(first), Some(last)) = (valid_dates.iter().min(), valid_dates.iter().max())
            {
                batch.sessions.push(ImportSession {
                    id: session_id.clone(),
                    name: spec.name.clone(),
                    source: format!("legacy-benchmark:{}", spec.id),
                    created_at: first.clone(),
                    stopped_at: last.clone(),
                    config: json!({"source_dataset":spec.id,"sparse_capture":true}),
                    config_hash: "legacy-per-frame-snapshots".into(),
                });
            }
            let mut available = 0usize;
            for capture in &captures {
                let id = capture["id"]
                    .as_i64()
                    .ok_or("Capture without integer primary key")?;
                let origin = format!("{}:full_captures:{id}", spec.id);
                let name = capture["filename"]
                    .as_str()
                    .ok_or("Capture filename missing")?;
                let path = filename(&root, "full_captures", name)?;
                let labels = game_ids.get(name).cloned().unwrap_or_default();
                let evidence = json!({"source_dataset":spec.id,"capture":capture,"crops":by_capture.remove(&id).unwrap_or_default(),"queue":queue_by_name.remove(name).unwrap_or_default(),"game_id_candidates":labels,"game_id_verified":false,"source_directory":root,"source_database_receipt":database_receipt,"source_inventory_sha256":inventory_sha256});
                let Some(captured_at) = timestamp(&capture["timestamp"]) else {
                    unresolved(
                        &mut batch.unresolved,
                        origin,
                        "invalid_original_timestamp",
                        evidence,
                    );
                    continue;
                };
                if !path.is_file() {
                    unresolved(
                        &mut batch.unresolved,
                        origin,
                        "missing_full_frame",
                        evidence,
                    );
                    continue;
                }
                let bytes = fs::read(&path).map_err(error)?;
                if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
                    unresolved(
                        &mut batch.unresolved,
                        origin,
                        "unsupported_full_frame_encoding",
                        evidence,
                    );
                    continue;
                }
                let dimensions = match image::ImageReader::new(std::io::Cursor::new(&bytes))
                    .with_guessed_format()
                    .map_err(error)?
                    .into_dimensions()
                {
                    Ok(v) => v,
                    Err(_) => {
                        unresolved(
                            &mut batch.unresolved,
                            origin,
                            "invalid_full_frame_pixels",
                            evidence,
                        );
                        continue;
                    }
                };
                let hash_config = capture["regions_hash"].as_str().unwrap_or("");
                let config = known_configs
                    .get(hash_config)
                    .cloned()
                    .unwrap_or(Value::Null);
                let mut evidence = evidence;
                evidence["configuration_recovery"] = if config.is_null() {
                    json!("unresolved")
                } else {
                    json!("matching_python_sorted_json_md5")
                };
                let verified_labels =
                    verified_labels(&evidence, &config, &root, &reviews, &review_samples, &conn)?;
                evidence["label_policy"] = json!(LABEL_POLICY);
                evidence["unresolved_annotations"] = json!(evidence["crops"].as_array().unwrap().iter().filter(|crop|!verified_labels.iter().any(|label|label.region_id==crop["region_id"].as_str().unwrap_or(""))).map(|crop|json!({"source_record":crop["id"],"region_id":crop["region_id"],"reason":"annotation_mapping_or_label_conflict_unresolved"})).collect::<Vec<_>>());
                evidence["review_samples"] = json!(review_samples
                    .iter()
                    .filter(|sample| evidence["queue"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|q| q["sample_key"] == sample["sample_key"]))
                    .collect::<Vec<_>>());
                let trusted_games = verified_labels
                    .iter()
                    .filter(|l| ["round_id", "game.id"].contains(&l.region_id.as_str()))
                    .map(|l| {
                        l.label
                            .trim()
                            .strip_prefix('#')
                            .unwrap_or(l.label.trim())
                            .trim()
                            .to_string()
                    })
                    .filter(|v| !v.is_empty())
                    .collect::<BTreeSet<_>>();
                evidence["game_id_verified"] = json!(trusted_games.len() == 1);
                if labels.len() > 1 {
                    evidence["game_id_conflict"] = json!(true);
                }
                let image_sha256 = hash(&bytes);
                let fingerprint = hash(
                    json!({"evidence":evidence,"image_sha256":image_sha256,"config":config,"labels":verified_labels,"policy":LABEL_POLICY})
                        .to_string(),
                );
                batch.frames.push(ImportFrame {
                    origin,
                    fingerprint,
                    id: identity(&["legacy-benchmark-frame-v1", &spec.id, &id.to_string()]),
                    session_id: session_id.clone(),
                    captured_at,
                    hand_id: if trusted_games.len() == 1 {
                        trusted_games.iter().next().cloned()
                    } else {
                        None
                    },
                    source_path: path,
                    image_sha256,
                    width: dimensions.0,
                    height: dimensions.1,
                    config: if config.is_null() {
                        Value::Null
                    } else {
                        json!({"regions":config})
                    },
                    config_hash: hash_config.into(),
                    evidence,
                    labels: verified_labels,
                });
                available += 1;
            }
            for (name, items) in queue_by_name {
                unresolved(
                    &mut batch.unresolved,
                    format!("{}:queue-source:{name}", spec.id),
                    "queue_without_original_capture",
                    json!(items),
                );
            }
            for review in reviews {
                let id = review["id"]
                    .as_i64()
                    .ok_or("Review event missing identity")?;
                unresolved(
                    &mut batch.unresolved,
                    format!("{}:label_review_events:{id}", spec.id),
                    "retained_review_provenance",
                    review,
                );
            }
            let images_dir = root.join("images");
            if images_dir.is_dir() {
                for entry in fs::read_dir(&images_dir).map_err(error)? {
                    let entry = entry.map_err(error)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if entry.file_type().map_err(error)?.is_file()
                        && name.ends_with(".png")
                        && !known_crop_names.contains(&name)
                    {
                        unresolved(
                            &mut batch.unresolved,
                            format!("{}:orphan-file:{name}", spec.id),
                            "orphan_crop_file",
                            json!({"path":entry.path(),"sha256":hash(fs::read(entry.path()).map_err(error)?)}),
                        );
                    }
                }
            }
            conn.execute_batch("ROLLBACK").map_err(error)?;
            inventory.push(json!({"id":spec.id,"name":spec.name,"captures":captures.len(),"available_full_frames":available,"crop_rows":images.len(),"queue_rows":queue.len()}));
            Ok::<_, String>(())
        })();
        let _ = fs::remove_dir_all(&snapshot);
        result?;
        if source_files(&root)? != before {
            return Err("Source changed during planning; discard this plan".into());
        }
        sources.push(SourceReceipt {
            id: spec.id.clone(),
            directory: root,
            files: before,
            review_samples: retained_samples,
        });
    }
    let summary = json!({"label_policy":LABEL_POLICY,"verified_legacy_labels":batch.frames.iter().map(|f|f.labels.len()).sum::<usize>(),"verified_legacy_blanks":batch.frames.iter().flat_map(|f|&f.labels).filter(|l|l.label.is_empty()).count(),"sources":inventory,"planned_frames":batch.frames.len(),"unresolved_evidence":batch.unresolved.len(),"ocr_started":false,"verification_started":false,"applied":false});
    Ok(Plan {
        version: 2,
        sources,
        batch,
        summary,
    })
}

pub const LABEL_POLICY: &str = "occurrence_owned_legacy_annotations_v2";

fn config_region<'a>(config: &'a Value, id: &str) -> Option<&'a Value> {
    let mut value = config;
    for part in id.replace('[', ".").replace(']', "").split('.') {
        value = if let Ok(index) = part.parse::<usize>() {
            value.get(index)?
        } else {
            value.get(part)?
        };
    }
    Some(value)
}

fn verified_labels(
    evidence: &Value,
    config: &Value,
    root: &Path,
    reviews: &[Value],
    samples: &[Value],
    conn: &Connection,
) -> Result<Vec<ImportLabel>, String> {
    let profile: Value =
        serde_json::from_slice(super::super::gameplay::profile::CURRENT).map_err(error)?;
    let mut candidates = BTreeMap::<String, Vec<ImportLabel>>::new();
    let full = image::open(filename(
        root,
        "full_captures",
        evidence["capture"]["filename"].as_str().unwrap_or(""),
    )?)
    .map_err(error)?
    .to_rgb8();
    let mut crops = evidence["crops"].as_array().unwrap().clone();
    for q in evidence["queue"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q["reviewed"] == 1 && q["label"].is_string())
    {
        if crops
            .iter()
            .any(|crop| crop["region_id"] == q["region_id"] && crop["label"].is_string())
        {
            continue;
        }
        let payload: Value = q["payload"]
            .as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        let mut crop = payload["rect"].clone();
        if !crop.is_object() {
            continue;
        }
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT crop FROM queue_items WHERE queue_id=?",
                [q["queue_id"].as_i64()],
                |r| r.get(0),
            )
            .map_err(error)?;
        use base64::Engine;
        crop["encoded_png"] = json!(base64::engine::general_purpose::STANDARD.encode(&bytes));
        crop["id"] = q["queue_id"].clone();
        crop["source_table"] = json!("queue_items");
        crop["region_id"] = q["region_id"].clone();
        crop["label"] = q["label"].clone();
        crop["file_present"] = json!(true);
        crop["filename"] = json!("data.db");
        crops.push(crop);
    }
    for crop in &crops {
        let (Some(region), Some(label)) = (crop["region_id"].as_str(), crop["label"].as_str())
        else {
            continue;
        };
        let Some(target) = profile["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == region && r["ocr"] != false)
            .or_else(|| {
                profile["regions"].as_array().unwrap().iter().find(|r| {
                    r["ocr"] != false
                        && super::super::gameplay::ai::legacy_region_id(
                            r["id"].as_str().unwrap_or(""),
                        ) == region
                })
            })
        else {
            continue;
        };
        let Some(rect) = config_region(config, region) else {
            continue;
        };
        if !["x", "y", "w", "h"]
            .iter()
            .all(|key| crop[key] == rect[key] && rect[key].is_number())
            || crop["file_present"] != true
        {
            continue;
        }
        use base64::Engine;
        let encoded_png = crop["encoded_png"].as_str().map(str::to_owned);
        let path = if encoded_png.is_some() {
            root.join("data.db")
        } else {
            filename(root, "images", crop["filename"].as_str().unwrap_or(""))?
        };
        let png = if let Some(encoded) = &encoded_png {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(error)?
        } else {
            fs::read(&path).map_err(error)?
        };
        let (_, pixels) = crate::lab::review::image_identity(&png).map_err(error)?;
        let decoded = image::load_from_memory(&png).map_err(error)?;
        let (width, height) = (decoded.width(), decoded.height());
        if Some(width as i64) != rect["w"].as_i64() || Some(height as i64) != rect["h"].as_i64() {
            continue;
        }
        let (Some(x), Some(y), Some(w), Some(h)) = (
            rect["x"].as_u64(),
            rect["y"].as_u64(),
            rect["w"].as_u64(),
            rect["h"].as_u64(),
        ) else {
            continue;
        };
        if w == 0 || h == 0 || x + w > u64::from(full.width()) || y + h > u64::from(full.height()) {
            continue;
        }
        if image::imageops::crop_imm(&full, x as u32, y as u32, w as u32, h as u32).to_image()
            != decoded.to_rgb8()
        {
            continue;
        }
        let queue = evidence["queue"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|q| q["reviewed"] == 1 && q["region_id"] == region)
            .collect::<Vec<_>>();
        let sample_key = format!(
            "{}:{}:{}",
            region,
            crop["phash"].as_str().unwrap_or(""),
            evidence["capture"]["filename"].as_str().unwrap_or("")
        );
        let history = reviews
            .iter()
            .filter(|r| {
                r["sample_key"] == sample_key
                    || queue.iter().any(|q| q["sample_key"] == r["sample_key"])
            })
            .collect::<Vec<_>>();
        let sample_rows = samples
            .iter()
            .filter(|r| {
                r["sample_key"] == sample_key
                    || queue.iter().any(|q| q["sample_key"] == r["sample_key"])
            })
            .collect::<Vec<_>>();
        let latest = history
            .iter()
            .filter_map(|r| r["sample_key"].as_str().map(|key| (key, *r)))
            .collect::<BTreeMap<_, _>>();
        if latest.values().any(|r| {
            r["label"].as_str().is_some_and(|v| v != label)
                || r["pixel_sha256"].as_str().is_some_and(|v| v != pixels)
        }) {
            continue;
        }
        // A contradictory reviewed value cannot silently win over another persisted annotation.
        if sample_rows.iter().any(|s| {
            s["label"].as_str().is_some_and(|v| v != label)
                || s["pixel_sha256"].as_str().is_some_and(|v| v != pixels)
        }) {
            continue;
        }
        if queue.iter().any(|q| {
            q["label"].as_str().is_some_and(|v| v != label)
                || q["pixel_sha256"].as_str().is_some_and(|v| v != pixels)
        }) {
            continue;
        }
        let provenance = json!({"policy":LABEL_POLICY,"source_dataset":evidence["source_dataset"],"source_database":root.join("data.db"),"source_database_receipt":evidence["source_database_receipt"],"capture":evidence["capture"],"crop":crop,"source_region_id":region,"target_region_id":target["id"],"target_profile_id":profile["id"],"target_profile_sha256":hash(super::super::gameplay::profile::CURRENT),"source_config_digest":evidence["capture"]["regions_hash"],"original_rect":rect,"original_pixel_sha256":pixels,"original_image_sha256":hash(&png),"label_present":true,"explicit_blank":label.is_empty(),"reviewed_queue":queue,"review_samples":sample_rows,"historical_review_events":history,"pixel_relationship":"source_crop_semantic_occurrence; current tight crop is not pixel-equivalent","visually_verified":false});
        candidates
            .entry(target["id"].as_str().unwrap().into())
            .or_default()
            .push(ImportLabel {
                region_id: target["id"].as_str().unwrap().into(),
                label: label.into(),
                source_path: path,
                image_sha256: hash(&png),
                pixel_sha256: pixels,
                encoded_png,
                provenance,
            });
    }
    Ok(candidates
        .into_values()
        .filter(|items| items.iter().all(|i| i.label == items[0].label))
        .map(|mut items| {
            let records = items
                .iter()
                .map(|i| i.provenance.clone())
                .collect::<Vec<_>>();
            let mut first = items.remove(0);
            first.provenance["annotations"] = json!(records);
            first
        })
        .collect())
}
