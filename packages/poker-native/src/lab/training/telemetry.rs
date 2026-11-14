use super::*;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{BufRead, BufReader},
};

const LOG_LIMIT: u64 = 2 * 1024 * 1024;
const RECORD_LIMIT: usize = 65_536;
const MANIFEST_LIMIT: u64 = 64 * 1024 * 1024;
pub(super) const CONDITIONS: [&str; 4] = ["identity", "brightness_minus30", "jpeg80", "scale60"];

#[derive(PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_reused_bounded_and_invalidated_by_changed_logs() {
        let reader = Reader::default();
        let roots: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
        for root in &roots {
            let first = reader.read(root.path(), None);
            assert_eq!(reader.read(root.path(), None), first);
        }
        assert_eq!(reader.snapshots.lock().unwrap().len(), 2);
        let root = roots.last().unwrap().path();
        fs::write(root.join("general.log"), "POKER_TRAINING_PROGRESS {\"role\":\"general\",\"stage_id\":\"base\",\"step\":1,\"loss\":0.25}\n").unwrap();
        assert_eq!(
            reader.read(root, None)["histories"][0]["points"][0]["loss"],
            0.25
        );
        assert_eq!(reader.snapshots.lock().unwrap().len(), 2);
    }
    #[test]
    fn large_manifest_index_is_compact_reused_and_invalidated_by_file_replacement() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("bundle");
        fs::create_dir_all(&bundle).unwrap();
        let path = bundle.join("manifest.jsonl");
        let mut file = File::create(&path).unwrap();
        for i in 0..2000 {
            writeln!(file,"{}",json!({"sample_id":format!("sample:{i}"),"category":"name","label":"Alice","image_path":"images/a.png","file_sha256":"a".repeat(64),"audit_padding":"x".repeat(5000)})).unwrap();
        }
        drop(file);
        assert!(fs::metadata(&path).unwrap().len() > 10_000_000);
        let reader = Reader::default();
        let original = reader.manifest(root.path()).unwrap();
        let cached = reader.manifest(root.path()).unwrap();
        assert!(Arc::ptr_eq(&original, &cached));
        assert_eq!(cached.rows.len(), 2000);
        assert!(cached.rows["sample:0"].get("audit_padding").is_none());
        let mut bytes = fs::read(&path).unwrap();
        let position = bytes.windows(5).position(|part| part == b"Alice").unwrap();
        bytes[position..position + 5].copy_from_slice(b"Al1ce");
        fs::write(path.with_extension("tmp"), bytes).unwrap();
        fs::rename(path.with_extension("tmp"), &path).unwrap();
        let changed = reader.manifest(root.path()).unwrap();
        assert!(!Arc::ptr_eq(&cached, &changed));
        assert_eq!(changed.rows["sample:0"]["label"], "Al1ce");
        assert_eq!(original.rows["sample:0"]["label"], "Alice");
    }
}
impl FileStamp {
    fn from(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        }
    }
}
#[derive(Default)]
struct ManifestIndex {
    rows: BTreeMap<String, Value>,
    order: Vec<String>,
    duplicates: BTreeSet<String>,
}
#[derive(Default)]
pub(super) struct Reader {
    manifests: Mutex<VecDeque<(PathBuf, FileStamp, Arc<ManifestIndex>)>>,
    snapshots: Mutex<VecDeque<(PathBuf, Option<String>, Vec<Option<FileStamp>>, Value)>>,
}
impl Reader {
    fn manifest(&self, dir: &Path) -> LabResult<Arc<ManifestIndex>> {
        let bundle = dir.join("bundle");
        let path = bundle.join("manifest.jsonl");
        managed_file(&bundle, &path)?;
        let stamp = FileStamp::from(&fs::metadata(&path)?);
        let mut cached = self
            .manifests
            .lock()
            .map_err(|_| unavailable("Training manifest cache is unavailable"))?;
        if let Some((_, _, index)) = cached
            .iter()
            .find(|(name, prior, _)| name == &path && *prior == stamp)
        {
            return Ok(index.clone());
        }
        let mut index = ManifestIndex::default();
        let mut oversized = false;
        scan_manifest(&bundle, |row| {
            if oversized {
                return;
            }
            let Some(id) = bounded_text(&row["sample_id"], 4096).filter(|id| !id.is_empty()) else {
                return;
            };
            if bounded_text(&row["category"], 64).is_none()
                || bounded_text(&row["label"], 4096).is_none()
            {
                return;
            }
            if index.rows.contains_key(id) || index.duplicates.contains(id) {
                index.rows.remove(id);
                index.duplicates.insert(id.into());
                return;
            }
            if index.order.len() >= 50_000 {
                oversized = true;
                return;
            }
            index.order.push(id.into());
            index.rows.insert(id.into(),json!({"sample_id":id,"category":row["category"],"label":row["label"],"image_path":row["image_path"],"file_sha256":row["file_sha256"],"dataset_id":row["dataset_id"]}));
        })?;
        if oversized {
            return Err(bad("Frozen manifest has too many sample identities"));
        }
        if FileStamp::from(&fs::metadata(&path)?) != stamp {
            return Err(conflict("Frozen training manifest changed while reading"));
        }
        cached.retain(|(name, _, _)| name != &path);
        let index = Arc::new(index);
        cached.push_back((path, stamp, index.clone()));
        while cached.len() > 2 {
            cached.pop_front();
        }
        Ok(index)
    }
}

