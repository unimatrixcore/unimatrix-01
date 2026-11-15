use poker_native::labels::{
    category_for_region, normalize_legacy_text, normalize_region_text_with_currency_format,
    validate_text, validate_text_with_currency_format,
};
use serde_json::Value;

#[test]
fn canonical_normalization_and_validation_match_shared_fixtures() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../shared/test/fixtures/poker-ocr-normalization.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let region = case["region"].as_str().unwrap();
        let category = case["category"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        assert_eq!(category_for_region(region), Some(category));
        let legacy = if case["legacyCurrencyIcons"] == true {
            normalize_legacy_text(category, input)
        } else {
            input.to_string()
        };
        let normalized = normalize_region_text_with_currency_format(
            region,
            category,
            &legacy,
            case["currencyFormat"].as_str(),
        );
        assert_eq!(
            normalized,
            case["output"].as_str().unwrap(),
            "{region}:{input}"
        );
        assert_eq!(
            validate_text(category, &normalized, false),
            case["valid"].as_bool().unwrap(),
            "{region}:{input}"
        );
    }
}

#[test]
fn native_validation_accepts_observed_source_formatter_outputs() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../shared/test/fixtures/poker-formatter-values.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let state = &case["state"];
        let output = format!("S {}", case["output"].as_str().unwrap());
        let bb = state["displayInBB"].as_bool().unwrap();
        let template = state["currencyFormat"]
            .as_str()
            .unwrap_or(if state["currency"] == "$" {
                "${0}"
            } else {
                "{0}"
            });
        let actual = validate_text_with_currency_format(
            "bet",
            &output,
            false,
            if bb { None } else { Some(template) },
        );
        assert_eq!(actual, case["value"].as_f64().unwrap() >= 0.0, "{output}");
    }
}

#[test]
fn contextual_cash_validation_matches_shared_fixtures() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../shared/test/fixtures/poker-ocr-context-values.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let category = case["category"].as_str().unwrap();
        let value = case["value"].as_str().unwrap();
        assert_eq!(
            validate_text_with_currency_format(
                category,
                value,
                false,
                case["currencyFormat"].as_str()
            ),
            case["valid"].as_bool().unwrap(),
            "{category}:{value}"
        );
    }
    assert!(!validate_text_with_currency_format(
        "unknown",
        "",
        true,
        Some("{0}")
    ));
    assert!(validate_text_with_currency_format(
        "bank",
        "",
        true,
        Some("{0}")
    ));
}
