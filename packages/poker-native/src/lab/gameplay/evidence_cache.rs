use crate::lab::{bad, conflict, now_ms, sha256, LabResult};
use image::{DynamicImage, RgbImage};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
#[path = "money_shape.rs"]
pub mod money_shape;

pub const POLICY: &str = "family_exact_v1";

pub fn family(region: &str) -> Option<&'static str> {
    Some(match crate::labels::category_for_region(region)? {
        "card" => "rank",
        "suit" => "suit",
        "name" => "name",
        "status" => "status",
        "bet" => "money_scalar",
        "split_pot" => "money_list",
        "bank" => "bank",
        "pot" => "upper_pot",
        "game_id" | "round_id" => "game_id",
        "table_info" => "table_line",
        "dealer" => "dealer",
        "amount" => "amount",
        "winner" => "winner",
        "combination" => "combination",
        "timer" => "timer",
        "popup" => "popup",
        _ => return None,
    })
}

pub const REVIEW_POLICY: &str = "card_support_seat_occupancy_blank_consistency_raw_recovery_v3";
pub fn proven_empty_seat(region: &str, payload: &Value) -> bool {
    (region.starts_with("seat.") || region.starts_with("seats["))
        && payload["seat_occupancy"]["state"] == "empty"
        && payload["seat_occupancy"]["source"] == "source_free_seat_pixels"
        && payload["seat_occupancy"]["policy"] == "source_free_seat_occupancy_v1"
}
pub fn source_absent(region: &str, payload: &Value) -> bool {
    proven_empty_seat(region, payload)
        || (!matches!(family(region), Some("rank" | "suit"))
            && payload["presence"]["state"] == "absent")
}

pub fn automatic_support(region: &str, payload: &Value) -> bool {
    !proven_empty_seat(region, payload)
        && (!matches!(family(region), Some("rank" | "suit"))
            || (payload["presence"]["target_support"] == "supported"
                && payload["presence"]["card_evidence"]["target_support"] == "supported"
                && payload["presence"]["card_evidence"]["policy"]
                    == super::super::card_fields::TARGET_EVIDENCE_POLICY))
}

pub fn blank_contradicts_foreground(region: &str, payload: &Value, text: &str) -> bool {
    text.is_empty()
        && matches!(family(region), Some("rank" | "suit"))
        && automatic_support(region, payload)
}

pub fn identity(family: &str, pixels: &str) -> String {
    sha256(format!("{POLICY}:{family}:{pixels}").as_bytes())
}

pub fn evidence_family(region: &str, guide: &Value) -> Option<String> {
    let kind = family(region)?;
    if kind == "amount" && guide["family"] == "split_pot_group" {
        // A historical wide image can contain several targets; ordinal is meaning, not seat provenance.
        return guide["target_ordinal"]
            .as_u64()
            .map(|ordinal| format!("amount_target:{ordinal}"));
    }
    Some(kind.into())
}

pub fn strict_padding_equivalent(left: &[u8], right: &[u8]) -> bool {
    super::crops::padding_translation_equal(left, right)
}

pub fn enabled(conn: &Connection) -> LabResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_ai_cache_aliases')",
        [],
        |row| row.get(0),
    )?)
}

pub fn ensure(conn: &Connection) -> LabResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_cache_aliases(sample_key TEXT PRIMARY KEY,family TEXT NOT NULL,pixel_sha256 TEXT NOT NULL,cache_key TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gameplay_ai_cache_identity ON gameplay_ai_cache_aliases(family,pixel_sha256);
CREATE INDEX IF NOT EXISTS gameplay_ai_cache_group ON gameplay_ai_cache_aliases(cache_key,sample_key);
CREATE TABLE IF NOT EXISTS gameplay_ai_cache_components(parent_key TEXT NOT NULL,ordinal INTEGER NOT NULL,component_key TEXT NOT NULL,PRIMARY KEY(parent_key,ordinal));
CREATE INDEX IF NOT EXISTS gameplay_ai_cache_component_parent ON gameplay_ai_cache_components(component_key,parent_key);
CREATE TABLE IF NOT EXISTS gameplay_ai_cache_component_layouts(parent_key TEXT PRIMARY KEY,layout TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gameplay_ai_cache_context(occurrence_id TEXT PRIMARY KEY,payload TEXT NOT NULL);")?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS gameplay_ai_cache_decision_sample ON gameplay_ai_decisions(sample_key,id)")?;
    let mut cursor: i64=conn.query_row("SELECT CAST(value AS INTEGER) FROM queue_meta WHERE key='evidence_cache_alias_cursor_v1'",[],|r|r.get(0)).optional()?.unwrap_or(0);
    loop {
        let rows=conn.prepare("SELECT queue_id,sample_key,region_id,pixel_sha256,payload FROM queue_items WHERE queue_id>? ORDER BY queue_id LIMIT 64")?.query_map([cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            break;
        }
        let tx = conn.unchecked_transaction()?;
        for (id, key, region, pixels, payload) in rows {
            let payload: Value = serde_json::from_str(&payload)?;
            let kind = evidence_family(&region, &payload["guide"])
                .unwrap_or_else(|| format!("unsupported:{key}"));
            register(&tx, &key, &kind, &pixels)?;
            cursor = id;
        }
        tx.execute("INSERT INTO queue_meta(key,value) VALUES('evidence_cache_alias_cursor_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[cursor.to_string()])?;
        tx.commit()?;
    }
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ai_review_items')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        conn.execute_batch("CREATE INDEX IF NOT EXISTS gameplay_ai_cache_review_sample ON ai_review_items(sample_key,state)")?;
    }
    super::quarantine::ensure(conn)?;
    enable_normalized(conn)?;
    Ok(())
}

pub fn register(conn: &Connection, key: &str, kind: &str, pixels: &str) -> LabResult<()> {
    let old: Option<(String, String)> = conn
        .query_row(
            "SELECT family,pixel_sha256 FROM gameplay_ai_cache_aliases WHERE sample_key=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if old.as_ref().is_some_and(|(f, p)| f != kind || p != pixels) {
        return Err(conflict("Evidence alias identity changed"));
    }
    conn.execute("INSERT OR IGNORE INTO gameplay_ai_cache_aliases(sample_key,family,pixel_sha256,cache_key) VALUES(?,?,?,?)",params![key,kind,pixels,identity(kind,pixels)])?;
    Ok(())
}

pub fn representative(conn: &Connection, kind: &str, pixels: &str) -> LabResult<Option<String>> {
    Ok(conn.query_row("SELECT a.sample_key FROM gameplay_ai_cache_aliases a JOIN queue_items q USING(sample_key) WHERE a.family=? AND a.pixel_sha256=? ORDER BY q.queue_id LIMIT 1",params![kind,pixels],|r|r.get(0)).optional()?)
}

pub fn normalized_enabled(conn: &Connection) -> LabResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gameplay_ai_cache_normalized')",
        [],
        |r| r.get(0),
    )?)
}