fn snapshot_stamps(dir: &Path) -> Vec<Option<FileStamp>> {
    let mut paths = vec![
        "run.json".to_owned(),
        "general.log".to_owned(),
        "names.log".to_owned(),
        "bundle/manifest.jsonl".to_owned(),
    ];
    for pass in ["baseline", "candidate"] {
        paths.push(format!("benchmarks/{pass}/protocol.json"));
        for condition in CONDITIONS {
            paths.push(format!("benchmarks/{pass}/{condition}/predictions.jsonl"));
        }
    }
    paths
        .into_iter()
        .map(|relative| {
            let path = dir.join(relative);
            managed_file(dir, &path).ok()?;
            Some(FileStamp::from(&fs::metadata(path).ok()?))
        })
        .collect()
}

fn managed_file(root: &Path, path: &Path) -> LabResult<()> {
    datasets::plain(root)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| bad("Training sample escapes its bundle"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(bad("Invalid frozen sample path"));
        }
        current.push(component);
        datasets::plain(&current)?;
    }
    if !path.is_file() {
        return Err(not_found("Frozen training artifact is missing"));
    }
    Ok(())
}

fn read_tail(path: &Path) -> Vec<Value> {
    let result = (|| -> LabResult<Vec<Value>> {
        datasets::plain(path)?;
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let start = length.saturating_sub(LOG_LIMIT);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.take(LOG_LIMIT).read_to_end(&mut bytes)?;
        let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
        if start > 0 {
            lines.next();
        }
        Ok(lines
            .filter(|line| line.ends_with(b"\n") && line.len() <= RECORD_LIMIT)
            .filter_map(|line| {
                let line = line
                    .strip_prefix(b"POKER_TRAINING_PROGRESS ")
                    .unwrap_or(line);
                serde_json::from_slice(line).ok()
            })
            .collect())
    })();
    result.unwrap_or_default()
}

fn role(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|value| matches!(*value, "general" | "names"))
}
fn bounded_text(value: &Value, limit: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|value| value.chars().count() <= limit)
}
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}
fn counter(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number <= 9_007_199_254_740_991)
}

fn histories(dir: &Path) -> Vec<Value> {
    let mut series: BTreeMap<(String, String), BTreeMap<u64, Value>> = BTreeMap::new();
    for name in ["general.log", "names.log"] {
        for row in read_tail(&dir.join(name)) {
            let Some(role) = role(&row["role"]) else {
                continue;
            };
            let stage = bounded_text(&row["stage_id"], 64)
                .filter(|stage| !stage.is_empty())
                .unwrap_or(role);
            let Some(step) = counter(&row["step"]).or_else(|| counter(&row["global_step"])) else {
                continue;
            };
            let Some(loss) = finite(&row["loss"]) else {
                continue;
            };
            let mut point = json!({"step":step,"loss":loss});
            if let Some(epoch) = counter(&row["epoch"]) {
                point["epoch"] = json!(epoch);
            }
            for field in ["elapsed_seconds", "updated_at"] {
                if let Some(number) = finite(&row[field]).filter(|number| *number >= 0.0) {
                    point[field] = json!(number);
                }
            }
            let points = series.entry((role.into(), stage.into())).or_default();
            points.insert(step, point);
            while points.len() > 160 {
                points.pop_first();
            }
        }
    }
    series.into_iter().take(6).map(|((role,stage),points)|json!({"role":role,"stage_id":stage,"points":points.into_values().collect::<Vec<_>>()})).collect()
}

