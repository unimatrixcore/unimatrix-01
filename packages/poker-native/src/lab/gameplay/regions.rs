#[path = "occupancy.rs"]
mod occupancy;
use crate::lab::{bad, LabResult};
use image::{DynamicImage, GenericImageView, RgbImage};
pub use occupancy::{is_empty as seat_is_empty, resolve as resolve_seat_occupancy};
use serde_json::{json, Value};

pub fn crop(image: &DynamicImage, region: &Value) -> LabResult<Vec<u8>> {
    crate::media::png(&crop_pixels(image, region)?).map_err(bad)
}
pub fn crop_pixels(image: &DynamicImage, region: &Value) -> LabResult<DynamicImage> {
    if seat_is_empty(region) {
        return Err(bad("Proven empty seat has no OCR crop"));
    }
    if let Some(reason) = region["localization_error"].as_str() {
        return Err(bad(reason));
    }
    if !region["localizer"].is_null() {
        return crop_pixels(image, &super::panels::resolve(image, region)?);
    }
    if !region["card_sampling"].is_null() {
        let owned;
        let rgb = if let Some(rgb) = image.as_rgb8() {
            rgb
        } else {
            owned = image.to_rgb8();
            &owned
        };
        if let Some(sampled) = super::card_fields::sample(rgb, region)? {
            return Ok(sampled);
        }
    }
    let raw = unmasked_pixels(image, region)?;
    if region["crop_mask"].is_null() {
        return Ok(raw);
    }
    let descriptor =
        serde_json::from_value::<super::crop_mask::MaskDescriptor>(region["crop_mask"].clone())?;
    let masked = super::crop_mask::apply(&raw.to_rgb8(), &descriptor)?;
    Ok(DynamicImage::ImageRgb8(masked.rgb))
}
pub fn presentation_png(canonical: &[u8], mask: &Value) -> LabResult<Vec<u8>> {
    if mask.is_null() {
        return Ok(canonical.to_vec());
    }
    let descriptor: super::crop_mask::MaskDescriptor = serde_json::from_value(mask.clone())?;
    let rgb = crate::media::decode_image(canonical)
        .map_err(bad)?
        .to_rgb8();
    let coverage = super::crop_mask::apply(&rgb, &descriptor)?.valid_mask;
    let output = image::RgbaImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let a = u32::from(coverage.get_pixel(x, y).0[0]);
        let color = rgb.get_pixel(x, y).0;
        let straight = std::array::from_fn::<_, 3, _>(|c| {
            if a == 0 {
                0
            } else {
                ((i32::from(color[c]) * 255
                    - i32::from(descriptor.neutral_rgb[c]) * (255 - a) as i32
                    + (a / 2) as i32)
                    / (a as i32))
                    .clamp(0, 255) as u8
            }
        });
        image::Rgba([straight[0], straight[1], straight[2], a as u8])
    });
    crate::media::png(&DynamicImage::ImageRgba8(output)).map_err(bad)
}

