use regex::Regex;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
struct Category {
    pattern: Option<String>,
    values: Option<Vec<String>>,
}
#[derive(Deserialize)]
struct Rule {
    category: String,
    pattern: String,
}
#[derive(Deserialize)]
struct Contract {
    version: u32,
    categories: BTreeMap<String, Category>,
    region_rules: Vec<Rule>,
}
struct CompiledContract {
    value: Contract,
    regions: Vec<(String, Regex)>,
    patterns: BTreeMap<String, Regex>,
}
static CONTRACT: OnceLock<CompiledContract> = OnceLock::new();
pub const CONTRACT_BYTES: &[u8] = include_bytes!("../../poker/ocr-contract.json");
fn contract() -> &'static CompiledContract {
    CONTRACT.get_or_init(|| {
        let value: Contract =
            serde_json::from_slice(CONTRACT_BYTES).expect("canonical OCR contract JSON");
        let regions = value
            .region_rules
            .iter()
            .map(|rule| {
                (
                    rule.category.clone(),
                    Regex::new(&format!(r"\A(?:{})\z", rule.pattern))
                        .expect("canonical region rule"),
                )
            })
            .collect();
        let patterns = value
            .categories
            .iter()
            .filter_map(|(category, rule)| {
                rule.pattern.as_ref().map(|pattern| {
                    (
                        category.clone(),
                        Regex::new(&format!(r"\A(?:{pattern})\z")).expect("canonical text rule"),
                    )
                })
            })
            .collect();
        CompiledContract {
            value,
            regions,
            patterns,
        }
    })
}
pub fn contract_version() -> u32 {
    contract().value.version
}
pub fn category_for_region(region: &str) -> Option<&'static str> {
    contract()
        .regions
        .iter()
        .find(|(_, pattern)| pattern.is_match(region))
        .map(|(category, _)| category.as_str())
}
pub fn validate_text(category: &str, label: &str, allow_blank: bool) -> bool {
    let Some(rule) = contract().value.categories.get(category) else {
        return false;
    };
    if label.is_empty() && allow_blank {
        return true;
    }
    if let Some(values) = &rule.values {
        return values.iter().any(|value| value == label);
    }
    contract()
        .patterns
        .get(category)
        .is_some_and(|pattern| pattern.is_match(label))
}
pub fn validate_label(region: &str, label: &str) -> Result<(), String> {
    let category =
        category_for_region(region).ok_or_else(|| format!("Unsupported OCR region: {region:?}"))?;
    if !validate_text(category, label, true) {
        return Err(format!("Invalid {category} format: {label:?}"));
    }
    Ok(())
}
pub fn validate_reviewed_label(
    region: &str,
    label: &str,
    action: &str,
    allow_outside_contract: bool,
) -> Result<bool, String> {
    if !["accepted", "corrected", "manual"].contains(&action) {
        return Err("action must be accepted, corrected, or manual".into());
    }
    if allow_outside_contract && action == "accepted" {
        return Err("Automatic acceptance cannot override the validation contract".into());
    }
    let category =
        category_for_region(region).ok_or_else(|| format!("Unsupported OCR region: {region:?}"))?;
    let valid = validate_text(category, label, true);
    if valid {
        return Ok(true);
    }
    let outside_status = category == "status"
        && (1..=64).contains(&label.chars().count())
        && label
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '-')
        && label.chars().any(|c| c.is_ascii_alphabetic());
    if allow_outside_contract && outside_status {
        return Ok(false);
    }
    validate_label(region, label)?;
    Ok(valid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_contract_supports_modern_values_and_full_region_ids() {
        for (region, label) in [
            ("seat.0.name", "Player 1"),
            ("seats[1].bank", "G No Chips"),
            ("bank", "S No Chips"),
            ("seat.0.status", "Fold"),
            ("status", "Hide Cards"),
            ("community.card_1", "A"),
            ("seats[0].cards[1]", "10"),
        ] {
            validate_label(region, label).unwrap();
        }
        for region in [
            "unrelated.name.suffix",
            "nameplate",
            "potato",
            "community_garbage",
            "unknown",
        ] {
            assert_eq!(category_for_region(region), None);
            assert!(validate_label(region, "").is_err());
        }
        assert_eq!(
            validate_reviewed_label("status", "Waiting For Players", "manual", true),
            Ok(false)
        );
        assert!(validate_reviewed_label("status", "Waiting For Players", "manual", false).is_err());
        assert!(
            validate_reviewed_label("status", "Waiting For Players", "accepted", true).is_err()
        );
        assert!(validate_reviewed_label("name", "Bad Name", "manual", true).is_err());
    }
}