fn scan_manifest(bundle: &Path, mut visit: impl FnMut(Value)) -> LabResult<()> {
    let path = bundle.join("manifest.jsonl");
    managed_file(bundle, &path)?;
    let file = File::open(path)?;
    if file.metadata()?.len() > MANIFEST_LIMIT {
        return Err(bad("Frozen manifest exceeds its size bound"));
    }
    let mut reader = BufReader::new(file.take(MANIFEST_LIMIT + 1));
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader.read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if line.len() > 2 * 1024 * 1024 {
            continue;
        }
        if let Ok(value) = serde_json::from_slice(&line) {
            visit(value);
        }
    }
    Ok(())
}

fn sample_url(dir: &Path, row: &Value) -> Option<String> {
    let id = bounded_text(&row["sample_id"], 4096)?;
    let relative = Path::new(row["image_path"].as_str()?);
    if relative.is_absolute() {
        return None;
    }
    let bundle = dir.join("bundle");
    managed_file(&bundle, &bundle.join(relative)).ok()?;
    let hash = row["file_sha256"].as_str()?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("run", dir.file_name()?.to_str()?)
        .append_pair("sample_id", id)
        .finish();
    Some(format!("/api/training/sample?{query}"))
}

fn valid_case(row: &Value, condition: &str) -> bool {
    bounded_text(&row["sample_id"], 4096).is_some_and(|id| !id.is_empty())
        && bounded_text(&row["category"], 64).is_some_and(|value| !value.is_empty())
        && bounded_text(&row["label"], 4096).is_some()
        && role(&row["model_role"])
            == Some(if row["category"] == "name" {
                "names"
            } else {
                "general"
            })
        && row["condition"] == condition
        && row["split"] == "test"
        && row["raw_exact"].as_bool().is_some()
        && match row["raw_prediction"].as_str() {
            Some(prediction) => {
                prediction.chars().count() <= 4096
                    && row["raw_exact"] == json!(row["label"].as_str() == Some(prediction))
            }
            None => {
                row["raw_prediction"].is_null()
                    && row["raw_exact"] == false
                    && row["error"].as_str().is_some_and(|value| !value.is_empty())
            }
        }
}

fn predictions(dir: &Path, pass: &str, condition: &str) -> (Vec<Value>, Option<u64>) {
    let path = dir
        .join("benchmarks")
        .join(pass)
        .join(condition)
        .join("predictions.jsonl");
    if managed_file(dir, &path).is_err() {
        return (vec![], None);
    }
    let result = (|| -> LabResult<(Vec<Value>, Option<u64>)> {
        let file = File::open(&path)?;
        let full = file.metadata()?.len() <= 32 * 1024 * 1024;
        if !full {
            return Ok((
                read_tail(&path)
                    .into_iter()
                    .filter(|row| valid_case(row, condition))
                    .collect(),
                None,
            ));
        }
        let mut reader = BufReader::new(file.take(32 * 1024 * 1024 + 1));
        let mut line = Vec::new();
        let mut recent = Vec::new();
        let mut count = 0;
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            if !line.ends_with(b"\n") {
                break;
            }
            if line.len() > RECORD_LIMIT {
                continue;
            }
            if let Ok(row) = serde_json::from_slice::<Value>(&line) {
                if valid_case(&row, condition) {
                    count += 1;
                    recent.push(row);
                }
            }
        }
        Ok((recent, Some(count)))
    })();
    result.unwrap_or_default()
}