pub(super) fn unmasked_pixels(image: &DynamicImage, region: &Value) -> LabResult<DynamicImage> {
    if let Some(points) = region["polygon"].as_array().filter(|p| p.len() == 4) {
        let point = |i: usize| -> LabResult<(f64, f64)> {
            Ok((
                points[i]["x"]
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| bad("Invalid region polygon"))?,
                points[i]["y"]
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| bad("Invalid region polygon"))?,
            ))
        };
        let (a, b, d) = (point(0)?, point(1)?, point(3)?);
        if (a.1 - b.1).abs() < 0.000001 && (a.0 - d.0).abs() < 0.000001 && b.0 > a.0 && d.1 > a.1 {
            return rectangular_pixels(
                image,
                &region["bounds"],
                region["envelope"]["clippedToViewport"] == true,
            );
        }
        let width = ((b.0 - a.0).hypot(b.1 - a.1)).ceil() as u32;
        let height = ((d.0 - a.0).hypot(d.1 - a.1)).ceil() as u32;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_000_000 {
            return Err(bad("Unsupported region dimensions"));
        }
        let owned;
        let source = if let Some(rgb) = image.as_rgb8() {
            rgb
        } else {
            owned = image.to_rgb8();
            &owned
        };
        let mut output = RgbImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let u = (x as f64 + 0.5) / width as f64;
                let v = (y as f64 + 0.5) / height as f64;
                let sx = a.0 + u * (b.0 - a.0) + v * (d.0 - a.0);
                let sy = a.1 + u * (b.1 - a.1) + v * (d.1 - a.1);
                if sx < 0. || sy < 0. || sx >= source.width() as f64 || sy >= source.height() as f64
                {
                    return Err(bad("Region exceeds recorded frame"));
                }
                output.put_pixel(
                    x,
                    y,
                    *source.get_pixel(sx.floor() as u32, sy.floor() as u32),
                );
            }
        }
        return Ok(DynamicImage::ImageRgb8(output));
    }
    rectangular_pixels(
        image,
        &region["bounds"],
        region["envelope"]["clippedToViewport"] == true,
    )
}
fn rectangular_pixels(
    image: &DynamicImage,
    b: &Value,
    allow_padding: bool,
) -> LabResult<DynamicImage> {
    let x = b["x"].as_f64().unwrap_or(-1.).floor();
    let y = b["y"].as_f64().unwrap_or(-1.).floor();
    let right = (b["x"].as_f64().unwrap_or(-1.) + b["width"].as_f64().unwrap_or(0.)).ceil();
    let bottom = (b["y"].as_f64().unwrap_or(-1.) + b["height"].as_f64().unwrap_or(0.)).ceil();
    if allow_padding
        && [x, y, right, bottom].into_iter().all(f64::is_finite)
        && right > x
        && bottom > y
        && (right - x) * (bottom - y) <= 16_000_000.
    {
        let left = x.max(0.).min(image.width() as f64) as u32;
        let top = y.max(0.).min(image.height() as f64) as u32;
        let visible_right = right.max(0.).min(image.width() as f64) as u32;
        let visible_bottom = bottom.max(0.).min(image.height() as f64) as u32;
        if visible_right <= left || visible_bottom <= top {
            return Err(bad("Region is outside the recorded viewport"));
        }
        let mut padded = RgbImage::from_pixel(
            (right - x) as u32,
            (bottom - y) as u32,
            image::Rgb([255, 0, 255]),
        );
        let visible = image
            .crop_imm(left, top, visible_right - left, visible_bottom - top)
            .to_rgb8();
        image::imageops::replace(
            &mut padded,
            &visible,
            left as i64 - x as i64,
            top as i64 - y as i64,
        );
        return Ok(DynamicImage::ImageRgb8(padded));
    }
    if ![x, y, right, bottom].into_iter().all(f64::is_finite)
        || x < 0.
        || y < 0.
        || right <= x
        || bottom <= y
        || right > image.width() as f64
        || bottom > image.height() as f64
    {
        return Err(bad("Region exceeds recorded frame"));
    }
    Ok(image.crop_imm(x as u32, y as u32, (right - x) as u32, (bottom - y) as u32))
}

