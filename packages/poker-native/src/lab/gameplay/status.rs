use crate::lab::{bad, LabResult};
use image::{DynamicImage, RgbImage};
use serde_json::{json, Value};

pub fn background_matches(p: [u8; 3], spec: &Value) -> bool {
    let Some(target) = spec["status_rgb"].as_array().filter(|v| v.len() == 3) else {
        return false;
    };
    let t = std::array::from_fn::<_, 3, _>(|c| target[c].as_f64().unwrap_or(-1000.));
    if spec["composite"] == true {
        return (0..3).all(|c| (f64::from(p[c]) - t[c]).abs() <= 11.);
    }
    let squared = t.iter().map(|v| v * v).sum::<f64>();
    if squared <= 0. {
        return false;
    }
    let scale = ((0..3).map(|c| f64::from(p[c]) * t[c]).sum::<f64>() / squared)
        .clamp(spec["scale_min"].as_f64().unwrap_or(0.85), 1.05);
    (0..3).all(|c| (f64::from(p[c]) - scale * t[c]).abs() <= 8.)
}
fn composite_color(image: &RgbImage, style: &Value) -> Option<Value> {
    let b = &style["nominal_bounds"];
    let cx = b["x"].as_f64()? + b["width"].as_f64()? / 2.;
    let left = (cx - 35.).max(0.) as u32;
    let right = (cx + 35.).min(image.width() as f64) as u32;
    let top = (b["y"].as_f64()? + 6.).max(0.) as u32;
    let bottom = (b["y"].as_f64()? + b["height"].as_f64()? - 6.).min(image.height() as f64) as u32;
    let mut modes = std::collections::BTreeMap::<[u8; 3], usize>::new();
    for y in top..bottom {
        for x in left..right {
            let p = image.get_pixel(x, y).0;
            if p.iter().all(|v| *v < 145) {
                *modes.entry(p.map(|v| v / 4 * 4)).or_default() += 1;
            }
        }
    }
    modes
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(rgb, _)| json!(rgb))
}
fn flat_edges(image: &RgbImage, b: &Value, spec: &Value, radius: f64) -> bool {
    let (x, y, w, h) = (
        b["x"].as_u64().unwrap() as u32,
        b["y"].as_u64().unwrap() as u32,
        b["width"].as_u64().unwrap() as u32,
        b["height"].as_u64().unwrap() as u32,
    );
    let r = (radius.ceil() as u32).min(w / 3).min(h / 3);
    if w <= 2 * r + 2 || h <= 2 * r + 2 {
        return false;
    }
    let mut good = [0usize; 4];
    let mut total = [0usize; 4];
    for xx in x + r..x + w - r {
        for (i, yy) in [(0, y + 1), (1, y + h - 2)] {
            total[i] += 1;
            good[i] += usize::from(background_matches(image.get_pixel(xx, yy).0, spec));
        }
    }
    for yy in y + r..y + h - r {
        for (i, xx) in [(2, x + 1), (3, x + w - 2)] {
            total[i] += 1;
            good[i] += usize::from(background_matches(image.get_pixel(xx, yy).0, spec));
        }
    }
    (0..4).all(|i| total[i] > 0 && good[i] as f64 / total[i] as f64 >= 0.55)
}
fn outside_horizontal_edges(image: &RgbImage, b: &Value, spec: &Value, radius: f64) -> bool {
    let (x, y, w, h) = (
        b["x"].as_u64().unwrap() as u32,
        b["y"].as_u64().unwrap() as u32,
        b["width"].as_u64().unwrap() as u32,
        b["height"].as_u64().unwrap() as u32,
    );
    let r = radius.ceil() as u32;
    if y < 2 || y + h + 2 >= image.height() || w <= 2 * r {
        return false;
    }
    [y - 2, y + h + 1].into_iter().all(|yy| {
        let same = (x + r..x + w - r)
            .filter(|xx| background_matches(image.get_pixel(*xx, yy).0, spec))
            .count();
        same as f64 / f64::from(w - 2 * r) < 0.5
    })
}
fn source_ink_coverage(image: &RgbImage, b: &Value, spec: &Value) -> bool {
    let t = std::array::from_fn::<_, 3, _>(|c| spec["status_rgb"][c].as_f64().unwrap_or(0.));
    let (x, y, w, h) = (
        b["x"].as_u64().unwrap() as u32,
        b["y"].as_u64().unwrap() as u32,
        b["width"].as_u64().unwrap() as u32,
        b["height"].as_u64().unwrap() as u32,
    );
    let mut known = 0usize;
    let mut total = 0usize;
    for yy in y + 3..y + h - 3 {
        for xx in x + 3..x + w - 3 {
            let p = image.get_pixel(xx, yy).0;
            let supported = [0., 28.].into_iter().any(|fg| {
                let v = t.map(|c| c - fg);
                let length = v.iter().map(|c| c * c).sum::<f64>();
                if length <= 0. {
                    return false;
                }
                let scale = ((0..3).map(|c| (f64::from(p[c]) - fg) * v[c]).sum::<f64>() / length)
                    .clamp(0., 1.05);
                (0..3).all(|c| (f64::from(p[c]) - (fg + scale * v[c])).abs() <= 12.)
            });
            known += usize::from(supported);
            total += 1;
        }
    }
    total > 0 && known as f64 / total as f64 >= 0.9
}

