use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropSummary {
    pub min_width: f64,
    pub max_width: f64,
    pub mean_width: f64,
    pub min_height: f64,
    pub max_height: f64,
    pub mean_height: f64,
}
#[derive(Debug, Default, Serialize)]
pub struct LabelLengths {
    pub min: usize,
    pub max: usize,
    pub mean: f64,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMetrics {
    pub unique_labels: usize,
    pub mean_label_length: f64,
    pub mean_hamming_distance: f64,
    pub mean_aspect_ratio: f64,
    pub sampled_pairs: usize,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMetrics {
    pub categories: BTreeMap<String, usize>,
    pub top_labels: BTreeMap<String, usize>,
    pub crops: CropSummary,
    pub label_lengths: LabelLengths,
    pub per_category: BTreeMap<String, CategoryMetrics>,
    pub currency: BTreeMap<String, usize>,
    pub actions: BTreeMap<String, usize>,
    pub all_in_rate: f64,
}
#[derive(Default)]
struct Group {
    labels: Vec<String>,
    hashes: Vec<String>,
    aspects: Vec<f64>,
}
#[derive(Default)]
struct Dimensions {
    min: Option<f64>,
    max: Option<f64>,
    sum: f64,
    count: usize,
}
impl Dimensions {
    fn add(&mut self, value: Option<f64>) {
        if let Some(value) = value.filter(|v| v.is_finite()) {
            self.min = Some(self.min.map_or(value, |v| v.min(value)));
            self.max = Some(self.max.map_or(value, |v| v.max(value)));
            self.sum += value;
            self.count += 1;
        }
    }
    fn mean(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            round(self.sum / self.count as f64)
        }
    }
}
fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
fn category(region: &str) -> &'static str {
    let id = region.to_lowercase();
    if id.contains(".name") || id.ends_with("name") {
        "Name"
    } else if id.contains("status") {
        "Status"
    } else if id.contains("dealer") {
        "Dealer"
    } else if id.contains("community") || id.contains(".cards") || id.contains("hand") {
        "Card"
    } else if id.contains("split") && id.contains("pot") {
        "Split Pot"
    } else if id.contains("pot") {
        "Pot"
    } else if id.contains("bank") {
        "Bank"
    } else if id.contains("bet") {
        "Bet"
    } else {
        "Other"
    }
}
fn hash_distance(a: &str, b: &str) -> Option<u32> {
    if a.is_empty()
        || b.is_empty()
        || a.len() > 64
        || b.len() > 64
        || !a.is_ascii()
        || !b.is_ascii()
    {
        return None;
    }
    fn nibble(b: u8) -> Option<u32> {
        (b as char).to_digit(16)
    }
    let mut total = 0;
    let mut left = a.bytes().rev();
    let mut right = b.bytes().rev();
    for _ in 0..a.len().max(b.len()) {
        let l = left.next().map(nibble).unwrap_or(Some(0))?;
        let r = right.next().map(nibble).unwrap_or(Some(0))?;
        total += (l ^ r).count_ones();
    }
    Some(total)
}
fn sample_diversity(category: &str, hashes: &[String]) -> (f64, usize) {
    let n = hashes.len();
    if n < 2 {
        return (0.0, 0);
    }
    let target = 100
        .min(n.saturating_mul(2))
        .min(n.saturating_mul(n - 1) / 2);
    let mut seed = category.bytes().fold(0xcbf29ce484222325u64, |s, b| {
        (s ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    let mut pairs = BTreeSet::new();
    let mut distance = 0u64;
    let mut sampled = 0;
    for _ in 0..2000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let a = ((seed >> 32) as usize) % n;
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let b = ((seed >> 32) as usize) % n;
        if a == b || hashes[a] == hashes[b] || !pairs.insert((a.min(b), a.max(b))) {
            continue;
        }
        if let Some(d) = hash_distance(&hashes[a], &hashes[b]) {
            distance += u64::from(d);
            sampled += 1;
        }
        if sampled >= target {
            break;
        }
    }
    (
        if sampled == 0 {
            0.0
        } else {
            round(distance as f64 / sampled as f64)
        },
        sampled,
    )
}
pub fn dataset_metrics(conn: &Connection) -> rusqlite::Result<DatasetMetrics> {
    let mut metrics = DatasetMetrics::default();
    metrics.currency.insert("G".into(), 0);
    metrics.currency.insert("S".into(), 0);
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let mut counts: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut widths = Dimensions::default();
    let mut heights = Dimensions::default();
    let mut lengths = Vec::new();
    let mut all_in = 0;
    let mut stmt=conn.prepare("SELECT COALESCE(region_id,''),COALESCE(label,''),COALESCE(phash,''),w,h FROM images ORDER BY timestamp DESC,id DESC")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let region: String = row.get(0)?;
        let label: String = row.get(1)?;
        let hash: String = row.get(2)?;
        let width: Option<f64> = row.get(3)?;
        let height: Option<f64> = row.get(4)?;
        widths.add(width);
        heights.add(height);
        let category = category(&region).to_owned();
        *metrics.categories.entry(category.clone()).or_default() += 1;
        if label.is_empty() {
            continue;
        }
        let length = label.chars().count();
        lengths.push(length);
        let next = counts.len();
        let count = counts.entry(label.clone()).or_insert((0, next));
        count.0 += 1;
        let lower = label.to_lowercase();
        for action in [
            "Call", "Raise", "Check", "Bet", "All-In", "Fold", "SB", "BB", "Straddle",
        ] {
            if lower.contains(&action.to_lowercase()) {
                *metrics.actions.entry(action.into()).or_default() += 1;
            }
        }
        if lower.contains("all-in") {
            all_in += 1;
        }
        if label.starts_with("G ") {
            *metrics.currency.get_mut("G").expect("initialized") += 1;
        } else if label.starts_with("S ") {
            *metrics.currency.get_mut("S").expect("initialized") += 1;
        }
        let group = groups.entry(category).or_default();
        group.labels.push(label);
        if !hash.is_empty() {
            group.hashes.push(hash);
        }
        if let (Some(w), Some(h)) = (width, height) {
            if h > 0.0 && w.is_finite() && h.is_finite() {
                group.aspects.push(w / h);
            }
        }
    }
    let mut top: Vec<_> = counts.into_iter().collect();
    top.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.1 .1.cmp(&b.1 .1)));
    metrics.top_labels = top
        .into_iter()
        .take(10)
        .map(|(label, (count, _))| (label, count))
        .collect();
    metrics.crops = CropSummary {
        min_width: widths.min.unwrap_or(0.0),
        max_width: widths.max.unwrap_or(0.0),
        mean_width: widths.mean(),
        min_height: heights.min.unwrap_or(0.0),
        max_height: heights.max.unwrap_or(0.0),
        mean_height: heights.mean(),
    };
    if !lengths.is_empty() {
        metrics.label_lengths = LabelLengths {
            min: *lengths.iter().min().expect("nonempty"),
            max: *lengths.iter().max().expect("nonempty"),
            mean: round(lengths.iter().sum::<usize>() as f64 / lengths.len() as f64),
        };
        metrics.all_in_rate = round(all_in as f64 / lengths.len() as f64 * 100.0);
    }
    for (category, group) in groups {
        let (mean_hamming_distance, sampled_pairs) = sample_diversity(&category, &group.hashes);
        let unique_labels = group.labels.iter().collect::<BTreeSet<_>>().len();
        let mean_label_length = round(
            group
                .labels
                .iter()
                .map(|s| s.chars().count())
                .sum::<usize>() as f64
                / group.labels.len() as f64,
        );
        let mean_aspect_ratio = if group.aspects.is_empty() {
            0.0
        } else {
            round(group.aspects.iter().sum::<f64>() / group.aspects.len() as f64)
        };
        metrics.per_category.insert(
            category,
            CategoryMetrics {
                unique_labels,
                mean_label_length,
                mean_hamming_distance,
                mean_aspect_ratio,
                sampled_pairs,
            },
        );
    }
    Ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE images(id INTEGER PRIMARY KEY,region_id TEXT,label TEXT,phash TEXT,w INTEGER,h INTEGER,timestamp INTEGER)").unwrap();
        db
    }
    #[test]
    fn aggregates_legacy_categories_labels_crops_currency_and_actions() {
        let db = db();
        for (id, (region, label, hash, w, h)) in [
            ("seat.0.name", "Alice", "0".repeat(64), 100, 20),
            ("seats[1].name", "Bob", "f".repeat(64), 120, 20),
            ("seat.0.bank", "All-In", "0".repeat(64), 60, 20),
            ("seat.1.bet", "G 2 BB", "0".repeat(64), 40, 20),
            ("pot", "Pot: S 3 BB", "0".repeat(64), 80, 20),
            ("community_cards[0]", "A", "0".repeat(64), 20, 30),
            ("unknown", "", "".into(), 0, 0),
        ]
        .into_iter()
        .enumerate()
        {
            db.execute(
                "INSERT INTO images VALUES(?,?,?,?,?,?,?)",
                params![id as i64, region, label, hash, w, h, id as i64],
            )
            .unwrap();
        }
        let m = dataset_metrics(&db).unwrap();
        assert_eq!(m.categories["Name"], 2);
        assert_eq!(m.categories["Other"], 1);
        assert_eq!(m.top_labels["Alice"], 1);
        assert_eq!(m.currency["G"], 1);
        assert_eq!(m.currency["S"], 0);
        assert_eq!(m.actions["BB"], 2);
        assert_eq!(m.actions["All-In"], 1);
        assert_eq!(m.all_in_rate, 16.67);
        assert_eq!(m.crops.max_width, 120.0);
        assert_eq!(m.crops.mean_height, 18.57);
        assert_eq!(m.per_category["Name"].mean_hamming_distance, 256.0);
        assert_eq!(m.per_category["Name"].sampled_pairs, 1);
        assert_eq!(m.per_category["Name"].mean_aspect_ratio, 5.5);
        assert_eq!(m.per_category["Name"].mean_label_length, 4.0);
        assert_eq!(m.per_category["Name"].unique_labels, 2);
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::to_value(dataset_metrics(&db).unwrap()).unwrap()
        );
    }
    #[test]
    fn empty_dataset_and_bounded_hash_samples_are_stable() {
        let m = dataset_metrics(&db()).unwrap();
        assert!(m.categories.is_empty());
        assert!(m.top_labels.is_empty());
        assert_eq!(m.all_in_rate, 0.0);
        assert_eq!(m.crops.mean_width, 0.0);
        assert_eq!(m.label_lengths.mean, 0.0);
        let hashes: Vec<_> = (0..10000).map(|i| format!("{i:064x}")).collect();
        let a = sample_diversity("Name", &hashes);
        assert_eq!(a, sample_diversity("Name", &hashes));
        assert_eq!(a.1, 100);
        assert!(a.0.is_finite());
        assert_eq!(hash_distance("0000000000000000", "ff"), Some(8));
        assert_eq!(
            sample_diversity("Same", &vec!["0".repeat(64); 20]),
            (0.0, 0)
        );
    }
}
