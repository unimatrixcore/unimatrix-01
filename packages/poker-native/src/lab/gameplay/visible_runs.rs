use super::crop_mask::{self, MaskDescriptor, SourcePanel};
use crate::lab::{bad, LabResult};
use image::{DynamicImage, RgbImage};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const POLICY: &str = "visible_runs_v1";

#[derive(Clone, Copy, Debug, Serialize)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct Run {
    pub rect: PixelRect,
    pub components: Vec<PixelRect>,
    pub left_boundary: &'static str,
    pub right_boundary: &'static str,
    pub coverage_rle: Vec<(u8, u32)>,
    pub pixel_sha256: String,
    #[serde(skip)]
    pub pixels: RgbImage,
}

impl Run {
    pub fn png(&self) -> LabResult<Vec<u8>> {
        crate::media::png(&DynamicImage::ImageRgb8(self.pixels.clone())).map_err(bad)
    }
}

fn ink([r, g, b]: [u8; 3]) -> bool {
    let min = r.min(g).min(b);
    min >= 90 && r.max(g).max(b) - min < 45
}

fn rgb_hash(rgb: &RgbImage) -> String {
    let mut digest = Sha256::new();
    digest.update(format!("{}x{}:RGB:", rgb.width(), rgb.height()));
    digest.update(rgb.as_raw());
    format!("{:x}", digest.finalize())
}