pub fn padding_translation_equal(a: &[u8], b: &[u8]) -> bool {
    let (Ok(a), Ok(b)) = (crate::media::decode_image(a), crate::media::decode_image(b)) else {
        return false;
    };
    if a.dimensions() != b.dimensions() {
        return false;
    }
    let (a, b) = (a.to_rgb8(), b.to_rgb8());
    let (w, h) = (a.width() as i32, a.height() as i32);
    if w < 3 || h < 3 {
        return false;
    }
    let background = *a.get_pixel(0, 0);
    if *b.get_pixel(0, 0) != background {
        return false;
    }
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let mut valid = true;
            for y in 0..h {
                for x in 0..w {
                    let (xx, yy) = (x + dx, y + dy);
                    let pixel = a.get_pixel(x as u32, y as u32);
                    if xx >= 0 && yy >= 0 && xx < w && yy < h {
                        if pixel != b.get_pixel(xx as u32, yy as u32) {
                            valid = false;
                            break;
                        }
                    } else if *pixel != background {
                        valid = false;
                        break;
                    }
                    let (px, py) = (x - dx, y - dy);
                    if (px < 0 || py < 0 || px >= w || py >= h)
                        && *b.get_pixel(x as u32, y as u32) != background
                    {
                        valid = false;
                        break;
                    }
                }
                if !valid {
                    break;
                }
            }
            if valid {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    #[test]
    fn axis_aligned_fast_path_preserves_decoded_pixel_identity() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_fn(30, 20, |x, y| {
            Rgb([x as u8, y as u8, (x + y) as u8])
        }));
        let region = serde_json::json!({"bounds":{"x":3,"y":4,"width":13,"height":7},"polygon":[{"x":3,"y":4},{"x":16,"y":4},{"x":16,"y":11},{"x":3,"y":11}]});
        let expected = image.crop_imm(3, 4, 13, 7);
        let actual = crop_pixels(&image, &region).unwrap();
        assert_eq!(actual.to_rgb8(), expected.to_rgb8());
        assert_eq!(
            crate::lab::review::image_identity(&crate::media::png(&actual).unwrap())
                .unwrap()
                .1,
            crate::lab::review::image_identity(&crate::media::png(&expected).unwrap())
                .unwrap()
                .1
        );
        let invalid = serde_json::json!({"bounds":{"x":29,"y":0,"width":2,"height":3}});
        assert!(crop_pixels(&image, &invalid).is_err());
    }
    #[test]
    fn near_reuse_requires_unchanged_pixels_and_padding() {
        let mut a = RgbImage::from_pixel(20, 10, Rgb([0, 0, 0]));
        a.put_pixel(5, 5, Rgb([255, 255, 255]));
        let mut b = RgbImage::from_pixel(20, 10, Rgb([0, 0, 0]));
        b.put_pixel(6, 5, Rgb([255, 255, 255]));
        let png = |v: RgbImage| crate::media::png(&DynamicImage::ImageRgb8(v)).unwrap();
        assert!(padding_translation_equal(&png(a.clone()), &png(b.clone())));
        b.put_pixel(7, 5, Rgb([255, 255, 255]));
        assert!(!padding_translation_equal(&png(a), &png(b)));
    }
}