fn benchmark(dir: &Path, requested_condition: Option<&str>) -> Option<Value> {
    let pass = if dir.join("benchmarks/candidate/protocol.json").is_file() {
        "candidate"
    } else if dir.join("benchmarks/baseline/protocol.json").is_file() {
        "baseline"
    } else {
        return None;
    };
    let protocol_path = dir.join("benchmarks").join(pass).join("protocol.json");
    managed_file(dir, &protocol_path).ok()?;
    let protocol = read_optional_json(&protocol_path, 1_048_576)
        .ok()
        .flatten()?;
    let conditions: Vec<&str> = protocol["conditions"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|value| CONDITIONS.contains(value))
        .collect();
    let condition = if let Some(condition) = requested_condition {
        if !conditions.contains(&condition)
            || managed_file(
                dir,
                &dir.join("benchmarks")
                    .join(pass)
                    .join(condition)
                    .join("predictions.jsonl"),
            )
            .is_err()
        {
            return None;
        }
        condition
    } else {
        conditions
            .iter()
            .rev()
            .find(|condition| {
                dir.join("benchmarks")
                    .join(pass)
                    .join(condition)
                    .join("predictions.jsonl")
                    .is_file()
            })
            .copied()?
    };
    let (baseline, baseline_count) = predictions(dir, "baseline", condition);
    let (candidate, candidate_count) = predictions(dir, "candidate", condition);
    let processed = if pass == "candidate" {
        candidate_count
    } else {
        baseline_count
    };
    let mut value = json!({"pass":pass,"condition":condition,"cases":[]});
    if let Some(total) = counter(&protocol["samples"]) {
        value["total"] = json!(total);
    }
    if let Some(count) = processed {
        value["processed"] = json!(count);
    }
    let primary_rows = if candidate.is_empty() {
        &baseline
    } else {
        &candidate
    };
    let baseline_by_id: BTreeMap<_, _> = baseline
        .iter()
        .map(|row| (row["sample_id"].as_str().unwrap(), row))
        .collect();
    let candidate_by_id: BTreeMap<_, _> = candidate
        .iter()
        .map(|row| (row["sample_id"].as_str().unwrap(), row))
        .collect();
    let pair = |id: &str| {
        let after = candidate_by_id.get(id).copied();
        let before = baseline_by_id.get(id).copied().filter(|before| {
            after.is_none_or(|after| {
                [
                    "label",
                    "category",
                    "model_role",
                    "file_sha256",
                    "pixel_sha256",
                ]
                .iter()
                .all(|key| before[*key] == after[*key])
            })
        });
        (before, after)
    };
    let complete = counter(&protocol["samples"]).is_some_and(|total| {
        total > 0
            && baseline_count == Some(total)
            && candidate_count == Some(total)
            && baseline_by_id.len() as u64 == total
            && candidate_by_id.len() as u64 == total
    });
    let mut seen = BTreeSet::new();
    let mut order: Vec<_> = primary_rows
        .iter()
        .rev()
        .filter_map(|row| {
            let id = row["sample_id"].as_str().unwrap();
            seen.insert(id).then_some(id)
        })
        .collect();
    if complete {
        order.sort_by_key(|id| match pair(id) {
            (Some(before), Some(after))
                if before["raw_exact"] == true && after["raw_exact"] == false =>
            {
                0
            }
            (Some(before), Some(after))
                if before["raw_exact"] == false && after["raw_exact"] == true =>
            {
                1
            }
            _ => 2,
        });
    }
    let mut selected = Vec::new();
    for role in ["general", "names"] {
        selected.extend(
            order
                .iter()
                .copied()
                .filter(|id| {
                    let (before, after) = pair(id);
                    after
                        .or(before)
                        .is_some_and(|row| row["model_role"] == role)
                })
                .take(8),
        );
    }
    for id in &order {
        if selected.len() == 16 {
            break;
        }
        if !selected.contains(id) {
            selected.push(id);
        }
    }
    let mut cases = Vec::new();
    for id in selected {
        let (before, after) = pair(id);
        let primary = after.or(before)?;
        cases.push(json!({"sample_id":id,"role":primary["model_role"],"category":primary["category"],"condition":condition,"label":primary["label"],"baseline_prediction":before.as_ref().map(|row|row["raw_prediction"].clone()),"candidate_prediction":after.as_ref().map(|row|row["raw_prediction"].clone()),"baseline_exact":before.as_ref().map(|row|row["raw_exact"].clone()),"candidate_exact":after.as_ref().map(|row|row["raw_exact"].clone()),"image_url":null}));
    }
    value["cases"] = json!(cases);
    Some(value)
}

