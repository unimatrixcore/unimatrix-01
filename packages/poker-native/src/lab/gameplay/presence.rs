use image::{DynamicImage, RgbImage};
use serde_json::{json, Value};
pub const POLICY: &str = "source_pixel_presence_autocrop_only_v3";
fn decision(state: &str, reason: &str) -> Value {
    json!({"state":state,"reason":reason,"policy":POLICY})
}
fn statistics(
    image: &RgbImage,
    mask: Option<&image::GrayImage>,
) -> ([u8; 3], usize, usize, usize, usize) {
    let mut modes = std::collections::BTreeMap::<[u8; 3], usize>::new();
    for (x, y, p) in image.enumerate_pixels() {
        if mask.is_some_and(|m| m.get_pixel(x, y)[0] != 255) {
            continue;
        }
        *modes.entry(p.0.map(|v| v / 8 * 8)).or_default() += 1;
    }
    let bg = modes
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(p, _)| p)
        .unwrap_or([0; 3]);
    let baseline = bg.iter().map(|v| i32::from(*v)).sum::<i32>() / 3;
    let (mut strong, mut faint, mut uniform) = (0, 0, 0);
    let mut area = 0;
    for (x, y, p) in image.enumerate_pixels() {
        if mask.is_some_and(|m| m.get_pixel(x, y)[0] != 255) {
            continue;
        }
        area += 1;
        let lo = *p.0.iter().min().unwrap();
        let hi = *p.0.iter().max().unwrap();
        let luma = p.0.iter().map(|v| i32::from(*v)).sum::<i32>() / 3;
        let delta = (luma - baseline).abs();
        if p.0
            .iter()
            .zip(bg)
            .all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= 9)
        {
            uniform += 1;
        }
        if hi - lo <= 70
            && delta > 18
            && !p
                .0
                .iter()
                .zip(bg)
                .all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= 7)
        {
            strong += 1;
        }
        if hi - lo <= 85
            && delta > 5
            && !p
                .0
                .iter()
                .zip(bg)
                .all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= 7)
        {
            faint += 1;
        }
    }
    (bg, strong, faint, uniform, area)
}
pub fn assess(image: &DynamicImage, region: &Value) -> Value {
    if super::regions::seat_is_empty(region) {
        return json!({"state":"absent","reason":"Proven unoccupied source seat","policy":"source_free_seat_occupancy_v1","seat_occupancy":region["seat_occupancy"]});
    }
    if region["ocr"] == false {
        return decision("visual_indicator", "Non-OCR CV context");
    }
    if region["card_prior_id"].is_string()
        || region["category"] == "card"
        || region["category"] == "suit"
    {
        let mut evidence = decision(
            "present",
            "Card targets are OCR-driven, including backs, avatars and weak-pose nominal crops",
        );
        evidence["target_support"] = region["card_target_evidence"]["target_support"]
            .as_str()
            .unwrap_or(if region["card_prior_id"].is_string() {
                "unsupported"
            } else {
                "unverified"
            })
            .into();
        evidence["card_evidence"] = region["card_target_evidence"].clone();
        return evidence;
    }
    if let Some(reason) = region["localization_error"].as_str() {
        return decision("ambiguous", reason);
    }
    if region["guide"]["occlusion"]["partial"] == true {
        return decision("ambiguous", "Source paint order occludes target text; visible pixels do not establish the complete amount");
    }
    if region["localization"]["state"] == "original_negative_slot" {
        return decision(
            "absent",
            "No supported target panel occupies its source slot",
        );
    }
    let crop = match super::regions::crop_pixels(image, region) {
        Ok(v) => v.to_rgb8(),
        Err(_) => return decision("ambiguous", "Target pixels cannot be isolated"),
    };
    if region["localizer"].is_null() && region["localization"].is_null() {
        return decision("present", "Fixed source field is OCR-driven");
    }
    let mask =
        serde_json::from_value::<super::crop_mask::MaskDescriptor>(region["crop_mask"].clone())
            .ok()
            .and_then(|d| super::crop_mask::apply(&crop, &d).ok())
            .map(|masked| masked.valid_mask);
    let (_bg, strong, faint, uniform, area) = statistics(&crop, mask.as_ref());
    if strong >= 4 {
        return decision(
            "present",
            "Visible foreground occupies the resolved source field",
        );
    }
    if faint >= 4 {
        return decision("ambiguous", "Faint target-like foreground is visible");
    }
    if area > 0 && uniform == area {
        return decision("absent", "Source slot contains only its uniform background");
    }
    decision("ambiguous", "Target presence is not established")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    fn region() -> Value {
        json!({"id":"seats[0].name","ocr":true,"localization":{"kind":"text_line"},"bounds":{"x":0,"y":0,"width":40,"height":20},"polygon":[{"x":0,"y":0},{"x":40,"y":0},{"x":40,"y":20},{"x":0,"y":20}]})
    }
    #[test]
    fn fixed_fields_reach_ocr_but_invalid_or_auto_fields_still_fail_closed() {
        let mut noisy = RgbImage::from_pixel(40, 20, Rgb([25, 42, 53]));
        noisy.put_pixel(10, 10, Rgb([30, 35, 45]));
        let image = DynamicImage::ImageRgb8(noisy);
        let mut fixed = region();
        fixed.as_object_mut().unwrap().remove("localization");
        assert_eq!(assess(&image, &fixed)["state"], "present");
        let mut auto = fixed.clone();
        auto["localization"] = json!({"kind":"text_line"});
        assert_ne!(assess(&image, &auto)["state"], "present");
        fixed["localization_error"] = json!("Failed to localize");
        assert_eq!(assess(&image, &fixed)["state"], "ambiguous");
        fixed.as_object_mut().unwrap().remove("localization_error");
        fixed["bounds"]["x"] = json!(1000);
        fixed["polygon"] =
            json!([{"x":1000,"y":0},{"x":1040,"y":0},{"x":1040,"y":20},{"x":1000,"y":20}]);
        assert_eq!(assess(&image, &fixed)["state"], "ambiguous");
    }
    #[test]
    fn empty_surface_is_absent_but_faint_or_occluded_is_not_blank() {
        assert_eq!(
            assess(
                &DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([30, 40, 20]))),
                &region()
            )["state"],
            "absent"
        );
        let empty = DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([25, 42, 53])));
        assert_eq!(assess(&empty, &region())["state"], "absent");
        let mut faint = empty.to_rgb8();
        for x in 10..18 {
            faint.put_pixel(x, 10, Rgb([58, 58, 58]));
        }
        assert_ne!(
            assess(&DynamicImage::ImageRgb8(faint), &region())["state"],
            "absent"
        );
        let mut r = region();
        r["localization_error"] = json!("Occluded");
        assert_eq!(assess(&empty, &r)["state"], "ambiguous");
    }
    #[test]
    fn noncard_negative_skips_but_cards_always_reach_ocr() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([25, 42, 53])));
        let mut r = region();
        r["localization"] = json!({"state":"original_negative_slot"});
        assert_eq!(assess(&image, &r)["state"], "absent");
        r = region();
        r["card_prior_id"] = json!("seats[0].cards[0]");
        let mut avatar = image.to_rgb8();
        avatar.put_pixel(5, 5, Rgb([200, 100, 70]));
        assert_eq!(
            assess(&DynamicImage::ImageRgb8(avatar), &r)["state"],
            "present"
        );
        r["card_sampling"] = json!({"glyph_fit":"source_seeded_foreground"});
        assert_eq!(assess(&image, &r)["state"], "present");
        for support in ["unsupported", "ambiguous", "supported"] {
            r["card_target_evidence"] =
                json!({"target_support":support,"semantic_verification":false});
            let evidence = assess(&image, &r);
            assert_eq!(evidence["state"], "present");
            assert_eq!(evidence["target_support"], support);
            assert_eq!(evidence["card_evidence"]["semantic_verification"], false);
        }
    }
    #[test]
    fn rounded_cutout_padding_does_not_turn_an_empty_source_panel_into_work() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(40, 20, Rgb([25, 42, 53])));
        let mut r = region();
        r["crop_mask"] = serde_json::to_value(
            super::super::crop_mask::from_resolved_panels(
                super::super::crop_mask::SourcePanel::ChipColumnsValue,
                [0., 0.],
                &[super::super::crop_mask::Rect {
                    x: 0.,
                    y: 0.,
                    width: 40.,
                    height: 20.,
                }],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(assess(&image, &r)["state"], "absent");
    }
    #[test]
    fn source_dark_status_text_is_present() {
        let mut image = RgbImage::from_pixel(40, 20, Rgb([255, 157, 0]));
        for x in 8..20 {
            image.put_pixel(x, 10, Rgb([15, 15, 15]));
        }
        assert_eq!(
            assess(&DynamicImage::ImageRgb8(image), &region())["state"],
            "present"
        );
    }
}