fn refine_edges(image: &RgbImage, b: &Value, spec: &Value, radius: f64) -> Option<Value> {
    let (x, y, w, h) = (
        b["x"].as_u64()? as u32,
        b["y"].as_u64()? as u32,
        b["width"].as_u64()? as u32,
        b["height"].as_u64()? as u32,
    );
    let mut best = None;
    let mut area = 0;
    for l in 0..=4 {
        for t in 0..=8 {
            for r in 0..=4 {
                for bottom in 0..=4 {
                    if w <= l + r + 24 || h <= t + bottom + 20 {
                        continue;
                    }
                    let candidate = json!({"x":x+l,"y":y+t,"width":w-l-r,"height":h-t-bottom});
                    let size = (w - l - r) * (h - t - bottom);
                    if f64::from(h - t - bottom)
                        > spec["style_max_height"].as_f64().unwrap_or(1000.)
                    {
                        continue;
                    }
                    if size > area
                        && flat_edges(image, &candidate, spec, radius)
                        && outside_horizontal_edges(image, &candidate, spec, radius)
                        && source_ink_coverage(image, &candidate, spec)
                    {
                        area = size;
                        best = Some(candidate);
                    }
                }
            }
        }
    }
    best
}

fn dark_overlay_has_boundary(image: &RgbImage, b: &Value) -> bool {
    let (x, y, w, h) = (
        b["x"].as_u64().unwrap() as i32,
        b["y"].as_u64().unwrap() as i32,
        b["width"].as_u64().unwrap() as i32,
        b["height"].as_u64().unwrap() as i32,
    );
    let mut inside = Vec::new();
    let mut outside = Vec::new();
    for yy in y + h / 3..y + 2 * h / 3 {
        for (interior, xx) in [
            (true, x + 3),
            (true, x + w - 4),
            (false, x - 3),
            (false, x + w + 3),
        ] {
            if xx >= 0 && xx < image.width() as i32 && yy >= 0 && yy < image.height() as i32 {
                let target = if interior { &mut inside } else { &mut outside };
                target.push(
                    image
                        .get_pixel(xx as u32, yy as u32)
                        .0
                        .iter()
                        .map(|v| u32::from(*v))
                        .sum::<u32>(),
                );
            }
        }
    }
    if inside.is_empty() || outside.is_empty() {
        return false;
    }
    inside.sort();
    outside.sort();
    outside[outside.len() / 2] as f64 > inside[inside.len() / 2] as f64 * 1.45
}
fn overlay_edges(image: &RgbImage, b: &Value, radius: f64) -> Option<f64> {
    let (x, y, w, h) = (
        b["x"].as_i64()? as i32,
        b["y"].as_i64()? as i32,
        b["width"].as_i64()? as i32,
        b["height"].as_i64()? as i32,
    );
    let r = radius.ceil() as i32 + 1;
    if x < 4
        || y < 4
        || x + w + 4 >= image.width() as i32
        || y + h + 4 >= image.height() as i32
        || w < 2 * r + 2
        || h < 2 * r + 2
    {
        return None;
    }
    let mut good = [0usize; 4];
    let mut total = [0usize; 4];
    let mut drops = [0f64; 4];
    let mut sample = |side: usize, ix: i32, iy: i32, ox: i32, oy: i32| {
        let inside = image
            .get_pixel(ix as u32, iy as u32)
            .0
            .iter()
            .map(|v| f64::from(*v))
            .sum::<f64>();
        let outside = image
            .get_pixel(ox as u32, oy as u32)
            .0
            .iter()
            .map(|v| f64::from(*v))
            .sum::<f64>();
        total[side] += 1;
        drops[side] += (outside - inside).max(0.);
        if outside > inside * 1.2 && outside - inside > 9. {
            good[side] += 1;
        }
    };
    for xx in x + r..x + w - r {
        sample(0, xx, y + 3, xx, y - 3);
        sample(1, xx, y + h - 4, xx, y + h + 3);
    }
    for yy in y + r..y + h - r {
        sample(2, x + 3, yy, x - 3, yy);
        sample(3, x + w - 4, yy, x + w + 3, yy);
    }
    let support = std::array::from_fn::<_, 4, _>(|i| good[i] as f64 / total[i].max(1) as f64);
    if support[2] < 0.35 || support[3] < 0.35 || support.iter().filter(|v| **v >= 0.45).count() < 3
    {
        return None;
    }
    Some(
        (0..4)
            .map(|i| support[i] * 30. + drops[i] / total[i].max(1) as f64)
            .sum(),
    )
}
fn fit_overlay(image: &RgbImage, style: &Value) -> Option<Value> {
    let b = &style["nominal_bounds"];
    let x = b["x"].as_f64()?;
    let y = b["y"].as_f64()?;
    let width = b["width"].as_f64()?;
    let height = b["height"].as_f64()?;
    let nominal = json!({"x":x.floor()as i64,"y":y.floor()as i64,"width":(x+width).ceil()as i64-x.floor()as i64,"height":(y+height).ceil()as i64-y.floor()as i64});
    if !dark_overlay_has_boundary(image, &nominal) {
        return None;
    }
    let center = style["anchor"]["x"].as_f64()?;
    let bottom = style["anchor"]["y"].as_f64()?;
    let radius = style["radius"].as_f64()?;
    let mut best = None;
    let mut score = 0.;
    for w in (width * 0.85).floor() as i32
        ..=(width.ceil() as i32 + 2).min(style["max_width"].as_f64()? as i32)
    {
        for h in (height.floor() as i32 - 2)..=(height.ceil() as i32 + 2) {
            for cx in -2i32..=2 {
                for by in -3i32..=3 {
                    let x = (center + f64::from(cx) - f64::from(w) / 2.).round() as i32;
                    let y = (bottom + f64::from(by) - f64::from(h)).round() as i32;
                    let candidate = json!({"x":x,"y":y,"width":w,"height":h});
                    if let Some(quality) = overlay_edges(image, &candidate, radius) {
                        let quality = quality - f64::from(cx.abs() + by.abs()) * 0.1;
                        if quality > score {
                            score = quality;
                            best = Some(candidate);
                        }
                    }
                }
            }
        }
    }
    best
}

