use super::{card_crop as plane, card_glyph};
use crate::lab::{bad, LabResult};
use image::{DynamicImage, RgbImage};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub type Poses = BTreeMap<String, plane::CardResolution>;
pub const TARGET_EVIDENCE_POLICY: &str = "source_card_plane_component_support_v1";

fn target_evidence(
    out: &mut Value,
    resolution: &plane::CardResolution,
    fit: Option<&card_glyph::GlyphFit>,
    surface: &Value,
) {
    let (support, reason) = match resolution {
        plane::CardResolution::Fallback { reason } => ("unsupported", reason.as_str()),
        plane::CardResolution::Pose { .. } => match fit {
            None => ("ambiguous", "Foreground components could not be isolated inside the source glyph support"),
            Some(fit) if surface["uniform"] != true && fit.boundary_contact.iter().any(|touches| *touches) =>
                ("ambiguous", "Selected foreground reaches the source glyph sampling boundary; clipping or overlapping artwork is unresolved"),
            Some(_) => ("supported", "Measured card edges with source face and foreground support; transcription requires verification"),
        },
    };
    out["card_target_evidence"] = json!({
        "policy": TARGET_EVIDENCE_POLICY,
        "target_support": support,
        "reason": reason,
        "ocr_admission": "always",
        "semantic_verification": false,
        "plane_state": if matches!(resolution, plane::CardResolution::Pose { .. }) { "pose" } else { "fallback" },
        "boundary_contact": fit.map(|fit| fit.boundary_contact),
        "surface": surface,
    });
    if support != "supported" {
        out["guideUnsupportedReason"] = json!(reason);
    }
}

