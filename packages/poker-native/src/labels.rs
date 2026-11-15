use regex::Regex;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
struct Category {
    pattern: Option<String>,
    values: Option<Vec<String>>,
    values_exhaustive: Option<bool>,
    max_utf16: Option<usize>,
    prefix_max_utf16: Option<usize>,
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
    normalization: Option<Normalization>,
    format: Format,
}
#[derive(Deserialize)]
struct Format {
    number_pattern: String,
    short_cash_categories: Vec<String>,
}
#[derive(Deserialize)]
struct Normalization {
    suit_aliases: BTreeMap<String, String>,
    rank_aliases: BTreeMap<String, String>,
    amount_tokens: String,
    pause_tokens: String,
}
struct CompiledContract {
    value: Contract,
    regions: Vec<(String, Regex)>,
    patterns: BTreeMap<String, Regex>,
    money_tokens: Regex,
    pause_tokens: Regex,
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
        let normalization = value
            .normalization
            .as_ref()
            .expect("normalization metadata");
        let money_tokens =
            Regex::new(&format!("(?i){}", normalization.amount_tokens)).expect("amount tokens");
        let pause_tokens =
            Regex::new(&format!(r"(?i)\A{}\z", normalization.pause_tokens)).expect("pause tokens");
        CompiledContract {
            money_tokens,
            pause_tokens,
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
pub fn normalize_text(category: &str, text: &str) -> String {
    let value = text.trim();
    let aliases = contract().value.normalization.as_ref();
    match category {
        "suit" => {
            let glyph = value.replace(['\u{fe0e}', '\u{fe0f}'], "");
            aliases
                .and_then(|a| a.suit_aliases.get(&glyph))
                .cloned()
                .unwrap_or_else(|| glyph.to_lowercase())
        }
        "card" => {
            let rank = value.to_uppercase();
            aliases
                .and_then(|a| a.rank_aliases.get(&rank))
                .cloned()
                .unwrap_or(rank)
        }
        "dealer" => value.to_uppercase(),
        "name" => value.replace('…', "..."),
        "status" => {
            let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
            contract()
                .value
                .categories
                .get("status")
                .and_then(|r| r.values.as_ref())
                .and_then(|values| values.iter().find(|v| v.eq_ignore_ascii_case(&collapsed)))
                .cloned()
                .unwrap_or_else(|| value.to_string())
        }
        "winner" | "popup" | "combination" | "round_id" => value.to_string(),
        _ => normalize_money(category, value),
    }
}
fn normalize_money(category: &str, value: &str) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if category == "table_info" {
        return value;
    }
    let compact = value.split_whitespace().collect::<String>();
    if category == "pot" {
        if let Some(c) = contract().pause_tokens.captures(&compact) {
            return format!("Run It Twice pause ({} sec)", &c[1]);
        }
    }
    if category == "bank" && compact.eq_ignore_ascii_case("All-In") {
        return "All-In".into();
    }
    let (prefix, body) = if category == "pot"
        && compact
            .get(..4)
            .is_some_and(|v| v.eq_ignore_ascii_case("Pot:"))
    {
        ("Pot: ", &compact[4..])
    } else {
        ("", compact.as_str())
    };
    let captures = contract()
        .money_tokens
        .captures_iter(body)
        .collect::<Vec<_>>();
    if !captures.is_empty() && captures.iter().map(|c| &c[0]).collect::<String>() == body {
        let parts = captures
            .iter()
            .map(|c| {
                let number = c[2].to_uppercase();
                let formatted = if number == "NOCHIPS" {
                    "No Chips".into()
                } else if let Some(n) = number.strip_suffix("BB") {
                    format!("{n} BB")
                } else {
                    number
                };
                format!("{} {}", c[1].to_uppercase(), formatted)
            })
            .collect::<Vec<_>>()
            .join(" ");
        let formatted = format!("{prefix}{parts}");
        if validate_text(category, &formatted, false) {
            return formatted;
        }
    }
    value
}
pub fn normalize_region_text(region_id: &str, category: &str, text: &str) -> String {
    normalize_region_text_with_currency_format(region_id, category, text, None)
}

pub fn normalize_region_text_with_currency_format(
    region_id: &str,
    category: &str,
    text: &str,
    currency_format: Option<&str>,
) -> String {
    if currency_format.is_some()
        && ["bank", "bet", "pot", "split_pot", "amount", "table_info"].contains(&category)
    {
        return text.trim().to_string();
    }
    let _ = region_id;
    normalize_text(category, text)
}

pub fn normalize_legacy_text(category: &str, text: &str) -> String {
    normalize_text(category, text)
}

pub fn validate_text(category: &str, label: &str, allow_blank: bool) -> bool {
    let Some(rule) = contract().value.categories.get(category) else {
        return false;
    };
    if label.is_empty() && allow_blank {
        return true;
    }
    if rule
        .max_utf16
        .is_some_and(|max| label.encode_utf16().count() > max)
    {
        return false;
    }
    if rule.prefix_max_utf16.is_some_and(|max| {
        label
            .rsplit_once(", NLHE")
            .is_some_and(|(prefix, _)| prefix.encode_utf16().count() > max)
    }) {
        return false;
    }
    if rule.values_exhaustive != Some(false) {
        if let Some(values) = &rule.values {
            return values.iter().any(|value| value == label);
        }
    }
    contract()
        .patterns
        .get(category)
        .is_some_and(|pattern| pattern.is_match(label))
}
fn currency_pattern(template: &str, number: &str, name: &str) -> (String, Vec<String>) {
    let mut tokens = ["{0}", "{value}"]
        .iter()
        .filter_map(|token| template.find(token).map(|i| (i, *token)))
        .collect::<Vec<_>>();
    tokens.sort_by_key(|(i, _)| *i);
    let mut pattern = String::new();
    let mut names = Vec::new();
    let mut offset = 0;
    for (index, (at, token)) in tokens.iter().enumerate() {
        pattern.push_str(&regex::escape(&template[offset..*at]));
        let capture = format!("{name}{index}");
        pattern.push_str(&format!("(?P<{capture}>{number})"));
        names.push(capture);
        offset = at + token.len();
    }
    pattern.push_str(&regex::escape(&template[offset..]));
    (pattern, names)
}
fn currency_template_matches(template: &str, rendered: &str, number: &str) -> bool {
    let mut tokens = ["{0}", "{value}"]
        .iter()
        .filter_map(|token| template.find(token).map(|i| (i, *token)))
        .collect::<Vec<_>>();
    tokens.sort_by_key(|(i, _)| *i);
    if tokens.is_empty() {
        return rendered == template;
    }
    let literal_len = template.len() - tokens.iter().map(|(_, token)| token.len()).sum::<usize>();
    let Some(values_len) = rendered.len().checked_sub(literal_len) else {
        return false;
    };
    if values_len % tokens.len() != 0 {
        return false;
    }
    let start = tokens[0].0;
    let Some(value) = rendered.get(start..start + values_len / tokens.len()) else {
        return false;
    };
    let Ok(pattern) = Regex::new(&format!(r"\A(?:{number})\z")) else {
        return false;
    };
    pattern.is_match(value)
        && template
            .replacen("{0}", value, 1)
            .replacen("{value}", value, 1)
            == rendered
}
fn cash_item_matches(template: &str, rendered: &str, number: &str) -> bool {
    let Some(value) = rendered
        .strip_prefix("S ")
        .or_else(|| rendered.strip_prefix("G "))
    else {
        return false;
    };
    currency_template_matches(template, value, number)
}
/// A supplied currency template is explicit cash context, never inferred from OCR text.
pub fn validate_text_with_currency_format(
    category: &str,
    label: &str,
    allow_blank: bool,
    currency_format: Option<&str>,
) -> bool {
    let Some(template) = currency_format else {
        return validate_text(category, label, allow_blank);
    };
    if !contract().value.categories.contains_key(category) {
        return false;
    }
    if label.is_empty() && allow_blank {
        return true;
    }
    if !["bank", "bet", "pot", "split_pot", "amount", "table_info"].contains(&category) {
        return validate_text(category, label, allow_blank);
    }
    let suffix = if contract()
        .value
        .format
        .short_cash_categories
        .iter()
        .any(|c| c == category)
    {
        "[KMBTQP]?"
    } else {
        ""
    };
    let number = format!("{}{}", contract().value.format.number_pattern, suffix);
    let (item, _) = currency_pattern(template, &number, "amount");
    if category == "split_pot" {
        let Ok(pattern) = Regex::new(&format!(r"\A[GS] {item}")) else {
            return false;
        };
        let mut remaining = label;
        let mut count = 0;
        while let Some(captures) = pattern.captures(remaining) {
            let matched = captures.get(0).unwrap();
            if !cash_item_matches(template, matched.as_str(), &number) {
                return false;
            }
            remaining = &remaining[matched.end()..];
            count += 1;
            if remaining.is_empty() {
                return true;
            }
            let trimmed = remaining.trim_start();
            if trimmed.len() == remaining.len() {
                return false;
            }
            remaining = trimmed;
        }
        return count > 0 && remaining.is_empty();
    }
    if category == "table_info" {
        let Some((table, blinds)) = label.rsplit_once(", NLHE - ") else {
            return false;
        };
        if table.trim().is_empty() || table.contains(['\r', '\n']) {
            return false;
        }
        let Some(blinds) = blinds
            .strip_prefix("S ")
            .or_else(|| blinds.strip_prefix("G "))
        else {
            return false;
        };
        let Some((separator, _)) = blinds.match_indices('/').nth(template.matches('/').count())
        else {
            return false;
        };
        return currency_template_matches(template, &blinds[..separator], &number)
            && currency_template_matches(template, &blinds[separator + 1..], &number);
    }
    if category == "bank" && ["All-In", "S No Chips", "G No Chips"].contains(&label) {
        return true;
    }
    if category == "pot" {
        if label.starts_with("Run It Twice pause (") && validate_text(category, label, false) {
            return true;
        }
        return label
            .strip_prefix("Pot: ")
            .is_some_and(|value| cash_item_matches(template, value, &number));
    }
    let label = if category == "amount" {
        label.strip_prefix('+').unwrap_or(label)
    } else {
        label
    };
    cash_item_matches(template, label, &number)
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
            ("seats[1].bank", "S No Chips"),
            ("bank", "G No Chips"),
            ("seat.0.status", "Fold"),
            ("status", "Hide Cards"),
            ("seat.0.status", "Away"),
            ("community.card_1", "A"),
            ("seats[0].cards[1]", "10"),
        ] {
            validate_label(region, label).unwrap();
        }
        for legacy in ["G No Chips", "S No Chips"] {
            assert!(validate_label("bank", legacy).is_ok());
            assert_eq!(normalize_legacy_text("bank", legacy), legacy);
            validate_label("bank", &normalize_legacy_text("bank", legacy)).unwrap();
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
        assert_eq!(
            validate_reviewed_label("name", "Bad Name", "manual", true),
            Ok(true)
        );
        assert!(validate_reviewed_label("bet", "garbage", "manual", true).is_err());
    }
}