pub fn resolve(image: &DynamicImage, region: &Value) -> LabResult<Value> {
    let owned;
    let rgb = if let Some(rgb) = image.as_rgb8() {
        rgb
    } else {
        owned = image.to_rgb8();
        &owned
    };
    let source = &region["localizer"];
    let styles = source["styles"]
        .as_array()
        .ok_or_else(|| bad("Missing source status styles"))?;
    let mut matches = Vec::<(Value, f64)>::new();
    let mut partial = false;
    for style in styles {
        if style["background_alpha"].as_f64().unwrap_or(1.) < 1. {
            if let Some(candidate) = fit_overlay(rgb, style) {
                let radius = style["radius"].as_f64().unwrap();
                if !matches.iter().any(|(old, _)| *old == candidate) {
                    matches.push((candidate, radius));
                }
            }
            continue;
        }
        let mut spec = source.clone();
        spec["kind"] = json!("status_fill");
        spec["status_rgb"] = style["background_rgb"].clone();
        spec["foreground"] = style["foreground"].clone();
        spec["style_max_height"] = style["max_height"].clone();
        if style["background_alpha"].as_f64().unwrap_or(1.) < 1. {
            let Some(color) = composite_color(rgb, style) else {
                continue;
            };
            spec["status_rgb"] = color;
            spec["composite"] = json!(true);
        }
        spec["min_height"] = json!(8);
        spec["max_height"] = source["search_bounds"]["height"].clone();
        for candidate in super::panels::candidates(rgb, &spec)? {
            let x = candidate["x"].as_f64().unwrap();
            let y = candidate["y"].as_f64().unwrap();
            let w = candidate["width"].as_f64().unwrap();
            let h = candidate["height"].as_f64().unwrap();
            if (x + w / 2. - style["anchor"]["x"].as_f64().unwrap()).abs()
                <= style["max_width"].as_f64().unwrap_or(220.) / 2.
                && (y + h - style["anchor"]["y"].as_f64().unwrap()).abs() <= 7.
            {
                partial = true;
            }
            if h < style["min_height"].as_f64().unwrap_or(24.)
                || h > style["max_height"].as_f64().unwrap_or(74.) + 8.
            {
                continue;
            }
            if (x + w / 2. - style["anchor"]["x"].as_f64().unwrap()).abs() > 8.
                || (y + h - style["anchor"]["y"].as_f64().unwrap()).abs() > 7.
                || w > style["max_width"].as_f64().unwrap_or(220.)
            {
                continue;
            }
            let radius = style["radius"]
                .as_f64()
                .ok_or_else(|| bad("Missing status corner radius"))?;
            let cx = style["anchor"]["x"].as_f64().unwrap();
            let left = candidate["x"].as_f64().unwrap();
            let right = left + candidate["width"].as_f64().unwrap();
            let half = (cx - left).min(right - cx);
            let mut centered = candidate.clone();
            if half > 12. {
                centered["x"] = json!((cx - half).floor() as i64);
                centered["width"] = json!((cx + half).ceil() as i64 - (cx - half).floor() as i64);
            }
            let Some(candidate) = refine_edges(rgb, &centered, &spec, radius) else {
                continue;
            };
            if spec["composite"] == true && !dark_overlay_has_boundary(rgb, &candidate) {
                continue;
            }
            if !matches.iter().any(|(old, _)| *old == candidate) {
                matches.push((candidate, radius));
            }
        }
    }
    if matches.len() > 1 {
        return Err(bad("Multiple status announcements overlap this seat slot"));
    }
    let Some((b, radius)) = matches.pop() else {
        if partial {
            return Err(bad(
                "A status panel is clipped, occluded, or does not match its source shape",
            ));
        }
        let mut absent = region.clone();
        absent.as_object_mut().unwrap().remove("localizer");
        absent["localization"] =
            json!({"policy":"source_status_panels_v1","state":"original_negative_slot"});
        return Ok(absent);
    };
    let (x, y, w, h) = (
        b["x"].as_f64().unwrap(),
        b["y"].as_f64().unwrap(),
        b["width"].as_f64().unwrap(),
        b["height"].as_f64().unwrap(),
    );
    let mut result = region.clone();
    result.as_object_mut().unwrap().remove("localizer");
    result["bounds"] = b.clone();
    result["polygon"] = json!([{"x":x,"y":y},{"x":x+w,"y":y},{"x":x+w,"y":y+h},{"x":x,"y":y+h}]);
    result["rotation"] = json!(0);
    result["guide"] = json!({"slot":b,"anchor":{"x":x+w/2.,"y":y+h/2.},"alignment":"center","family":"status","source":"pixel_panel"});
    result["localization"] =
        json!({"policy":"source_status_panels_v1","panels":[b],"corner_radius":radius});
    Ok(result)
}