fn surface_evidence(frame: &RgbImage, pose: &plane::CardPose) -> Value {
    let right = pose.rank.x + pose.rank.width;
    let u = right + (1. - right) / 4.;
    let height = (pose.quad[3].x - pose.quad[0].x).hypot(pose.quad[3].y - pose.quad[0].y);
    let samples = (height * pose.rank.height / 2.).ceil() as usize;
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for row in 0..=samples {
        let v = pose.rank.y + pose.rank.height / 2. * row as f64 / samples.max(1) as f64;
        let p = point(
            &[
                pose.quad[1].x - pose.quad[0].x,
                pose.quad[3].x - pose.quad[0].x,
                pose.quad[0].x,
                pose.quad[1].y - pose.quad[0].y,
                pose.quad[3].y - pose.quad[0].y,
                pose.quad[0].y,
            ],
            u,
            v,
        );
        if p.x < 0. || p.y < 0. || p.x >= frame.width() as f64 || p.y >= frame.height() as f64 {
            return json!({"uniform":false,"reason":"Source face reference is clipped"});
        }
        let rgb = frame.get_pixel(p.x as u32, p.y as u32).0;
        for c in 0..3 {
            lo[c] = lo[c].min(rgb[c]);
            hi[c] = hi[c].max(rgb[c]);
        }
    }
    let span = (0..3).map(|c| hi[c] - lo[c]).max().unwrap_or(0);
    json!({"uniform": f64::from(span) <= card_glyph::FOREGROUND_DELTA,
        "channel_span":span,"samples":samples+1,"local_u":u,
        "local_v_start":pose.rank.y,"local_v_end":pose.rank.y+pose.rank.height/2.,
        "source":"flat deck face beyond the rank union; source palette does not establish card presence"})
}
pub fn poses(frame: &RgbImage, profile: &Value) -> LabResult<Poses> {
    let mut result = BTreeMap::new();
    if let Some(priors) = profile["card_priors"].as_object() {
        for (id, value) in priors {
            let prior: plane::CardPrior = serde_json::from_value(value.clone())?;
            let mut resolved = plane::resolve_pose(frame, &prior).map_err(bad)?;
            if id.starts_with("community_cards[")
                && (prior.quad[1].y - prior.quad[0].y).abs() < 1e-8
                && (prior.quad[3].x - prior.quad[0].x).abs() < 1e-8
            {
                if let plane::CardResolution::Pose { pose } = &mut resolved {
                    pose.quad = prior.quad;
                    pose.adjusted = false;
                    pose.applied_angle_degrees = 0.;
                }
            }
            result.insert(id.clone(), resolved);
        }
    }
    Ok(result)
}
fn point(transform: &[f64; 6], x: f64, y: f64) -> plane::Point {
    plane::Point {
        x: transform[0] * x + transform[1] * y + transform[2],
        y: transform[3] * x + transform[4] * y + transform[5],
    }
}
fn field(region: &Value) -> plane::Field {
    if region["card_field"] == "suit" {
        plane::Field::Suit
    } else {
        plane::Field::Rank
    }
}
// Rank strokes may descend below their nominal box. Sample through the suit
// support so component isolation can retain the entire stroke before deciding
// which pixels belong to the neighboring suit.
fn sample_field(
    frame: &RgbImage,
    pose: &plane::CardPose,
    field: plane::Field,
) -> Result<plane::RectifiedCrop, String> {
    let mut sampling_pose = pose.clone();
    if matches!(field, plane::Field::Rank) && dark_ink_on_light_card(card_background(frame, pose)) {
        sampling_pose.rank.height =
            (pose.suit.y + pose.suit.height).max(pose.rank.y + pose.rank.height) - pose.rank.y;
    }
    plane::sample_field(frame, &sampling_pose, field, 0.)
}
fn dark_ink_on_light_card(background: Option<[u8; 3]>) -> bool {
    background.is_some_and(|bg| {
        let spread = bg.iter().max().unwrap() - bg.iter().min().unwrap();
        let mean = bg.iter().map(|v| f64::from(*v)).sum::<f64>() / 3.;
        spread <= 40 && mean >= 90.
    })
}
fn card_background(frame: &RgbImage, pose: &plane::CardPose) -> Option<[u8; 3]> {
    let rank_right = pose.rank.x + pose.rank.width;
    let u = rank_right + (1. - rank_right) / 4.;
    let v = pose.rank.y + pose.rank.height / 4.;
    let x = pose.quad[0].x
        + (pose.quad[1].x - pose.quad[0].x) * u
        + (pose.quad[3].x - pose.quad[0].x) * v;
    let y = pose.quad[0].y
        + (pose.quad[1].y - pose.quad[0].y) * u
        + (pose.quad[3].y - pose.quad[0].y) * v;
    if x >= 0. && y >= 0. && x < frame.width() as f64 && y < frame.height() as f64 {
        Some(frame.get_pixel(x as u32, y as u32).0)
    } else {
        None
    }
}
fn seed_row(pose: &plane::CardPose, sampled: &plane::RectifiedCrop, rank: bool) -> f64 {
    let local_y = if rank {
        pose.suit.y
    } else {
        pose.rank.y + pose.rank.height
    };
    let u = plane::Point {
        x: pose.quad[1].x - pose.quad[0].x,
        y: pose.quad[1].y - pose.quad[0].y,
    };
    let v = plane::Point {
        x: pose.quad[3].x - pose.quad[0].x,
        y: pose.quad[3].y - pose.quad[0].y,
    };
    let world = plane::Point {
        x: pose.quad[0].x + u.x * pose.rank.x + v.x * local_y,
        y: pose.quad[0].y + u.y * pose.rank.x + v.y * local_y,
    };
    let t = sampled.pixel_to_frame;
    let determinant = t[0] * t[4] - t[1] * t[3];
    ((world.y - t[5]) * t[0] - (world.x - t[2]) * t[3]) / determinant
}
fn fit_field(
    frame: &RgbImage,
    pose: &plane::CardPose,
    sampled: &plane::RectifiedCrop,
    rank: bool,
    background: Option<[u8; 3]>,
) -> Option<card_glyph::GlyphFit> {
    let mut seed = seed_row(pose, sampled, rank);
    if !rank {
        let other = sample_field(frame, pose, plane::Field::Rank).ok()?;
        if let Some(ink) = card_glyph::components(
            &other.rgb,
            seed_row(pose, &other, true),
            true,
            "auto",
            background,
        ) {
            let bottom = point(
                &other.pixel_to_frame,
                0.,
                f64::from(ink.bounds.y + ink.bounds.height),
            );
            let t = sampled.pixel_to_frame;
            let d = t[0] * t[4] - t[1] * t[3];
            let row = ((bottom.y - t[5]) * t[0] - (bottom.x - t[2]) * t[3]) / d;
            seed = seed.max(row);
        }
    }
    card_glyph::components(&sampled.rgb, seed, rank, "auto", background)
}
pub fn resolve(
    frame: &RgbImage,
    profile: &Value,
    region: &Value,
    poses: &Poses,
) -> LabResult<Value> {
    let Some(id) = region["card_prior_id"].as_str() else {
        return Ok(region.clone());
    };
    let Some(resolution) = poses.get(id) else {
        return Ok(region.clone());
    };
    let mut out = region.clone();
    out["card_plane"] = serde_json::to_value(resolution)?;
    let nominal;
    let pose = if let plane::CardResolution::Pose { pose } = resolution {
        pose
    } else {
        let p: plane::CardPrior = serde_json::from_value(profile["card_priors"][id].clone())?;
        let angle = (p.quad[1].y - p.quad[0].y)
            .atan2(p.quad[1].x - p.quad[0].x)
            .to_degrees();
        nominal = plane::CardPose {
            policy: plane::POLICY.into(),
            prior_quad: p.quad,
            quad: p.quad,
            rank: p.rank,
            suit: p.suit,
            prior_angle_degrees: angle,
            measured_angle_degrees: angle,
            applied_angle_degrees: angle,
            adjusted: false,
            top_edge: None,
            left_edge: None,
        };
        &nominal
    };
    let sampled = sample_field(frame, pose, field(region)).map_err(bad)?;
    let rank = region["card_field"] != "suit";
    let background = card_background(frame, pose);
    let ink = fit_field(frame, pose, &sampled, rank, background);
    target_evidence(
        &mut out,
        resolution,
        ink.as_ref(),
        &surface_evidence(frame, pose),
    );
    let Some(fit) = ink.as_ref() else {
        out["card_nominal_fallback_reason"] =
            json!("Glyph components could not be isolated; preserve the nominal OCR target");
        return Ok(out);
    };
    let b = fit.bounds;
    let (x, y, w, h) = (b.x, b.y, b.width, b.height);
    let polygon = [
        point(&sampled.pixel_to_frame, f64::from(x), f64::from(y)),
        point(&sampled.pixel_to_frame, f64::from(x + w), f64::from(y)),
        point(&sampled.pixel_to_frame, f64::from(x + w), f64::from(y + h)),
        point(&sampled.pixel_to_frame, f64::from(x), f64::from(y + h)),
    ];
    let left = polygon.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let top = polygon.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let right = polygon
        .iter()
        .map(|p| p.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = polygon
        .iter()
        .map(|p| p.y)
        .fold(f64::NEG_INFINITY, f64::max);
    let bounds = json!({"x":left,"y":top,"width":right-left,"height":bottom-top});
    out["card_sampling"] = json!({"policy":plane::POLICY,"glyph_policy":card_glyph::POLICY,"pose_source":if matches!(resolution,plane::CardResolution::Pose{..}){"edge_measured"}else{"source_nominal_fallback"},"component_mask":ink,"pose":pose,"field":region["card_field"],"margin_px":0.,"ink_bounds":{"x":x,"y":y,"width":w,"height":h},"glyph_fit":if ink.is_some(){"source_seeded_foreground"}else{"unresolved"},"pixel_to_frame":sampled.pixel_to_frame,"exact_axis_aligned":sampled.exact_axis_aligned});
    out["bounds"] = bounds.clone();
    out["polygon"] = serde_json::to_value(polygon)?;
    out["rotation"] = json!(pose.applied_angle_degrees);
    out["guide"] = json!({"slot":bounds,"anchor":{"x":polygon.iter().map(|p|p.x).sum::<f64>()/4.,"y":polygon.iter().map(|p|p.y).sum::<f64>()/4.},"alignment":"center","family":region["guide"]["family"],"source":"pixel_panel"});
    Ok(out)
}
pub fn sample(frame: &RgbImage, region: &Value) -> LabResult<Option<DynamicImage>> {
    if region["card_sampling"].is_null() {
        return Ok(None);
    }
    let pose: plane::CardPose = serde_json::from_value(region["card_sampling"]["pose"].clone())?;
    let sampled = sample_field(frame, &pose, field(region)).map_err(bad)?;
    let b: &Value = &region["card_sampling"]["ink_bounds"];
    let (x, y, w, h) = (
        b["x"].as_u64().ok_or_else(|| bad("Invalid glyph bounds"))? as u32,
        b["y"].as_u64().unwrap_or(0) as u32,
        b["width"].as_u64().unwrap_or(0) as u32,
        b["height"].as_u64().unwrap_or(0) as u32,
    );
    if w == 0 || h == 0 || x + w > sampled.rgb.width() || y + h > sampled.rgb.height() {
        return Err(bad("Glyph bounds exceed sampled card plane"));
    }
    let mut image = image::imageops::crop_imm(&sampled.rgb, x, y, w, h).to_image();
    if let Some(mask) = region["card_sampling"]
        .get("component_mask")
        .filter(|v| !v.is_null())
    {
        let mask: card_glyph::GlyphFit = serde_json::from_value(mask.clone())?;
        for [xx, yy] in mask.erase_pixels {
            if xx >= w || yy >= h {
                return Err(bad("Card component mask outside resolved crop"));
            }
            image.put_pixel(xx, yy, image::Rgb(mask.background_rgb));
        }
    }
    Ok(Some(DynamicImage::ImageRgb8(image)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn plane_fallback_cannot_promote_avatar_components_to_glyph_support() {
        let fallback = plane::CardResolution::Fallback {
            reason: "No card edges".into(),
        };
        let fit = card_glyph::GlyphFit {
            bounds: card_glyph::InkBounds {
                x: 2,
                y: 2,
                width: 5,
                height: 8,
            },
            erase_pixels: vec![],
            background_rgb: [20; 3],
            boundary_contact: [false; 4],
        };
        let mut region =
            json!({"guide":{"family":"card.rank"},"bounds":{"x":1,"y":2,"width":3,"height":4}});
        let before = region.clone();
        target_evidence(&mut region, &fallback, Some(&fit), &json!({"uniform":true}));
        assert_eq!(
            region["card_target_evidence"]["target_support"],
            "unsupported"
        );
        assert_eq!(region["card_target_evidence"]["ocr_admission"], "always");
        assert_eq!(
            region["card_target_evidence"]["semantic_verification"],
            false
        );
        assert_eq!(region["guide"], before["guide"]);
        assert_eq!(region["bounds"], before["bounds"]);
        assert!(region["localization_error"].is_null());
    }

    #[test]
    fn rank_descender_beyond_nominal_box_is_not_selected_as_suit() {
        let mut frame = RgbImage::from_pixel(120, 120, Rgb([255; 3]));
        for y in 10..29 {
            for x in 12..17 {
                frame.put_pixel(x, y, Rgb([30; 3]));
            }
        }
        for y in 32..43 {
            for x in 12..19 {
                frame.put_pixel(x, y, Rgb([30; 3]));
            }
        }
        let quad = [
            plane::Point { x: 0., y: 0. },
            plane::Point { x: 100., y: 0. },
            plane::Point { x: 100., y: 100. },
            plane::Point { x: 0., y: 100. },
        ];
        let pose = plane::CardPose {
            policy: plane::POLICY.into(),
            prior_quad: quad,
            quad,
            rank: plane::LocalRect {
                x: 0.1,
                y: 0.05,
                width: 0.2,
                height: 0.2,
            },
            suit: plane::LocalRect {
                x: 0.1,
                y: 0.23,
                width: 0.2,
                height: 0.25,
            },
            prior_angle_degrees: 0.,
            measured_angle_degrees: 0.,
            applied_angle_degrees: 0.,
            adjusted: false,
            top_edge: None,
            left_edge: None,
        };
        let rank = sample_field(&frame, &pose, plane::Field::Rank).unwrap();
        let rank_fit = fit_field(&frame, &pose, &rank, true, Some([255; 3])).unwrap();
        assert_eq!(rank_fit.bounds.y + rank_fit.bounds.height + 5, 30);
        let suit = sample_field(&frame, &pose, plane::Field::Suit).unwrap();
        let suit_fit = fit_field(&frame, &pose, &suit, false, Some([255; 3])).unwrap();
        assert_eq!(suit_fit.bounds.y + 23, 31);
        assert_eq!(suit_fit.bounds.y + suit_fit.bounds.height + 23, 44);

        for bg in [[17, 17, 17], [0, 184, 1]] {
            let mut colored = RgbImage::from_pixel(120, 120, Rgb(bg));
            for y in 10..24 {
                for x in 12..17 {
                    colored.put_pixel(x, y, Rgb([255; 3]));
                }
            }
            for y in 32..43 {
                for x in 12..19 {
                    colored.put_pixel(x, y, Rgb([255; 3]));
                }
            }
            let rank = sample_field(&colored, &pose, plane::Field::Rank).unwrap();
            assert_eq!(rank.rgb.height(), 20);
            let suit = sample_field(&colored, &pose, plane::Field::Suit).unwrap();
            let suit_fit = fit_field(&colored, &pose, &suit, false, Some(bg)).unwrap();
            assert_eq!(suit_fit.bounds.y + 23, 31);
            assert_eq!(suit_fit.bounds.y + suit_fit.bounds.height + 23, 44);
        }
    }
}
