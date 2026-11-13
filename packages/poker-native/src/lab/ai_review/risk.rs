//! Historical corrections affect ordering only, never replacement text.
use super::{region_group, rows, LabResult};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
// SequenceMatcher's longest matching blocks, including its >=200-character
// autojunk rule. Ties retain the earliest a then earliest b position.
fn changed_tokens(a: &str, b: &str) -> Vec<String> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut positions: HashMap<char, Vec<usize>> = HashMap::new();
    for (index, ch) in b.iter().enumerate() {
        positions.entry(*ch).or_default().push(index);
    }
    let popular: HashSet<char> = if b.len() >= 200 {
        positions
            .iter()
            .filter(|(_, p)| p.len() > b.len() / 100 + 1)
            .map(|(c, _)| *c)
            .collect()
    } else {
        HashSet::new()
    };
    for c in popular {
        positions.remove(&c);
    }
    let mut queue = vec![(0, a.len(), 0, b.len())];
    let mut matching = Vec::new();
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (mut best_i, mut best_j, mut size) = (alo, blo, 0);
        let mut previous: HashMap<usize, usize> = HashMap::new();
        for (i, ch) in a.iter().enumerate().take(ahi).skip(alo) {
            let mut current = HashMap::new();
            if let Some(matches) = positions.get(ch) {
                for &j in matches {
                    if j < blo {
                        continue;
                    }
                    if j >= bhi {
                        break;
                    }
                    let n = if j > 0 {
                        previous.get(&(j - 1)).copied().unwrap_or(0) + 1
                    } else {
                        1
                    };
                    current.insert(j, n);
                    if n > size {
                        best_i = i + 1 - n;
                        best_j = j + 1 - n;
                        size = n;
                    }
                }
            }
            previous = current;
        }
        while best_i > alo && best_j > blo && a[best_i - 1] == b[best_j - 1] {
            best_i -= 1;
            best_j -= 1;
            size += 1;
        }
        while best_i + size < ahi && best_j + size < bhi && a[best_i + size] == b[best_j + size] {
            size += 1;
        }
        if size > 0 {
            matching.push((best_i, best_j, size));
            if alo < best_i && blo < best_j {
                queue.push((alo, best_i, blo, best_j));
            }
            if best_i + size < ahi && best_j + size < bhi {
                queue.push((best_i + size, ahi, best_j + size, bhi));
            }
        }
    }
    matching.sort_unstable();
    let mut merged: Vec<(usize, usize, usize)> = Vec::new();
    for (i, j, n) in matching {
        if let Some(last) = merged.last_mut() {
            if last.0 + last.2 == i && last.1 + last.2 == j {
                last.2 += n;
                continue;
            }
        }
        merged.push((i, j, n));
    }
    merged.push((a.len(), b.len(), 0));
    let mut prior = 0;
    let mut result = Vec::new();
    for (i, _, n) in merged {
        if i > prior && i - prior <= 8 {
            result.push(a[prior..i].iter().collect());
        }
        prior = i + n;
    }
    result
}
pub fn order(conn: &Connection, snapshot: &mut [Value], ceiling: i64) -> LabResult<()> {
    let mut patterns: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut confusions: BTreeMap<(String, String), i64> = BTreeMap::new();
    for event in rows(conn,"SELECT e.prior_label,e.label,s.region_id FROM label_review_events e JOIN review_samples s USING(sample_key) WHERE e.action IN ('corrected','manual') AND e.prior_label!=e.label",[])?{let group=region_group(event["region_id"].as_str().unwrap());let prior=event["prior_label"].as_str().unwrap();*patterns.entry((group.clone(),prior.into())).or_default()+=1;for wrong in changed_tokens(prior,event["label"].as_str().unwrap()){*confusions.entry((group.clone(),wrong)).or_default()+=1;}}
    let predictions:BTreeMap<String,Value>=rows(conn,"SELECT DISTINCT p.id,p.payload FROM model_predictions p JOIN queue_items q ON q.prediction_id=p.id WHERE q.active=1 AND q.queue_id<=?",[ceiling])?.into_iter().map(|row|->LabResult<(String,Value)>{let value:Value=serde_json::from_str(row["payload"].as_str().unwrap())?;Ok((row["id"].as_str().unwrap().into(),value["text"].clone()))}).collect::<LabResult<_>>()?;
    let mut maximum: BTreeMap<String, i64> = BTreeMap::new();
    for row in snapshot.iter_mut() {
        let group = region_group(row["region_id"].as_str().unwrap());
        let label = row["label"].as_str().unwrap();
        let risk = patterns
            .get(&(group.clone(), label.into()))
            .copied()
            .unwrap_or(0)
            * 10
            + confusions
                .iter()
                .filter(|((g, wrong), _)| g == &group && label.contains(wrong.as_str()))
                .map(|(_, count)| *count)
                .sum::<i64>()
            + i64::from(
                predictions
                    .get(row["prediction_id"].as_str().unwrap_or(""))
                    .unwrap_or(&row["label"])
                    != &row["label"],
            );
        maximum
            .entry(group.clone())
            .and_modify(|r| *r = (*r).max(risk))
            .or_insert(risk);
        row["group_name"] = Value::String(group);
        row["risk"] = Value::from(risk);
    }
    snapshot.sort_by(|a, b| {
        let ga = a["group_name"].as_str().unwrap();
        let gb = b["group_name"].as_str().unwrap();
        maximum[gb]
            .cmp(&maximum[ga])
            .then_with(|| ga.cmp(gb))
            .then_with(|| b["risk"].as_i64().cmp(&a["risk"].as_i64()))
            .then_with(|| a["queue_id"].as_i64().cmp(&b["queue_id"].as_i64()))
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sequence_changes_do_not_propagate_labels() {
        assert_eq!(changed_tokens("0.1S BB", "0.15 BB"), vec!["S"]);
        assert_eq!(changed_tokens("Granny", "Gwenny"), vec!["ra"]);
        assert!(changed_tokens("same", "same").is_empty());
    }
    #[test]
    fn matching_tokens_match_source_python_difflib_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/sequence-matcher.json")).unwrap();
        for case in cases {
            let expected: Vec<String> =
                serde_json::from_value(case["wrong_tokens"].clone()).unwrap();
            assert_eq!(
                changed_tokens(
                    case["prior"].as_str().unwrap(),
                    case["corrected"].as_str().unwrap()
                ),
                expected,
                "{case}"
            );
        }
    }
}