pub fn extract(parent: &RgbImage, descriptor: &MaskDescriptor) -> LabResult<Vec<Run>> {
    let (w, h) = parent.dimensions();
    if w > 4096
        || h > 512
        || descriptor.source != SourcePanel::ChipColumnsValue
        || descriptor.neutral_rgb != crop_mask::NEUTRAL_RGB
    {
        return Err(bad("Unsupported visible-run parent"));
    }
    let masked = crop_mask::apply(parent, descriptor)?;
    // Currency artwork is saturated and precedes the monochrome text. Exclude its
    // entire horizontal extent, including antialiasing and white interior detail.
    let mut text_start = 0;
    for (x, y, p) in masked.rgb.enumerate_pixels() {
        let [r, g, b] = p.0;
        if masked.valid_mask.get_pixel(x, y)[0] == 255 && r.max(g).max(b) - r.min(g).min(b) > 70 {
            text_start = text_start.max(x + 1);
        }
    }
    if text_start > 0 {
        text_start = text_start.saturating_add((h / 16).max(1));
    }
    let mut components: Vec<PixelRect> = Vec::new();
    for x in text_start..w {
        let mut ys = (0..h).filter(|&y| ink(masked.rgb.get_pixel(x, y).0));
        let Some(top) = ys.next() else { continue };
        let bottom = ys.last().unwrap_or(top) + 1;
        if let Some(last) = components.last_mut().filter(|b| b.x + b.width == x) {
            let base = bottom.max(last.y + last.height);
            last.y = last.y.min(top);
            last.height = base - last.y;
            last.width += 1;
        } else {
            components.push(PixelRect {
                x,
                y: top,
                width: 1,
                height: bottom - top,
            });
        }
    }
    let Some(top) = components.iter().map(|c| c.y).min() else {
        return Ok(Vec::new());
    };
    let bottom = components.iter().map(|c| c.y + c.height).max().unwrap();
    // A lone low fragment provides no line-height evidence.
    if (bottom - top) * 3 < h {
        return Ok(Vec::new());
    }
    // Extend the observed ink band to both expected source-font line edges.
    // A horizontal cut across every glyph can otherwise make a clipped row
    // masquerade as a shorter, fully visible line.
    let guard = h.div_ceil(20);
    let Some(top) = top.checked_sub(guard) else {
        return Ok(Vec::new());
    };
    let Some(bottom) = bottom.checked_add(guard).filter(|&edge| edge <= h) else {
        return Ok(Vec::new());
    };
    let top = top.min(h / 6);
    let bottom = bottom.max(h - h / 6);
    let closed_side = |left: bool| {
        descriptor.panels.iter().any(|panel| {
            let edge = if left {
                panel.bounds.x
            } else {
                f64::from(w) - panel.bounds.x - panel.bounds.width
            };
            let corners = if left { [0, 3] } else { [1, 2] };
            edge.abs() < 1.0
                && corners
                    .iter()
                    .any(|&i| panel.corners[i].x > 0.0 && panel.corners[i].y > 0.0)
        })
    };
    let left_closed = closed_side(true);
    let right_closed = closed_side(false);
    let safe = |x: u32| (top..bottom).all(|y| masked.valid_mask.get_pixel(x, y)[0] == 255);
    let mut runs = Vec::new();
    let mut start = 0;
    while start < w {
        if !safe(start) {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < w && safe(end) {
            end += 1;
        }
        let left_open = !left_closed
            || (0..start).any(safe)
            || (0..start).any(|x| (top..bottom).all(|y| masked.valid_mask.get_pixel(x, y)[0] == 0));
        let right_open = !right_closed
            || (end..w).any(safe)
            || (end..w).any(|x| (top..bottom).all(|y| masked.valid_mask.get_pixel(x, y)[0] == 0));
        let kept: Vec<_> = components
            .iter()
            .copied()
            .filter(|c| c.x >= start + guard && c.x + c.width + guard <= end)
            .collect();
        if let (Some(first), Some(last)) = (kept.first(), kept.last()) {
            // Keep the outer antialias fringe and a little original background.
            // Stop before the fringe of any rejected neighbour.
            let previous = components
                .iter()
                .take_while(|c| c.x < first.x)
                .last()
                .map_or(text_start, |c| c.x + c.width + 1);
            let next = components
                .iter()
                .find(|c| c.x > last.x)
                .map_or(end, |c| c.x.saturating_sub(1));
            let x = first
                .x
                .saturating_sub(guard)
                .max(previous.min(first.x))
                .max(start);
            let width = (last.x + last.width + guard)
                .min(next.max(last.x + last.width))
                .min(end)
                - x;
            let pixels = image::imageops::crop_imm(&masked.rgb, x, 0, width, h).to_image();
            let rle = coverage_rle(&masked.valid_mask, x, width);
            runs.push(Run {
                rect: PixelRect {
                    x,
                    y: 0,
                    width,
                    height: h,
                },
                components: kept,
                left_boundary: if left_open {
                    "open"
                } else if start > guard && text_start == 0 {
                    "unknown"
                } else {
                    "closed"
                },
                right_boundary: if right_open { "open" } else { "closed" },
                coverage_rle: rle,
                pixel_sha256: rgb_hash(&pixels),
                pixels,
            });
        }
        start = end;
    }
    Ok(runs)
}

fn coverage_rle(mask: &image::GrayImage, x: u32, width: u32) -> Vec<(u8, u32)> {
    let mut rle: Vec<(u8, u32)> = Vec::new();
    for y in 0..mask.height() {
        for col in x..x + width {
            let samples = ((u16::from(mask.get_pixel(col, y)[0]) * 16 + 127) / 255) as u8;
            match rle.last_mut() {
                Some((s, n)) if *s == samples => *n += 1,
                _ => rle.push((samples, 1)),
            }
        }
    }
    rle
}

pub fn parent_evidence(
    image: &DynamicImage,
    region: &serde_json::Value,
) -> LabResult<serde_json::Value> {
    let raw = super::regions::unmasked_pixels(image, region)?.to_rgb8();
    let mask = serde_json::from_value(region["crop_mask"].clone())?;
    let coverage = crop_mask::apply(&raw, &mask)?.valid_mask;
    let bounds = &region["bounds"];
    Ok(serde_json::json!({"parent_raw_pixel_sha256":rgb_hash(&raw),
        "parent_rect":{"x":bounds["x"].as_f64().ok_or_else(||bad("Missing x"))?.floor() as i64,
                       "y":bounds["y"].as_f64().ok_or_else(||bad("Missing y"))?.floor() as i64,
                       "w":raw.width(),"h":raw.height()},
        "parent_coverage_rle":coverage_rle(&coverage,0,coverage.width())}))
}

pub fn extract_region(image: &DynamicImage, region: &serde_json::Value) -> LabResult<Vec<Run>> {
    let raw = super::regions::unmasked_pixels(image, region)?.to_rgb8();
    let mask = serde_json::from_value(region["crop_mask"].clone())?;
    extract(&raw, &mask)
}

pub fn resolve_bet_profile(
    image: &DynamicImage,
    profile: &serde_json::Value,
) -> LabResult<serde_json::Value> {
    if profile["viewport"]["width"].as_u64() != Some(u64::from(image.width()))
        || profile["viewport"]["height"].as_u64() != Some(u64::from(image.height()))
    {
        return Err(bad("Frame and source profile viewport dimensions differ"));
    }
    super::panels::resolve_profile(image, profile)
}

pub fn eligible(region: &serde_json::Value) -> bool {
    let isolated_partial = region["localization"]["state"] == "partially_occluded"
        && region["guide"]["occlusion"]["partial"] == true;
    !super::regions::seat_is_empty(region)
        && region["ocr"] != false
        && region["crop_mask_source"] == "chip_columns_value"
        && region["crop_mask"].is_object()
        && region["localization_error"].is_null()
        && (region["presence"]["state"] == "present"
            || (isolated_partial
                && (region["presence"]["state"].is_null()
                    || region["presence"]["state"] == "ambiguous")))
}

#[cfg(test)]
mod tests {
    use super::crop_mask::{CornerRadius, Rect, RoundedPanel};
    use super::*;
    use image::Rgb;

    fn panel(x: u32, width: u32) -> RoundedPanel {
        RoundedPanel {
            bounds: Rect {
                x: x.into(),
                y: 0.,
                width: width.into(),
                height: 20.,
            },
            corners: [CornerRadius { x: 0., y: 0. }; 4],
        }
    }
    fn mask(panels: Vec<RoundedPanel>) -> MaskDescriptor {
        MaskDescriptor {
            policy: crop_mask::POLICY.into(),
            source: SourcePanel::ChipColumnsValue,
            neutral_rgb: crop_mask::NEUTRAL_RGB,
            panels,
        }
    }
    fn paint(im: &mut RgbImage, start: u32, end: u32, top: u32, bottom: u32, color: [u8; 3]) {
        for y in top..bottom {
            for x in start..end {
                im.put_pixel(x, y, Rgb(color));
            }
        }
    }
    #[test]
    fn middle_hole_separates_repeated_glyphs_preserves_decimal_and_drops_cut_cluster() {
        let mut im = RgbImage::from_pixel(48, 20, Rgb(crop_mask::NEUTRAL_RGB));
        for (a, b) in [(3, 7), (10, 14), (21, 27), (33, 38)] {
            paint(&mut im, a, b, 4, 16, [220; 3]);
        }
        paint(&mut im, 16, 18, 13, 16, [220; 3]);
        let descriptor = mask(vec![panel(0, 24), panel(30, 18)]);
        let runs = extract(&im, &descriptor).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(
            runs[0].components.iter().map(|b| b.x).collect::<Vec<_>>(),
            [3, 10, 16]
        );
        assert_eq!(runs[1].components[0].x, 33);
        assert_eq!(runs[0].right_boundary, "open");
        assert_eq!(runs[1].left_boundary, "open");
        assert!(runs[0].rect.x + runs[0].rect.width < 21);
        let before = serde_json::to_value(&runs).unwrap();
        paint(&mut im, 24, 30, 0, 20, [240, 5, 7]);
        assert_eq!(
            before,
            serde_json::to_value(extract(&im, &descriptor).unwrap()).unwrap()
        );
    }
    #[test]
    fn all_hidden_background_badge_only_and_horizontal_fragments_have_no_runs() {
        let mut im = RgbImage::from_pixel(40, 20, Rgb(crop_mask::NEUTRAL_RGB));
        let visible = mask(vec![panel(0, 30)]);
        assert!(extract(&im, &visible).unwrap().is_empty());
        paint(&mut im, 31, 35, 4, 16, [255; 3]);
        assert!(extract(&im, &visible).unwrap().is_empty());
        paint(&mut im, 3, 13, 3, 17, [240, 190, 0]);
        paint(&mut im, 6, 9, 6, 14, [230; 3]);
        assert!(extract(&im, &visible).unwrap().is_empty());
        paint(&mut im, 20, 25, 4, 16, [235; 3]);
        let mut partial = panel(0, 30);
        partial.bounds.height = 13.;
        assert!(extract(&im, &mask(vec![partial])).unwrap().is_empty());
    }

    #[test]
    fn partially_covered_saturated_corner_does_not_hide_intact_text() {
        let mut im = RgbImage::from_pixel(60, 30, Rgb(crop_mask::NEUTRAL_RGB));
        paint(&mut im, 3, 10, 8, 22, [240, 190, 0]);
        paint(&mut im, 5, 7, 12, 18, [230; 3]);
        paint(&mut im, 25, 30, 6, 24, [220; 3]);
        let descriptor = crop_mask::from_resolved_panels(
            SourcePanel::ChipColumnsValue,
            [0., 0.],
            &[Rect {
                x: 0.,
                y: 0.,
                width: 60.,
                height: 30.,
            }],
        )
        .unwrap();
        let coverage = crop_mask::apply(&im, &descriptor).unwrap().valid_mask;
        let (x, y, _) = coverage
            .enumerate_pixels()
            .find(|(x, _, value)| *x > 40 && value[0] > 100 && value[0] < 255)
            .unwrap();
        im.put_pixel(x, y, Rgb([0, 255, 0]));
        let masked = crop_mask::apply(&im, &descriptor).unwrap();
        let [r, g, b] = masked.rgb.get_pixel(x, y).0;
        assert!(r.max(g).max(b) - r.min(g).min(b) > 70);
        let runs = extract(&im, &descriptor).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].components.len(), 1);
        assert_eq!(runs[0].components[0].x, 25);
    }

    #[test]
    fn horizontal_mask_cuts_need_covered_margin_beyond_observed_ink() {
        let mut im = RgbImage::from_pixel(60, 30, Rgb(crop_mask::NEUTRAL_RGB));
        paint(&mut im, 24, 30, 4, 26, [220; 3]);
        let mut full = panel(0, 60);
        full.bounds.height = 30.;
        assert_eq!(extract(&im, &mask(vec![full.clone()])).unwrap().len(), 1);
        let mut top_cut = full.clone();
        top_cut.bounds.y = 5.;
        top_cut.bounds.height = 25.;
        assert!(extract(&im, &mask(vec![top_cut])).unwrap().is_empty());
        let mut bottom_cut = full;
        bottom_cut.bounds.height = 25.;
        assert!(extract(&im, &mask(vec![bottom_cut])).unwrap().is_empty());
    }

    #[test]
    fn legacy_missing_presence_decision_only_allows_isolated_partial_runs() {
        let mut region = serde_json::json!({
            "category":"bet", "crop_mask_source":"chip_columns_value", "crop_mask":{},
            "localization":{"state":"partially_occluded"}, "guide":{"occlusion":{"partial":true}}
        });
        assert!(eligible(&region));
        for state in ["absent", "unknown", ""] {
            region["presence"] = serde_json::json!({"state":state});
            assert!(!eligible(&region), "{state}");
        }
        for state in ["present", "ambiguous"] {
            region["presence"] = serde_json::json!({"state":state});
            assert!(eligible(&region), "{state}");
        }
        region.as_object_mut().unwrap().remove("presence");
        region["guide"]["occlusion"]["partial"] = false.into();
        assert!(!eligible(&region));
    }
}