pub fn enable_normalized(conn: &Connection) -> LabResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS gameplay_ai_cache_normalized(pixel_sha256 TEXT NOT NULL,policy TEXT NOT NULL,sample_key TEXT NOT NULL,bucket TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(pixel_sha256,policy));CREATE INDEX IF NOT EXISTS gameplay_ai_cache_normalized_bucket ON gameplay_ai_cache_normalized(bucket)")?;
    Ok(())
}

pub fn normalized_representative(
    conn: &Connection,
    signature: &money_shape::Signature,
    exact: Option<String>,
) -> LabResult<Option<String>> {
    let exact_key = exact.clone();
    let mut matches = exact.into_iter().collect::<Vec<_>>();
    let candidates=conn.prepare("SELECT n.sample_key,n.signature FROM gameplay_ai_cache_normalized n JOIN queue_items q USING(sample_key) WHERE n.bucket=? ORDER BY q.queue_id")?.query_map([money_shape::bucket(signature)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (key, raw) in candidates {
        let candidate: money_shape::Signature = serde_json::from_str(&raw)?;
        if money_shape::equivalent(signature, &candidate) && !matches.contains(&key) {
            matches.push(key);
        }
    }
    if matches.is_empty() {
        return Ok(None);
    }
    let mut groups = BTreeSet::new();
    let mut canonical = None::<(i64, String, String)>;
    for key in &matches {
        let (family, group) =
            alias(conn, key)?.ok_or_else(|| conflict("Normalized evidence has no source alias"))?;
        if family != "money_scalar" {
            return Err(conflict("Normalized evidence has incompatible meaning"));
        }
        let (id,representative):(i64,String)=conn.query_row("SELECT q.queue_id,q.sample_key FROM gameplay_ai_cache_aliases a JOIN queue_items q USING(sample_key) WHERE a.cache_key=? ORDER BY q.queue_id LIMIT 1",[&group],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if canonical.as_ref().is_none_or(|old| id < old.0) {
            canonical = Some((id, representative, group.clone()));
        }
        groups.insert(group);
    }
    let (_, key, canonical) = canonical.unwrap();
    let mut signatures = vec![signature.clone()];
    for group in &groups {
        let raw = conn.prepare("SELECT DISTINCT n.signature FROM gameplay_ai_cache_normalized n JOIN gameplay_ai_cache_aliases a ON a.sample_key=n.sample_key WHERE a.cache_key=?")?.query_map([group],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for raw in raw {
            let candidate: money_shape::Signature = serde_json::from_str(&raw)?;
            if signatures
                .iter()
                .any(|prior| !money_shape::equivalent(prior, &candidate))
            {
                return Ok(exact_key);
            }
            signatures.push(candidate);
        }
    }
    for group in groups {
        if group != canonical {
            conn.execute(
                "UPDATE gameplay_ai_cache_aliases SET cache_key=? WHERE cache_key=?",
                params![canonical, group],
            )?;
        }
    }
    Ok(Some(key))
}

pub fn record_normalized(
    conn: &Connection,
    pixels: &str,
    key: &str,
    signature: &money_shape::Signature,
) -> LabResult<()> {
    if alias(conn, key)?.is_none_or(|(family, _)| family != "money_scalar") {
        return Err(conflict(
            "Normalized evidence must reference a scalar money alias",
        ));
    }
    conn.execute("INSERT OR IGNORE INTO gameplay_ai_cache_normalized(pixel_sha256,policy,sample_key,bucket,signature) VALUES(?,?,?,?,?)",params![pixels,money_shape::POLICY,key,money_shape::bucket(signature),serde_json::to_string(signature)?])?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub enum Truth {
    Accepted {
        label: String,
        human: bool,
    },
    NeedsReview {
        reason: String,
        proposed_label: Option<String>,
    },
    Blocked(String),
    Pending,
}

fn alias(conn: &Connection, key: &str) -> LabResult<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT family,cache_key FROM gameplay_ai_cache_aliases WHERE sample_key=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

fn valid_for_family(kind: &str, text: &str, human: bool) -> bool {
    let kind = if kind.starts_with("amount_target:") {
        "amount"
    } else {
        kind
    };
    let region = match kind {
        "rank" => "community_cards[0]",
        "suit" => "community_cards[0].suit",
        "name" => "seats[0].name",
        "status" => "seats[0].status",
        "money_scalar" => "seats[0].bet",
        "money_list" => "split_pot",
        "bank" => "seats[0].bank",
        "upper_pot" => "pot",
        "game_id" => "round_id",
        "table_line" => "table_info",
        "dealer" => "dealer",
        "amount" => "pot.0",
        "winner" => "seat.0.award",
        "combination" => "game.high_hand",
        "timer" => "header.timer",
        "popup" => "popup",
        _ => return false,
    };
    crate::labels::validate_reviewed_label(
        region,
        text,
        if human { "manual" } else { "accepted" },
        human,
    )
    .is_ok()
}

fn base_truth(conn: &Connection, key: &str) -> LabResult<Truth> {
    let Some((kind, group)) = alias(conn, key)? else {
        return Ok(Truth::Pending);
    };
    let decisions=conn.prepare("SELECT d.label,d.state FROM gameplay_ai_decisions d JOIN gameplay_ai_cache_aliases a USING(sample_key) WHERE a.cache_key=? AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id)")?.query_map([&group],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let decisions = if decisions.is_empty() {
        conn.prepare("SELECT m.label,m.state FROM gameplay_ai_manual m JOIN gameplay_ai_cache_aliases a USING(sample_key) WHERE a.cache_key=?")?.query_map([&group],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        decisions
    };
    if !decisions.is_empty() {
        let labels = decisions
            .iter()
            .map(|(label, _)| label.clone())
            .collect::<BTreeSet<_>>();
        if decisions.iter().all(|(_, state)| state == "ambiguous") {
            return Ok(Truth::NeedsReview {
                reason: "Human evidence is ambiguous; explicit resolution is required".into(),
                proposed_label: None,
            });
        }
        if labels.len() != 1 || decisions.iter().any(|(_, state)| state != "manual") {
            return Ok(Truth::Blocked("Conflicting manual readings".into()));
        }
        let label = labels.into_iter().next().unwrap();
        return Ok(if valid_for_family(&kind, &label, true) {
            Truth::Accepted { label, human: true }
        } else {
            Truth::NeedsReview {
                reason: "Historical human reading is outside the current field contract".into(),
                proposed_label: Some(label),
            }
        });
    }
    let items=conn.prepare("SELECT i.state,i.result,i.job_id,i.pixel_sha256,a.pixel_sha256,q.pixel_sha256,q.payload,(SELECT json_extract(r.scope,'$.validation_sha256') FROM gameplay_ai_runs r WHERE r.job_id=i.job_id LIMIT 1) FROM ai_review_items i JOIN gameplay_ai_cache_aliases a USING(sample_key) JOIN queue_items q USING(sample_key) WHERE a.cache_key=? AND i.state!='pending' ORDER BY i.rowid")?.query_map([&group],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut labels = BTreeSet::new();
    let mut review = None;
    for (state, result, job, pixels, alias_pixels, queue_pixels, payload, contract) in items {
        let result: Value = serde_json::from_str(result.as_deref().unwrap_or("{}"))?;
        let proposed = result["proposed_label"]
            .as_str()
            .or_else(|| result["first_reading"]["text"].as_str())
            .or_else(|| result["label"].as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if super::quarantine::contains(conn, &job)? {
            review = Some(Truth::NeedsReview {
                reason: "Job quarantined; automatic outcomes are provisional pending audit".into(),
                proposed_label: proposed,
            });
            continue;
        }
        if ["unchanged", "corrected"].contains(&state.as_str()) {
            let payload: Value = serde_json::from_str(&payload)?;
            if pixels != alias_pixels
                || pixels != queue_pixels
                || result["pixel_sha256"] != pixels
                || contract.as_deref() != Some(sha256(crate::labels::CONTRACT_BYTES).as_str())
                || !automatic_support(
                    if kind == "rank" {
                        "board.0.rank"
                    } else if kind == "suit" {
                        "board.0.suit"
                    } else {
                        "game.id"
                    },
                    &payload,
                )
                || !payload["guide"]["guideUnsupportedReason"].is_null()
                || !payload["guide"]["localization_error"].is_null()
                || !payload["localization_error"].is_null()
            {
                review = Some(Truth::NeedsReview { reason: "Automatic evidence identity, localization or validation contract is untrusted".into(), proposed_label: proposed });
                continue;
            }
            let first = &result["first_reading"];
            let second = &result["verification"];
            if !matches!(first["clarity"].as_str(), Some("clear" | "blank"))
                || second["clarity"] != first["clarity"]
                || second["text"] != first["text"]
                || second["text"].as_str().is_none()
            {
                review = Some(Truth::NeedsReview {
                    reason: "Independent reading is missing or disagrees".into(),
                    proposed_label: proposed,
                });
                continue;
            }
            let Some(label) = result["label"].as_str() else {
                review = Some(Truth::NeedsReview {
                    reason: "Historical review contains no accepted transcript".into(),
                    proposed_label: proposed,
                });
                continue;
            };
            if blank_contradicts_foreground(
                if kind == "rank" {
                    "board.0.rank"
                } else if kind == "suit" {
                    "board.0.suit"
                } else {
                    "game.id"
                },
                &payload,
                label,
            ) {
                review = Some(Truth::NeedsReview {
                    reason: "Blank reading contradicts supported card foreground".into(),
                    proposed_label: Some(label.to_owned()),
                });
                continue;
            }
            if first["text"] == label && valid_for_family(&kind, label, false) {
                labels.insert(label.to_owned());
            } else {
                review = Some(Truth::NeedsReview {
                    reason: "Historical accepted reading is outside the current field contract"
                        .into(),
                    proposed_label: proposed,
                });
            }
        } else {
            review = Some(Truth::NeedsReview {
                reason: result["reason"]
                    .as_str()
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or(
                        "Prior review was uncertain or incomplete; explicit resolution is required",
                    )
                    .into(),
                proposed_label: proposed,
            });
        }
    }
    if labels.len() > 1 {
        return Ok(Truth::Blocked(
            "Previously accepted readings disagree across matching evidence".into(),
        ));
    }
    if let Some(label) = labels.into_iter().next() {
        return Ok(Truth::Accepted {
            label,
            human: false,
        });
    }
    Ok(review.unwrap_or(Truth::Pending))
}

pub fn parse_money_list(label: &str) -> Option<Vec<String>> {
    if !crate::labels::validate_text("split_pot", label, false) {
        return None;
    }
    let starts = label
        .char_indices()
        .filter(|(index, c)| {
            (*c == 'S' || *c == 'G') && (*index == 0 || label.as_bytes()[index - 1] == b' ')
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if starts.first() != Some(&0) {
        return None;
    }
    let items = starts
        .iter()
        .enumerate()
        .map(|(ordinal, start)| {
            label[*start..starts.get(ordinal + 1).copied().unwrap_or(label.len())]
                .trim()
                .to_owned()
        })
        .collect::<Vec<_>>();
    items
        .iter()
        .all(|item| crate::labels::validate_text("bet", item, false))
        .then_some(items)
}

fn component_keys(conn: &Connection, parent: &str) -> LabResult<Vec<String>> {
    let mapped:Option<String>=conn.query_row("SELECT l.parent_key FROM gameplay_ai_cache_component_layouts l JOIN gameplay_ai_cache_aliases a ON a.sample_key=l.parent_key WHERE a.cache_key=(SELECT cache_key FROM gameplay_ai_cache_aliases WHERE sample_key=?) ORDER BY l.parent_key=? DESC,l.parent_key LIMIT 1",params![parent,parent],|r|r.get(0)).optional()?;
    let parent = mapped.as_deref().unwrap_or(parent);
    Ok(conn.prepare("SELECT component_key FROM gameplay_ai_cache_components WHERE parent_key=? ORDER BY ordinal")?.query_map([parent],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

pub fn truth(conn: &Connection, key: &str) -> LabResult<Truth> {
    let Some((kind, group)) = alias(conn, key)? else {
        return Ok(Truth::Pending);
    };
    let direct = base_truth(conn, key)?;
    if matches!(direct, Truth::Blocked(_) | Truth::NeedsReview { .. }) {
        return Ok(direct);
    }
    if kind == "money_list" {
        let components = component_keys(conn, key)?;
        if components.is_empty() {
            return Ok(direct);
        }
        if let Truth::Accepted { ref label, .. } = direct {
            if parse_money_list(label).is_none_or(|parts| parts.len() != components.len()) {
                return Ok(Truth::Blocked(
                    "Accepted split list does not match the resolved panel count/order".into(),
                ));
            }
            return Ok(direct);
        }
        let mut labels = Vec::new();
        let mut human = true;
        for component in components {
            match scalar_truth(conn, &component)? {
                Truth::Accepted { label, human: own } => {
                    labels.push(label);
                    human &= own
                }
                Truth::Blocked(reason) => return Ok(Truth::Blocked(reason)),
                review @ Truth::NeedsReview { .. } => return Ok(review),
                Truth::Pending => return Ok(Truth::Pending),
            }
        }
        let label = labels.join(" ");
        return Ok(if parse_money_list(&label).is_some() {
            Truth::Accepted { label, human }
        } else {
            Truth::Blocked("Resolved components do not compose a valid ordered split list".into())
        });
    }
    if kind == "money_scalar" {
        return scalar_truth_with_direct(conn, key, &group, direct);
    }
    Ok(direct)
}

fn scalar_truth(conn: &Connection, key: &str) -> LabResult<Truth> {
    let Some((_, group)) = alias(conn, key)? else {
        return Ok(Truth::Pending);
    };
    scalar_truth_with_direct(conn, key, &group, base_truth(conn, key)?)
}

fn scalar_truth_with_direct(
    conn: &Connection,
    _key: &str,
    group: &str,
    direct: Truth,
) -> LabResult<Truth> {
    if matches!(direct, Truth::Blocked(_) | Truth::NeedsReview { .. }) {
        return Ok(direct);
    }
    let parents=conn.prepare("SELECT DISTINCT c.parent_key FROM gameplay_ai_cache_components c JOIN gameplay_ai_cache_aliases a ON a.sample_key=c.component_key WHERE a.cache_key=?")?.query_map([group],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut labels = BTreeSet::new();
    let mut human = false;
    let mut blocked_parent = None;
    if let Truth::Accepted { label, human: own } = &direct {
        labels.insert(label.clone());
        human = *own;
    }
    for parent in parents {
        let (label, own) = match base_truth(conn, &parent)? {
            Truth::Accepted { label, human } => (label, human),
            blocked @ Truth::Blocked(_) | blocked @ Truth::NeedsReview { .. } => {
                blocked_parent = Some(blocked);
                continue;
            }
            Truth::Pending => continue,
        };
        let Some(parts) = parse_money_list(&label) else {
            continue;
        };
        let components = component_keys(conn, &parent)?;
        if parts.len() != components.len() {
            continue;
        }
        for (component, label) in components.iter().zip(parts) {
            if alias(conn, component)?.is_some_and(|(_, candidate)| candidate == group) {
                labels.insert(label);
                human |= own;
            }
        }
    }
    if labels.len() > 1 {
        return Ok(Truth::Blocked(
            "Scalar and ordered-list evidence disagree for matching pixels".into(),
        ));
    }
    if labels.is_empty() {
        if let Some(reason) = blocked_parent {
            return Ok(reason);
        }
    }
    Ok(labels
        .into_iter()
        .next()
        .map(|label| Truth::Accepted { label, human })
        .unwrap_or(Truth::Pending))
}

pub fn terminal(conn: &Connection, key: &str) -> LabResult<bool> {
    Ok(!matches!(truth(conn, key)?, Truth::Pending))
}

pub fn coalesce_pending(conn: &Connection) -> LabResult<()> {
    let groups=conn.prepare("SELECT DISTINCT a.cache_key FROM gameplay_ai_cache_aliases a JOIN queue_items q USING(sample_key) WHERE q.active=1")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for group in groups {
        let (key,kind):(String,String)=conn.query_row("SELECT a.sample_key,a.family FROM gameplay_ai_cache_aliases a JOIN queue_items q USING(sample_key) WHERE a.cache_key=? AND q.active=1 ORDER BY q.queue_id LIMIT 1",[&group],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let pending = !terminal(conn, &key)?
            && !(kind == "money_list" && !component_keys(conn, &key)?.is_empty());
        conn.execute("UPDATE queue_items SET active=0 WHERE sample_key IN (SELECT sample_key FROM gameplay_ai_cache_aliases WHERE cache_key=?)",[group])?;
        if pending {
            conn.execute("UPDATE queue_items SET active=1 WHERE sample_key=?", [key])?;
        }
    }
    Ok(())
}

pub fn save_context(
    conn: &Connection,
    occurrence: &str,
    guide: &Value,
    mask: &Value,
    pixels: &str,
    image: &DynamicImage,
) -> LabResult<bool> {
    let encoded = ensure_image_asset(conn, pixels, image)?;
    conn.execute("INSERT INTO gameplay_ai_cache_context(occurrence_id,payload) VALUES(?,?) ON CONFLICT(occurrence_id) DO UPDATE SET payload=json_patch(gameplay_ai_cache_context.payload,excluded.payload)",params![occurrence,json!({"guide":guide,"crop_mask":mask,"pixel_asset_sha":pixels,"presence":null}).to_string()])?;
    Ok(encoded)
}

pub fn pin_frame_evidence(conn: &Connection, occurrence: &str, evidence: &Value) -> LabResult<()> {
    let mut saved = context(conn, occurrence)?.unwrap_or_else(|| json!({}));
    if !saved["source_frame"].is_null() && saved["source_frame"] != *evidence {
        return Err(conflict(
            "Original frame evidence changed for this occurrence",
        ));
    }
    saved["source_frame"] = evidence.clone();
    conn.execute("INSERT INTO gameplay_ai_cache_context(occurrence_id,payload) VALUES(?,?) ON CONFLICT(occurrence_id) DO UPDATE SET payload=excluded.payload",params![occurrence,saved.to_string()])?;
    Ok(())
}

fn ensure_image_asset(conn: &Connection, pixels: &str, image: &DynamicImage) -> LabResult<bool> {
    let mut encoded = false;
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pixel_assets WHERE pixel_sha256=?)",
        [pixels],
        |r| r.get::<_, bool>(0),
    )? {
        let png = crate::media::png(image).map_err(bad)?;
        crate::lab::pixel_assets::put(conn, &png, pixels)?;
        encoded = true;
    }
    Ok(encoded)
}

pub fn context_crop(conn: &Connection, context: &Value, fallback: Vec<u8>) -> LabResult<Vec<u8>> {
    let Some(pixels) = context["pixel_asset_sha"].as_str() else {
        return Ok(fallback);
    };
    Ok(conn.query_row("SELECT poker_verified_crop(png,pixel_sha256,width,height,png_sha256) FROM pixel_assets WHERE pixel_sha256=?",[pixels],|r|r.get(0)).map_err(|_|bad("Source crop asset is missing or corrupt"))?)
}

pub const PRESENCE_CONFLICT: &str = "Presence contradicts occurrence-owned human evidence";

pub fn record_absence(
    conn: &Connection,
    occurrence: &str,
    run: &str,
    session: &str,
    frame: &str,
    region: &str,
    category: &str,
    profile: &str,
    bounds: &Value,
    original: &Value,
    presence: &Value,
) -> LabResult<bool> {
    let human:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=? AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id) AND d.state='manual')",[occurrence],|r|r.get(0))?;
    let state = if human { "ambiguous" } else { "absent" };
    let reason = if human {
        format!(
            "{PRESENCE_CONFLICT}: {}",
            presence["reason"].as_str().unwrap_or("")
        )
    } else {
        presence["reason"]
            .as_str()
            .unwrap_or("Source field is absent")
            .into()
    };
    let placeholder = format!("presence-only:{occurrence}");
    conn.execute("INSERT INTO gameplay_ai_occurrences(id,run_id,session_id,frame_id,region_id,category,sample_key,original_label,original_prediction,profile_id,rect,state,reason,cache_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'presence') ON CONFLICT(frame_id,profile_id,region_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,reason=excluded.reason,cache_kind='presence',sample_key=CASE WHEN ? THEN gameplay_ai_occurrences.sample_key ELSE excluded.sample_key END",params![occurrence,run,session,frame,region,category,placeholder,original["text"].as_str().unwrap_or(""),original.to_string(),profile,bounds.to_string(),state,reason,human])?;
    conn.execute(
        "INSERT OR IGNORE INTO gameplay_ai_run_items(run_id,occurrence_id) VALUES(?,?)",
        params![run, occurrence],
    )?;
    let mut payload = context(conn, occurrence)?.unwrap_or(json!({}));
    payload["presence"] = presence.clone();
    conn.execute("INSERT INTO gameplay_ai_cache_context(occurrence_id,payload) VALUES(?,?) ON CONFLICT(occurrence_id) DO UPDATE SET payload=excluded.payload",params![occurrence,payload.to_string()])?;
    Ok(human)
}

pub fn context(conn: &Connection, occurrence: &str) -> LabResult<Option<Value>> {
    if !enabled(conn)? {
        return Ok(None);
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM gameplay_ai_cache_context WHERE occurrence_id=?",
            [occurrence],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}

pub fn work_key(conn: &Connection, sample: &str) -> LabResult<String> {
    Ok(alias(conn, sample)?
        .map(|(_, group)| group)
        .unwrap_or_else(|| format!("unresolved:{sample}")))
}

pub fn group_work(conn: &Connection, items: Vec<Value>) -> LabResult<Vec<Value>> {
    let cache_enabled = enabled(conn)?;
    let mut groups = std::collections::BTreeMap::<String, Vec<Value>>::new();
    for item in items {
        if item["state"] == "absent" {
            continue;
        }
        groups
            .entry(if let Some(key) = item["work_key"].as_str() {
                key.into()
            } else if cache_enabled {
                work_key(conn, item["sample_key"].as_str().unwrap())?
            } else {
                item["sample_key"].as_str().unwrap().into()
            })
            .or_default()
            .push(item);
    }
    let mut output = Vec::new();
    for (group, mut occurrences) in groups {
        let priority = |item: &Value| match item["state"].as_str().unwrap_or("") {
            "conflict" => 0,
            "flagged" => 1,
            "pending" => 2,
            "ambiguous" => 3,
            _ => 4,
        };
        occurrences.sort_by(|left, right| {
            priority(left)
                .cmp(&priority(right))
                .then(left["id"].as_str().cmp(&right["id"].as_str()))
        });
        let mut item = occurrences[0].clone();
        let key = item["sample_key"].as_str().unwrap().to_owned();
        let shared = if cache_enabled && item["review_evidence"]["cache_eligible"] != false {
            truth(conn, &key)?
        } else {
            Truth::Pending
        };
        if let Truth::Blocked(reason) = shared {
            item["state"] = json!("conflict");
            item["reason"] = json!(reason);
        }
        let conflicts=occurrences.iter().filter(|item|item["has_manual_decision"]==true).map(|item|json!({"id":item["id"],"frame_id":item["frame_id"],"region_id":item["region_id"],"label":item["label"],"state":item["state"],"revision":item["revision"],"original_label":item["original_label"]})).collect::<Vec<_>>();
        let mut labels = conflicts
            .iter()
            .filter(|item| item["state"] == "manual")
            .filter_map(|item| item["label"].as_str().map(str::to_owned))
            .collect::<BTreeSet<_>>();
        if cache_enabled {
            let historical = conn.prepare("SELECT DISTINCT d.label FROM gameplay_ai_decisions d JOIN gameplay_ai_cache_aliases a USING(sample_key) WHERE a.cache_key=? AND d.state='manual' AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id)")?.query_map([&group],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            labels.extend(historical);
        }
        let components = if cache_enabled {
            component_keys(conn, &key)?
        } else {
            Vec::new()
        };
        let component_groups = components
            .iter()
            .map(|key| work_key(conn, key))
            .collect::<LabResult<Vec<_>>>()?;
        item["work_key"] = json!(group);
        item["occurrence_count"] = json!(occurrences.len());
        item["representative_occurrence_id"] = item["id"].clone();
        let mut preview=occurrences.iter().map(|item|json!({"id":item["id"],"frame_id":item["frame_id"],"region_id":item["region_id"],"label":item["label"],"state":item["state"],"revision":item["revision"],"original_label":item["original_label"],"has_manual_decision":item["has_manual_decision"]})).collect::<Vec<_>>();
        preview.sort_by_key(|item| item["has_manual_decision"] != true);
        item["has_more_occurrences"] = json!(preview.len() > 20);
        preview.truncate(20);
        item["occurrences"] = json!(preview);
        item["conflicting_labels"] = json!(labels);
        item["component_work_keys"] = json!(component_groups);
        output.push(item);
    }
    output.sort_by(|a, b| {
        a["frame_id"]
            .as_str()
            .cmp(&b["frame_id"].as_str())
            .then(a["region_id"].as_str().cmp(&b["region_id"].as_str()))
    });
    Ok(output)
}

pub fn group_counts(
    conn: &Connection,
    items: &[Value],
    occurrence_counts: &Value,
) -> LabResult<Value> {
    let work = group_work(conn, items.to_vec())?;
    let mut counts = json!({"total":work.len(),"pending":0,"verified":0,"corrected":0,"manual":0,"needs_review":0,"ambiguous":0,"error":0,"frames_completed":occurrence_counts["frames_completed"],"frames_total":occurrence_counts["frames_total"]});
    for item in work {
        let bucket = match item["state"].as_str().unwrap_or("pending") {
            "unchanged" | "legacy_verified" => "verified",
            "corrected" => "corrected",
            "manual" => "manual",
            "flagged" | "conflict" => "needs_review",
            "ambiguous" => "ambiguous",
            "error" => "error",
            _ => "pending",
        };
        counts[bucket] = json!(counts[bucket].as_u64().unwrap_or(0) + 1);
    }
    Ok(counts)
}

pub fn restore_component_claims(conn: &Connection, run: &str) -> LabResult<()> {
    conn.execute("UPDATE queue_items SET active=1 WHERE sample_key IN (SELECT c.component_key FROM gameplay_ai_cache_components c JOIN gameplay_ai_cache_aliases p ON p.sample_key=c.parent_key JOIN gameplay_ai_cache_aliases a ON a.cache_key=p.cache_key JOIN gameplay_ai_occurrences o ON o.sample_key=a.sample_key JOIN gameplay_ai_run_items r ON r.occurrence_id=o.id WHERE r.run_id=? AND o.state NOT IN ('absent','ambiguous') AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=o.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=o.id)))",[run])?;
    Ok(())
}

pub fn admit_components(
    conn: &Connection,
    parent: &str,
    image: &RgbImage,
    mask: &Value,
    original: &str,
    frame: &str,
    session: &str,
    blocked: bool,
) -> LabResult<bool> {
    let Some(panels) = mask["panels"]
        .as_array()
        .filter(|p| !p.is_empty() && p.len() <= 10)
    else {
        return Ok(false);
    };
    let mut rectangles = Vec::new();
    for panel in panels {
        let b = &panel["bounds"];
        let x = b["x"]
            .as_f64()
            .ok_or_else(|| bad("Component x is missing"))?;
        let y = b["y"]
            .as_f64()
            .ok_or_else(|| bad("Component y is missing"))?;
        let right = (x + b["width"]
            .as_f64()
            .ok_or_else(|| bad("Component width is missing"))?)
        .ceil();
        let bottom = (y + b["height"]
            .as_f64()
            .ok_or_else(|| bad("Component height is missing"))?)
        .ceil();
        let (x, y) = (x.floor(), y.floor());
        if ![x, y, right, bottom].iter().all(|n| n.is_finite())
            || x < 0.
            || y < 0.
            || right > f64::from(image.width())
            || bottom > f64::from(image.height())
            || right <= x
            || bottom <= y
        {
            return Err(bad("Component panel is outside its actual crop"));
        }
        rectangles.push([x as u32, y as u32, (right - x) as u32, (bottom - y) as u32]);
    }
    let layout = serde_json::to_string(&rectangles)?;
    let saved: Option<String> = conn
        .query_row(
            "SELECT l.layout FROM gameplay_ai_cache_component_layouts l JOIN gameplay_ai_cache_aliases a ON a.sample_key=l.parent_key WHERE a.cache_key=(SELECT cache_key FROM gameplay_ai_cache_aliases WHERE sample_key=?) ORDER BY l.parent_key LIMIT 1",
            [parent],
            |r| r.get(0),
        )
        .optional()?;
    if saved.as_ref().is_some_and(|saved| saved != &layout) {
        return Err(conflict(
            "Resolved split panel count/order changed for identical evidence",
        ));
    }
    let mut keys = component_keys(conn, parent)?;
    if keys.is_empty() {
        let original = parse_money_list(original).filter(|parts| parts.len() == rectangles.len());
        for (ordinal, [x, y, width, height]) in rectangles.iter().copied().enumerate() {
            let component = image::imageops::crop_imm(image, x, y, width, height).to_image();
            let mut raw = format!("{width}x{height}:RGB:").into_bytes();
            raw.extend_from_slice(component.as_raw());
            let pixels = sha256(&raw);
            let mut component_mask = mask.clone();
            let mut panel = panels[ordinal].clone();
            panel["bounds"]["x"] = json!(panel["bounds"]["x"].as_f64().unwrap() - f64::from(x));
            panel["bounds"]["y"] = json!(panel["bounds"]["y"].as_f64().unwrap() - f64::from(y));
            component_mask["panels"] = json!([panel]);
            let signature = normalized_enabled(conn)?
                .then(|| money_shape::extract(&component, &component_mask))
                .flatten();
            let exact = representative(conn, "money_scalar", &pixels)?;
            let old = match &signature {
                Some(signature) => normalized_representative(conn, signature, exact)?,
                None => exact,
            };
            let key = old
                .clone()
                .unwrap_or_else(|| identity("money_scalar", &pixels));
            if old.is_none() {
                let dynamic = DynamicImage::ImageRgb8(component.clone());
                let png = crate::media::png(&dynamic).map_err(bad)?;
                let prior = original
                    .as_ref()
                    .map(|parts| parts[ordinal].as_str())
                    .unwrap_or("");
                let guide = json!({"policy":"resolved_money_scalar_v1","family":"money_scalar","source":"resolved_panel_component","alignment":"center","anchor":{"x":width as f64/2.,"y":height as f64/2.},"crop_width":width,"crop_height":height,"visible_pixel_rect":{"x":0,"y":0,"width":width,"height":height}});
                conn.execute("INSERT INTO queue_items(sample_key,frame_id,source,region_id,payload,crop,pixel_sha256,phash,created_at,active,reviewed,label) VALUES(?,?,?,'bet',?,?,?,?,?,0,1,?)",params![key,frame,session,json!({"id":"bet","sample_key":key,"label":prior,"guide":guide,"crop_mask":component_mask}).to_string(),png,pixels,crate::media::dhash(&dynamic),now_ms(),prior])?;
                crate::lab::pixel_assets::attach(conn, "queue_items", &key, &png, &pixels)?;
                register(conn, &key, "money_scalar", &pixels)?;
            }
            if let Some(signature) = &signature {
                record_normalized(conn, &pixels, &key, signature)?;
            }
            keys.push(key);
        }
        for (ordinal, key) in keys.iter().enumerate() {
            conn.execute("INSERT INTO gameplay_ai_cache_components(parent_key,ordinal,component_key) VALUES(?,?,?)",params![parent,ordinal as i64,key])?;
        }
        conn.execute(
            "INSERT INTO gameplay_ai_cache_component_layouts(parent_key,layout) VALUES(?,?)",
            params![parent, layout],
        )?;
    }
    conn.execute(
        "UPDATE queue_items SET active=0 WHERE sample_key=?",
        [parent],
    )?;
    for key in keys {
        let terminal = terminal(conn, &key)?;
        conn.execute("UPDATE queue_items SET active=CASE WHEN ? THEN 0 ELSE MAX(active,?) END WHERE sample_key=?",params![terminal,i64::from(!blocked),key])?;
    }
    Ok(true)
}

pub fn project(conn: &Connection, items: &mut [Value]) -> LabResult<()> {
    if !enabled(conn)? {
        for item in items {
            if let Some(context) = context(conn, item["id"].as_str().unwrap_or(""))? {
                item["presence"] = context["presence"].clone();
                item["seat_occupancy"] = context["seat_occupancy"].clone();
                item["skip_reason"] = context["presence"]["skip_reason"].clone();
            }
            if item["_own_decision"] != true
                && !source_absent(item["region_id"].as_str().unwrap_or(""), item)
                && !automatic_support(item["region_id"].as_str().unwrap_or(""), item)
            {
                item["state"] = json!("flagged");
                item["label"] = item["original_label"].clone();
                item["reason"] = json!("Card target support requires manual review");
            }
            item.as_object_mut().unwrap().remove("_own_decision");
            item.as_object_mut().unwrap().remove("_occurrence_state");
            item["work_key"] = item["sample_key"].clone();
        }
        return Ok(());
    }
    let mut memo = HashMap::<String, Truth>::new();
    for item in items {
        let own = item.as_object_mut().unwrap().remove("_own_decision") == Some(json!(true));
        let state = item.as_object_mut().unwrap().remove("_occurrence_state");
        let id = item["id"].as_str().unwrap().to_owned();
        if let Some(context) = context(conn, &id)? {
            item["guide"] = context["guide"].clone();
            item["presence"] = context["presence"].clone();
            item["seat_occupancy"] = context["seat_occupancy"].clone();
            item["skip_reason"] = context["presence"]["skip_reason"].clone();
        }
        let key = item["sample_key"].as_str().unwrap().to_owned();
        let evidence = alias(conn, &key)?;
        item["work_key"] = json!(evidence
            .as_ref()
            .map(|(_, group)| group.clone())
            .unwrap_or_else(|| format!("unresolved:{key}")));
        if item["review_evidence"]["cache_eligible"] == false {
            item["work_key"] = json!(format!("occurrence:{id}"));
            item["crop_available"] = json!(false);
            item["crop_url"] = Value::Null;
        }
        if !own && source_absent(item["region_id"].as_str().unwrap_or(""), item) {
            item["state"] = json!("absent");
            item["crop_available"] = json!(false);
            item["crop_url"] = Value::Null;
            continue;
        }
        if !own && !automatic_support(item["region_id"].as_str().unwrap_or(""), item) {
            item["state"] = json!("flagged");
            item["label"] = item["original_label"].clone();
            item["reason"] = json!("Card target support requires manual review");
            continue;
        }
        if own || state.as_ref() == Some(&json!("ambiguous")) {
            continue;
        }
        if evidence.is_none() {
            continue;
        }
        let value = if let Some(value) = memo.get(&key) {
            value.clone()
        } else {
            let value = truth(conn, &key)?;
            memo.insert(key.into(), value.clone());
            value
        };
        match value {
            Truth::Accepted { label, human } => {
                if !human
                    && blank_contradicts_foreground(
                        item["region_id"].as_str().unwrap_or(""),
                        item,
                        &label,
                    )
                {
                    item["state"] = json!("flagged");
                    item["label"] = item["original_label"].clone();
                    item["proposed_text"] = json!(label);
                    item["reason"] = json!("Blank reading contradicts supported card foreground");
                    continue;
                }
                if !human
                    && (!item["guide"]["guideUnsupportedReason"].is_null()
                        || !item["guide"]["localization_error"].is_null())
                {
                    item["state"] = json!("flagged");
                    item["label"] = item["original_label"].clone();
                    item["proposed_text"] = json!(label);
                    item["reason"] = json!(
                        "Target localization is untrusted; automatic promotion requires audit"
                    );
                    continue;
                }
                let region = item["region_id"].as_str().unwrap();
                let category = item["category"].as_str().unwrap();
                let label = crate::labels::normalize_region_text(region, category, &label);
                if !crate::labels::validate_reviewed_label(
                    region,
                    &label,
                    if human { "manual" } else { "accepted" },
                    human,
                )
                .is_ok_and(|schema_valid| schema_valid)
                {
                    item["state"] = json!("flagged");
                    item["proposed_text"] = json!(label);
                    item["label"] = item["original_label"].clone();
                    item["reason"] = json!(
                        "Known transcript is incompatible with this occurrence's field contract"
                    );
                    continue;
                }
                let original = crate::labels::normalize_region_text(
                    region,
                    category,
                    item["original_label"].as_str().unwrap_or(""),
                );
                item["state"] = json!(if human {
                    "manual"
                } else if label == original {
                    "unchanged"
                } else {
                    "corrected"
                });
                item["label"] = json!(label);
            }
            Truth::Blocked(reason) => {
                item["state"] = json!("conflict");
                item["reason"] = json!(reason);
                item["label"] = item["original_label"].clone();
            }
            Truth::NeedsReview {
                reason,
                proposed_label,
            } => {
                item["state"] = json!("flagged");
                item["reason"] = json!(reason);
                item["label"] = item["original_label"].clone();
                item["proposed_text"] = json!(proposed_label);
            }
            Truth::Pending => {
                item["state"] = json!("pending");
                item["label"] = item["original_label"].clone();
            }
        }
    }
    Ok(())
}

pub fn propagate_revisions(
    conn: &Connection,
    key: &str,
    id: &str,
    label: &str,
    action: &str,
) -> LabResult<usize> {
    let Some((kind, group)) = alias(conn, key)? else {
        return Ok(0);
    };
    let mut groups = BTreeSet::from([group.clone()]);
    let mut scalar_groups = BTreeSet::new();
    if kind == "money_list" {
        for component in component_keys(conn, key)? {
            if let Some((_, group)) = alias(conn, &component)? {
                groups.insert(group.clone());
                scalar_groups.insert(group);
            }
        }
    } else if kind == "money_scalar" {
        scalar_groups.insert(group);
    }
    for group in scalar_groups {
        let parents=conn.prepare("SELECT DISTINCT c.parent_key FROM gameplay_ai_cache_components c JOIN gameplay_ai_cache_aliases a ON a.sample_key=c.component_key WHERE a.cache_key=?")?.query_map([&group],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for parent in parents {
            if let Some((_, group)) = alias(conn, &parent)? {
                groups.insert(group);
            }
        }
    }
    let mut affected = 0;
    for group in groups {
        let keys = conn
            .prepare("SELECT sample_key FROM gameplay_ai_cache_aliases WHERE cache_key=?")?
            .query_map([&group], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for key in keys {
            if terminal(conn, &key)? {
                conn.execute("UPDATE queue_items SET active=0 WHERE sample_key=?", [key])?;
            }
        }
        affected+=conn.execute("UPDATE gameplay_ai_occurrences SET revision=revision+1 WHERE sample_key IN (SELECT sample_key FROM gameplay_ai_cache_aliases WHERE cache_key=?) AND (id=? OR (state!='ambiguous' AND NOT EXISTS(SELECT 1 FROM gameplay_ai_decisions d WHERE d.occurrence_id=gameplay_ai_occurrences.id AND d.id=(SELECT MAX(x.id) FROM gameplay_ai_decisions x WHERE x.occurrence_id=d.occurrence_id) AND (d.label!=? OR d.state!=?))))",params![group,id,label,action])?;
    }
    Ok(affected)
}