pub fn project_guide(region: &Value, width: u32, height: u32) -> Value {
    let guide = &region["guide"];
    let Some(anchor_x) = guide["anchor"]["x"].as_f64() else {
        return Value::Null;
    };
    let Some(anchor_y) = guide["anchor"]["y"].as_f64() else {
        return Value::Null;
    };
    let bounds = &region["bounds"];
    let points = region["polygon"].as_array().filter(|p| p.len() == 4);
    let (ax, ay, bx, by, dx, dy) = if let Some(p) = points {
        (
            p[0]["x"].as_f64().unwrap_or(0.),
            p[0]["y"].as_f64().unwrap_or(0.),
            p[1]["x"].as_f64().unwrap_or(0.),
            p[1]["y"].as_f64().unwrap_or(0.),
            p[3]["x"].as_f64().unwrap_or(0.),
            p[3]["y"].as_f64().unwrap_or(0.),
        )
    } else {
        let x = bounds["x"].as_f64().unwrap_or(0.);
        let y = bounds["y"].as_f64().unwrap_or(0.);
        (
            x,
            y,
            x + bounds["width"].as_f64().unwrap_or(0.),
            y,
            x,
            y + bounds["height"].as_f64().unwrap_or(0.),
        )
    };
    let rect = (ay - by).abs() < 0.000001 && (ax - dx).abs() < 0.000001 && bx > ax && dy > ay;
    let project = |x: f64, y: f64| {
        if rect {
            return Some((
                x - bounds["x"].as_f64()?.floor(),
                y - bounds["y"].as_f64()?.floor(),
            ));
        }
        let determinant = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        if determinant.abs() < 0.000001 {
            return None;
        }
        Some((
            ((x - ax) * (dy - ay) - (y - ay) * (dx - ax)) / determinant * width as f64,
            ((y - ay) * (bx - ax) - (x - ax) * (by - ay)) / determinant * height as f64,
        ))
    };
    let Some((x, y)) = project(anchor_x, anchor_y) else {
        return Value::Null;
    };
    if !x.is_finite() || !y.is_finite() || x < 0. || y < 0. || x > width as f64 || y > height as f64
    {
        return Value::Null;
    }
    let slot = &guide["slot"];
    let Some((sx, sy, sw, sh)) = slot["x"]
        .as_f64()
        .zip(slot["y"].as_f64())
        .zip(slot["width"].as_f64().zip(slot["height"].as_f64()))
        .map(|((x, y), (w, h))| (x, y, w, h))
    else {
        return Value::Null;
    };
    if ![sx, sy, sw, sh].into_iter().all(f64::is_finite)
        || sw <= 0.
        || sh <= 0.
        || !["left", "center", "right"].contains(&guide["alignment"].as_str().unwrap_or(""))
        || !["css_slot", "deck_glyph_union", "pixel_panel"]
            .contains(&guide["source"].as_str().unwrap_or(""))
        || guide["family"].as_str().is_none_or(str::is_empty)
    {
        return Value::Null;
    }
    let corners = [(sx, sy), (sx + sw, sy), (sx + sw, sy + sh), (sx, sy + sh)].map(|(x, y)| {
        project(x, y)
            .map(|(x, y)| serde_json::json!({"x":x,"y":y}))
            .unwrap_or(Value::Null)
    });
    let mut projected = serde_json::json!({"policy":if guide["source"]=="pixel_panel"{"pixel_resolved_field_v2"}else{"source_css_target_anchor_v1"},"anchor":{"x":x,"y":y},"slot_polygon":corners,"alignment":guide["alignment"],"family":guide["family"],"source":guide["source"],"crop_width":width,"crop_height":height});
    if guide["occlusion"].is_object() {
        projected["occlusion"] = guide["occlusion"].clone();
    }
    if guide["family"] == "split_pot_group" {
        projected["ordinal_basis"] = serde_json::json!("rendered_visible_order");
        projected["target_ordinal"] = region["id"]
            .as_str()
            .and_then(|id| id.strip_prefix("pot."))
            .and_then(|index| index.parse::<usize>().ok())
            .map(|index| serde_json::json!(index))
            .unwrap_or(Value::Null);
    }
    projected
}

#[cfg(test)]
mod guide_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn declared_viewport_padding_preserves_visible_pixels_and_marks_unavailable_area() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_fn(4, 4, |x, y| {
            image::Rgb([x as u8, y as u8, 70])
        }));
        let mut region = json!({"bounds":{"x":2.,"y":2.,"width":4.,"height":4.}});
        assert!(crop_pixels(&image, &region).is_err());
        region["envelope"] = json!({"clippedToViewport":true});
        let padded = crop_pixels(&image, &region).unwrap().to_rgb8();
        assert_eq!(padded.dimensions(), (4, 4));
        assert_eq!(
            padded.view(0, 0, 2, 2).to_image(),
            image.to_rgb8().view(2, 2, 2, 2).to_image()
        );
        assert_eq!(padded.get_pixel(3, 3).0, [255, 0, 255]);
    }
    #[test]
    fn source_anchor_projects_to_pixel_cover_and_rotated_crop() {
        let mut r = json!({"bounds":{"x":2.2,"y":3.1,"width":5.4,"height":2.7},"guide":{"slot":{"x":3.,"y":3.5,"width":3.,"height":1.5},"anchor":{"x":4.2,"y":4.1},"alignment":"center","family":"name","source":"css_slot"}});
        let g = project_guide(&r, 6, 3);
        assert!((g["anchor"]["x"].as_f64().unwrap() - 2.2).abs() < 0.00001);
        assert!((g["anchor"]["y"].as_f64().unwrap() - 1.1).abs() < 0.00001);
        r["polygon"] = json!([{"x":10.,"y":0.},{"x":10.,"y":4.},{"x":8.,"y":4.},{"x":8.,"y":0.}]);
        r["bounds"] = json!({"x":8.,"y":0.,"width":2.,"height":4.});
        r["guide"]["anchor"] = json!({"x":9.,"y":2.});
        assert_eq!(project_guide(&r, 4, 2)["anchor"], json!({"x":2.,"y":1.}));
        r["guide"]["anchor"]["x"] = json!(100.);
        assert!(project_guide(&r, 4, 2).is_null());
    }
}