impl Reader {
    pub(super) fn read(&self, dir: &Path, condition: Option<&str>) -> Value {
        let stamps = snapshot_stamps(dir);
        if let Ok(cached) = self.snapshots.lock() {
            if let Some((_, _, _, value)) = cached.iter().find(|(path, preferred, prior, _)| {
                path == dir && preferred.as_deref() == condition && prior == &stamps
            }) {
                return value.clone();
            }
        }
        let value = self.read_uncached(dir, condition);
        if snapshot_stamps(dir) == stamps {
            if let Ok(mut cached) = self.snapshots.lock() {
                cached.retain(|(path, preferred, _, _)| {
                    path != dir || preferred.as_deref() != condition
                });
                cached.push_back((
                    dir.into(),
                    condition.map(str::to_owned),
                    stamps,
                    value.clone(),
                ));
                while cached.len() > 2 {
                    cached.pop_front();
                }
            }
        }
        value
    }
    fn read_uncached(&self, dir: &Path, condition: Option<&str>) -> Value {
        let mut benchmark = benchmark(dir, condition);
        let wanted: BTreeSet<String> = benchmark
            .as_ref()
            .and_then(|value| value["cases"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|value| value["sample_id"].as_str().map(str::to_owned))
            .collect();
        let selected: Vec<String> = read_optional_json(&dir.join("run.json"), 1_048_576)
            .ok()
            .flatten()
            .and_then(|run| run["collections"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|value| bounded_text(value, 128).map(str::to_owned))
            .collect();
        let mut groups: BTreeMap<&str, Vec<Value>> = selected
            .iter()
            .map(|id| (id.as_str(), Vec::new()))
            .collect();
        let mut samples = Vec::new();
        let mut matching = BTreeMap::new();
        if let Ok(index) = self.manifest(dir) {
            for row in index.order.iter().filter_map(|id| index.rows.get(id)) {
                let Some(id) = bounded_text(&row["sample_id"], 4096) else {
                    continue;
                };
                let Some(category) = bounded_text(&row["category"], 64) else {
                    continue;
                };
                let Some(label) = bounded_text(&row["label"], 4096) else {
                    continue;
                };
                if let Some(collection) = bounded_text(&row["dataset_id"], 128) {
                    if let Some(group) = groups.get_mut(collection) {
                        if group.len() < 4 {
                            if let Some(image_url) = sample_url(dir, row) {
                                group.push(json!({"sample_id":id,"collection_id":collection,"role":if category=="name"{"names"}else{"general"},"category":category,"label":label,"image_url":image_url}));
                            }
                        }
                    }
                }
                if wanted.contains(id) {
                    matching.insert(id.to_owned(), row.clone());
                }
            }
        }
        for index in 0..4 {
            for collection in &selected {
                if samples.len() == 8 {
                    break;
                }
                if let Some(sample) = groups
                    .get(collection.as_str())
                    .and_then(|group| group.get(index))
                {
                    if !samples
                        .iter()
                        .any(|prior: &Value| prior["sample_id"] == sample["sample_id"])
                    {
                        samples.push(sample.clone());
                    }
                }
            }
        }
        if let Some(value) = benchmark.as_mut() {
            if let Some(cases) = value["cases"].as_array_mut() {
                for case in cases {
                    if let Some(row) = matching.get(case["sample_id"].as_str().unwrap_or("")) {
                        if row["label"] == case["label"] && row["category"] == case["category"] {
                            case["image_url"] = json!(sample_url(dir, row));
                        }
                    }
                }
            }
        }
        let mut value = json!({"histories":histories(dir),"samples":samples});
        if let Some(benchmark) = benchmark {
            value["benchmark"] = benchmark;
        }
        value
    }

    pub(super) fn sample(
        &self,
        dir: &Path,
        id: &str,
        request: &LabRequest,
    ) -> LabResult<LabResponse> {
        if id.is_empty() || id.chars().count() > 4096 {
            return Err(bad("Invalid frozen sample identity"));
        }
        let index = self.manifest(dir)?;
        if index.duplicates.contains(id) {
            return Err(conflict("Frozen sample identity is ambiguous"));
        }
        let row = index
            .rows
            .get(id)
            .ok_or_else(|| not_found("Unknown frozen training sample"))?;
        if sample_url(dir, &row).is_none() {
            return Err(bad("Frozen sample image path or hash is invalid"));
        }
        let path = dir.join("bundle").join(row["image_path"].as_str().unwrap());
        managed_file(&dir.join("bundle"), &path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut bytes = Vec::new();
        options
            .open(path)?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
            return Err(bad("Frozen training image exceeds its size bound"));
        }
        let hash = super::super::sha256(&bytes);
        if row["file_sha256"] != hash {
            return Err(conflict(
                "Frozen training image hash differs from its manifest",
            ));
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "image/jpeg"
        } else {
            return Err(bad("Unsupported frozen image format"));
        };
        crate::media::decode_image(&bytes).map_err(bad)?;
        let etag = format!("\"{hash}\"");
        let mut response = if request.header("If-None-Match") == Some(etag.as_str()) {
            LabResponse::json(304, Value::Null)
        } else {
            LabResponse::binary(&bytes, mime)
        };
        response.headers.insert("ETag".into(), etag);
        response
            .headers
            .insert("Cache-Control".into(), "private, no-cache".into());
        Ok(response)
    }
}