pub fn uniform_padding(image: &DynamicImage) -> bool {
    let Some(rgb) = image.as_rgb8() else {
        return false;
    };
    let (w, h) = rgb.dimensions();
    if w < 3 || h < 3 {
        return false;
    }
    let background = rgb.get_pixel(0, 0);
    (0..w).all(|x| rgb.get_pixel(x, 0) == background && rgb.get_pixel(x, h - 1) == background)
        && (0..h)
            .all(|y| rgb.get_pixel(0, y) == background && rgb.get_pixel(w - 1, y) == background)
}

pub fn recording_guide(
    region: &Value,
    crop_image: &DynamicImage,
    width: u32,
    height: u32,
) -> Value {
    let b = &region["bounds"];
    let mut guide = project_guide(region, crop_image.width(), crop_image.height());
    if !guide.is_null() {
        let x = b["x"].as_f64().unwrap_or(0.).floor();
        let y = b["y"].as_f64().unwrap_or(0.).floor();
        guide["visible_pixel_rect"] = json!({"x":(-x).max(0.),"y":(-y).max(0.),"width":((width as f64-x).min(crop_image.width() as f64)-(-x).max(0.)).max(0.),"height":((height as f64-y).min(crop_image.height() as f64)-(-y).max(0.)).max(0.)});
        if region["guide"]["anchor"]["x"]
            .as_f64()
            .is_none_or(|x| x < 0. || x > width as f64)
            || region["guide"]["anchor"]["y"]
                .as_f64()
                .is_none_or(|y| y < 0. || y > height as f64)
            || region["guide"]["slot"]["x"]
                .as_f64()
                .zip(region["guide"]["slot"]["width"].as_f64())
                .is_none_or(|(x, w)| x < 0. || x + w > width as f64)
            || region["guide"]["slot"]["y"]
                .as_f64()
                .zip(region["guide"]["slot"]["height"].as_f64())
                .is_none_or(|(y, h)| y < 0. || y + h > height as f64)
        {
            guide = Value::Null;
        }
    }

    guide
}
#[cfg(test)]
mod mask_projection_tests {
    use super::*;
    #[test]
    fn canonical_crops_are_opaque_but_display_pngs_use_the_same_rounded_cutout() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            40,
            40,
            image::Rgb([240, 240, 240]),
        ));
        let descriptor = super::super::crop_mask::from_resolved_panels(
            super::super::crop_mask::SourcePanel::ChipColumnsValue,
            [0., 0.],
            &[super::super::crop_mask::Rect {
                x: 0.,
                y: 0.,
                width: 40.,
                height: 40.,
            }],
        )
        .unwrap();
        let region =
            json!({"bounds":{"x":0.,"y":0.,"width":40.,"height":40.},"crop_mask":descriptor});
        let canonical = crop_pixels(&image, &region).unwrap();
        assert_eq!(canonical.color(), image::ColorType::Rgb8);
        let rgb = canonical.to_rgb8();
        assert_eq!(rgb.get_pixel(0, 0).0, super::super::crop_mask::NEUTRAL_RGB);
        assert_eq!(rgb.get_pixel(20, 20).0, [240, 240, 240]);
        let png = crate::media::png(&canonical).unwrap();
        let display = presentation_png(&png, &region["crop_mask"]).unwrap();
        let display = image::load_from_memory(&display).unwrap().to_rgba8();
        assert_eq!(display.get_pixel(0, 0).0[3], 0);
        assert_eq!(display.get_pixel(20, 20).0, [240, 240, 240, 255]);
        assert_eq!(presentation_png(&png, &Value::Null).unwrap(), png);
    }
}
