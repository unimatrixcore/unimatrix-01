use crate::lab::{bad, LabResult};
use image::{DynamicImage, RgbImage};
use serde_json::{json, Value};

fn dark(pixel: &image::Rgb<u8>) -> bool {
    let [r, g, b] = pixel.0;
    r <= 100
        && g <= 120
        && b <= 140
        && u16::from(g) >= u16::from(r) + 6
        && u16::from(b) >= u16::from(g) + 5
}

fn currency_badge(pixel: [u8; 3]) -> bool {
    let [r, g, b] = pixel.map(u16::from);
    (g > r + 35 && g > b + 60) || (r > g + 20 && g > b + 50 && r > 120 && g > 80)
}

// Detect the straight edges of wrapped source pills even when chip artwork
// touches their dark fill. Return None for a single row, which uses the
// existing connected-component path.
fn wrapped_panels(image: &RgbImage, spec: &Value) -> Option<LabResult<Vec<Value>>> {
    let center_x = spec["row_center_x"].as_f64()?;
    let center_y = spec["row_center_y"].as_f64()?;
    let pitch = spec["row_pitch"].as_f64()?;
    let width = spec["row_width"].as_f64()?;
    let gap = spec["chip_gap"].as_f64()?;
    let height = spec["panel_height"].as_f64()?.round() as i32;
    if !(20..=46).contains(&height) || pitch <= f64::from(height) || width <= 0. {
        return Some(Err(bad("Invalid split-pot source layout")));
    }
    let b = &spec["search_bounds"];
    let left = (center_x - width / 2.).floor().max(0.) as i32;
    let right = (center_x + width / 2.).ceil().min(f64::from(image.width())) as i32;
    let top = b["y"].as_f64()?.floor().max(0.) as i32;
    let bottom = (b["y"].as_f64()? + b["height"].as_f64()?)
        .ceil()
        .min(f64::from(image.height())) as i32;
    if right <= left || bottom - top < height {
        return Some(Err(bad("Invalid split-pot search area")));
    }
    let mut runs = Vec::<Vec<(i32, i32)>>::new();
    for y in top..bottom {
        let mut row = Vec::new();
        let mut start = None;
        for x in left..=right {
            let on = x < right && dark(image.get_pixel(x as u32, y as u32));
            if on && start.is_none() {
                start = Some(x);
            } else if !on {
                if let Some(l) = start.take() {
                    if x - l >= 30 {
                        row.push((l, x));
                    }
                }
            }
        }
        runs.push(row);
    }
    let inset = (f64::from(height) / 10.).round() as i32;
    let mut found = Vec::<(i32, i32, i32, i32)>::new();
    for y in top..bottom - height + 1 {
        for &(l, r) in &runs[(y - top) as usize] {
            for &(ll, rr) in &runs[(y + height - 2 - top) as usize] {
                if (l - ll).abs() > inset * 2 + 2 || (r - rr).abs() > inset * 2 + 2 {
                    continue;
                }
                let x = l.max(ll) - inset;
                let end = r.min(rr) + inset;
                if x <= left || end >= right {
                    continue;
                }
                let mut badges = 0;
                for yy in y + 2..y + height - 3 {
                    for xx in x..(x + height + inset * 2).min(end) {
                        badges +=
                            usize::from(currency_badge(image.get_pixel(xx as u32, yy as u32).0));
                    }
                }
                if badges < 40 {
                    continue;
                }
                if found.iter().any(|&(px, py, pr, _)| {
                    (px - x).abs() <= 2 && (pr - end).abs() <= 2 && (py - y).abs() <= 2
                }) {
                    continue;
                }
                found.push((x, y, end, y + height));
            }
        }
    }
    if spec["upper_pot_bounds"].is_object() {
        let upper = &spec["upper_pot_bounds"];
        let (x, y, w, h) = (
            upper["x"].as_f64().unwrap_or(-1.),
            upper["y"].as_f64().unwrap_or(-1.),
            upper["width"].as_f64().unwrap_or(0.),
            upper["height"].as_f64().unwrap_or(0.),
        );
        found.retain(|p| {
            !(f64::from(p.0) < x + w
                && x < f64::from(p.2)
                && f64::from(p.1) < y + h
                && y < f64::from(p.3))
        });
    }
    if let Some(exclusions) = spec["excluded_bounds"].as_array() {
        found.retain(|p| {
            !exclusions.iter().any(|other| {
                let (x, y, w, h) = (
                    other["x"].as_f64().unwrap_or(-1.),
                    other["y"].as_f64().unwrap_or(-1.),
                    other["width"].as_f64().unwrap_or(0.),
                    other["height"].as_f64().unwrap_or(0.),
                );
                f64::from(p.0) < x + w
                    && x < f64::from(p.2)
                    && f64::from(p.1) < y + h
                    && y < f64::from(p.3)
            })
        });
    }
    for count in (1..=10).rev() {
        let mut rows = Vec::new();
        for index in 0..count {
            let expected = center_y + (index as f64 - (count - 1) as f64 / 2.) * pitch;
            let mut row = found
                .iter()
                .copied()
                .filter(|p| (f64::from(p.1) + f64::from(height) / 2. - expected).abs() <= 2.)
                .collect::<Vec<_>>();
            row.sort_by_key(|p| p.0);
            if row.is_empty() {
                rows.clear();
                break;
            }
            rows.push(row);
        }
        if rows.is_empty() {
            continue;
        }
        for (index, row) in rows.iter().enumerate() {
            let l = row.first().unwrap().0;
            let r = row.last().unwrap().2;
            if ((f64::from(l + r) / 2.) - center_x).abs()
                > spec["row_center_tolerance"].as_f64().unwrap_or(12.)
            {
                return Some(Err(bad("Split-pot row is incomplete or occluded")));
            }
            if row
                .windows(2)
                .any(|pair| f64::from(pair[1].0 - pair[0].2) > gap + f64::from(inset * 2 + 2))
            {
                return Some(Err(bad("Split-pot row has an unresolved panel")));
            }
            if let Some(next) = rows.get(index + 1) {
                let next_width = next[0].2 - next[0].0;
                if width - f64::from(r - l) >= f64::from(next_width) + gap * 2. {
                    return Some(Err(bad("Split-pot wrapping is incomplete or occluded")));
                }
            }
            if let Some(exclusions) = spec["excluded_bounds"].as_array() {
                if exclusions.iter().any(|other| {
                    let ox = other["x"].as_f64().unwrap_or(-1.);
                    let oy = other["y"].as_f64().unwrap_or(-1.);
                    let (row_left, row_right) = if count == 1 { (l, r) } else { (left, right) };
                    ox < f64::from(row_right)
                        && ox + other["width"].as_f64().unwrap_or(0.) > f64::from(row_left)
                        && oy < f64::from(row[0].3)
                        && oy + other["height"].as_f64().unwrap_or(0.) > f64::from(row[0].1)
                }) {
                    return Some(Err(bad("Player bet overlaps the split-pot row")));
                }
            }
        }
        let panels: Vec<Value> = rows
            .into_iter()
            .flatten()
            .map(|(x, y, r, b)| json!({"x":x,"y":y,"width":r-x,"height":b-y}))
            .collect();
        if panels.len() > 10 {
            return Some(Err(bad("Ambiguous split-pot panel count")));
        }
        if count == 1 {
            if let Ok(existing) = candidates(image, spec) {
                if existing.len() == panels.len() {
                    return None;
                }
            }
        }
        return Some(Ok(panels));
    }
    if found
        .iter()
        .any(|panel| (f64::from(panel.1) + f64::from(height) / 2. - center_y).abs() > pitch / 4.)
    {
        return Some(Err(bad("Split-pot rows are incomplete or occluded")));
    }
    None
}
fn empty_original_slot(image: &RgbImage, b: &Value) -> bool {
    let (x, y, w, h) = (
        b["x"].as_f64().unwrap_or(0.).floor() as u32,
        b["y"].as_f64().unwrap_or(0.).floor() as u32,
        b["width"].as_f64().unwrap_or(0.).ceil() as u32,
        b["height"].as_f64().unwrap_or(0.).ceil() as u32,
    );
    let (mut marked, mut foreground) = (0, 0);
    for yy in y..(y + h).min(image.height()) {
        for xx in x..(x + w).min(image.width()) {
            let p = image.get_pixel(xx, yy).0;
            marked += usize::from(currency_badge(p));
            foreground += usize::from(p.iter().all(|v| *v >= 150));
        }
    }
    marked < 40 && foreground < 15
}

pub fn candidates(image: &RgbImage, spec: &Value) -> LabResult<Vec<Value>> {
    let b = &spec["search_bounds"];
    let x = b["x"].as_f64().unwrap_or(-1.).floor() as i32;
    let y = b["y"].as_f64().unwrap_or(-1.).floor() as i32;
    let right = (b["x"].as_f64().unwrap_or(-1.) + b["width"].as_f64().unwrap_or(0.)).ceil() as i32;
    let bottom =
        (b["y"].as_f64().unwrap_or(-1.) + b["height"].as_f64().unwrap_or(0.)).ceil() as i32;
    if x < 0
        || y < 0
        || right > image.width() as i32
        || bottom > image.height() as i32
        || right <= x
        || bottom <= y
    {
        return Err(bad("Panel search area is outside the1920frame"));
    }
    let (w, h) = ((right - x) as usize, (bottom - y) as usize);
    let text_line = spec["kind"] == "text_line";
    let mut modes = std::collections::BTreeMap::<u8, usize>::new();
    if text_line {
        for yy in y..bottom {
            for xx in x..right {
                let p = image.get_pixel(xx as u32, yy as u32).0;
                let gray = ((u16::from(p[0]) + u16::from(p[1]) + u16::from(p[2])) / 3) as u8;
                *modes.entry(gray).or_default() += 1;
            }
        }
    }
    let background = modes
        .iter()
        .max_by_key(|(_, n)| **n)
        .map(|(v, _)| *v)
        .unwrap_or(0);
    let classified = |pixel: &image::Rgb<u8>| {
        if spec["kind"] == "status_fill" {
            return super::status::background_matches(pixel.0, spec);
        }
        if text_line {
            let lo = *pixel.0.iter().min().unwrap();
            let hi = *pixel.0.iter().max().unwrap();
            hi - lo <= 35 && u16::from(lo) > u16::from(background) + 12
        } else {
            dark(pixel)
        }
    };
    let mut visited = vec![false; w * h];
    let mut panels = Vec::new();
    let min_h = spec["min_height"].as_f64().unwrap_or(15.);
    let max_h = spec["max_height"].as_f64().unwrap_or(48.);
    for start in 0..visited.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let sx = start % w;
        let sy = start / w;
        if !classified(image.get_pixel((x + sx as i32) as u32, (y + sy as i32) as u32)) {
            continue;
        }
        let mut stack = vec![(sx, sy)];
        let (mut lx, mut rx, mut ty, mut by, mut count) = (sx, sx, sy, sy, 0usize);
        while let Some((cx, cy)) = stack.pop() {
            count += 1;
            lx = lx.min(cx);
            rx = rx.max(cx);
            ty = ty.min(cy);
            by = by.max(cy);
            for (nx, ny) in [
                (cx as i32 - 1, cy as i32),
                (cx as i32 + 1, cy as i32),
                (cx as i32, cy as i32 - 1),
                (cx as i32, cy as i32 + 1),
            ] {
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let index = ny as usize * w + nx as usize;
                if visited[index] {
                    continue;
                }
                visited[index] = true;
                if classified(image.get_pixel((x + nx) as u32, (y + ny) as u32)) {
                    stack.push((nx as usize, ny as usize));
                }
            }
        }
        let (pw, ph) = (rx - lx + 1, by - ty + 1);
        if (ph as f64) < min_h
            || (ph as f64) > max_h
            || pw < if text_line { 1 } else { 24 }
            || count * if text_line { 12 } else { 5 } < pw * ph
        {
            continue;
        }
        if lx == 0 || rx + 1 == w || ty == 0 || by + 1 == h {
            continue;
        }
        let mut foreground = 0;
        for yy in ty..=by {
            for xx in lx..=rx {
                let p = image.get_pixel((x + xx as i32) as u32, (y + yy as i32) as u32);
                if if spec["kind"] == "status_fill" && spec["foreground"] == "dark" {
                    p.0.iter().all(|v| *v < 90)
                } else {
                    p.0.iter().all(|v| *v >= 150)
                } {
                    foreground += 1;
                }
            }
        }
        if !text_line && foreground < 4 {
            continue;
        }
        if spec["require_currency_badge"] == true || spec["max_currency_badges"].as_u64().is_some()
        {
            let mut green_seen = vec![false; pw * ph];
            let mut badges = 0;
            for yy in 0..ph {
                for xx in 0..pw {
                    let n = yy * pw + xx;
                    if green_seen[n] {
                        continue;
                    }
                    green_seen[n] = true;
                    let green = |xx: usize, yy: usize| {
                        let p = image
                            .get_pixel(
                                (x + lx as i32 + xx as i32) as u32,
                                (y + ty as i32 + yy as i32) as u32,
                            )
                            .0;
                        currency_badge(p)
                    };
                    if !green(xx, yy) {
                        continue;
                    }
                    let mut work = vec![(xx, yy)];
                    let mut area = 0;
                    while let Some((gx, gy)) = work.pop() {
                        area += 1;
                        for (nx, ny) in [
                            (gx as i32 - 1, gy as i32),
                            (gx as i32 + 1, gy as i32),
                            (gx as i32, gy as i32 - 1),
                            (gx as i32, gy as i32 + 1),
                        ] {
                            if nx < 0 || ny < 0 || nx >= pw as i32 || ny >= ph as i32 {
                                continue;
                            }
                            let k = ny as usize * pw + nx as usize;
                            if green_seen[k] {
                                continue;
                            }
                            green_seen[k] = true;
                            if green(nx as usize, ny as usize) {
                                work.push((nx as usize, ny as usize));
                            }
                        }
                    }
                    if area >= 40 {
                        badges += 1;
                    }
                }
            }
            if (spec["require_currency_badge"] == true
                && (if spec["kind"] == "pot_row" {
                    badges == 0
                } else {
                    badges != 1
                }))
                || spec["max_currency_badges"]
                    .as_u64()
                    .is_some_and(|max| badges > max as usize)
            {
                continue;
            }
        }
        panels.push(json!({"x":x+lx as i32,"y":y+ty as i32,"width":pw,"height":ph}));
    }
    panels.sort_by(|a, b| {
        a["y"]
            .as_i64()
            .cmp(&b["y"].as_i64())
            .then(a["x"].as_i64().cmp(&b["x"].as_i64()))
    });
    Ok(panels)
}

pub fn resolve(image: &DynamicImage, region: &Value) -> LabResult<Value> {
    let spec = &region["localizer"];
    if spec.is_null() {
        return Ok(region.clone());
    }
    if spec["kind"] == "status_panel" {
        return super::status::resolve(image, region);
    }
    if image.width() != 1920 || image.height() != 1080 {
        return Err(bad("Panel localization requires1920x1080pixels"));
    }
    let owned;
    let rgb = if let Some(rgb) = image.as_rgb8() {
        rgb
    } else {
        owned = image.to_rgb8();
        &owned
    };
    let mut panels = if spec["kind"] == "pot_row" {
        match wrapped_panels(rgb, spec) {
            Some(result) => result?,
            None => candidates(rgb, spec)?,
        }
    } else {
        candidates(rgb, spec)?
    };
    if let Some(exclusions) = spec["excluded_bounds"].as_array() {
        panels.retain(|panel| {
            !exclusions.iter().any(|other| {
                let x = panel["x"].as_f64().unwrap();
                let y = panel["y"].as_f64().unwrap();
                let ox = other["x"].as_f64().unwrap();
                let oy = other["y"].as_f64().unwrap();
                x < ox + other["width"].as_f64().unwrap()
                    && ox < x + panel["width"].as_f64().unwrap()
                    && y < oy + other["height"].as_f64().unwrap()
                    && oy < y + panel["height"].as_f64().unwrap()
            })
        });
    }
    let observed = panels.clone();
    let selected = if spec["kind"] == "text_line" {
        if panels.is_empty() {
            return Err(bad("No isolated table text line"));
        }
        let left = panels
            .iter()
            .map(|p| p["x"].as_i64().unwrap())
            .min()
            .unwrap()
            - 2;
        let top = panels
            .iter()
            .map(|p| p["y"].as_i64().unwrap())
            .min()
            .unwrap()
            - 2;
        let right = panels
            .iter()
            .map(|p| p["x"].as_i64().unwrap() + p["width"].as_i64().unwrap())
            .max()
            .unwrap()
            + 2;
        let bottom = panels
            .iter()
            .map(|p| p["y"].as_i64().unwrap() + p["height"].as_i64().unwrap())
            .max()
            .unwrap()
            + 2;
        json!({"x":left,"y":top,"width":right-left,"height":bottom-top})
    } else if spec["kind"] == "pot_row" {
        if panels.is_empty() {
            if spec["empty_slot_fallback"] == true && empty_original_slot(rgb, &region["bounds"]) {
                let mut old = region.clone();
                old.as_object_mut().unwrap().remove("localizer");
                old["localization"] =
                    json!({"policy":"baseline_field_panels_v3","state":"original_negative_slot"});
                return Ok(old);
            }
            return Err(bad("No isolated pot row"));
        }
        if panels.len() > 10 {
            return Err(bad("Ambiguous pot row"));
        }
        let left = panels
            .iter()
            .map(|p| p["x"].as_i64().unwrap())
            .min()
            .unwrap();
        let top = panels
            .iter()
            .map(|p| p["y"].as_i64().unwrap())
            .min()
            .unwrap();
        let right = panels
            .iter()
            .map(|p| p["x"].as_i64().unwrap() + p["width"].as_i64().unwrap())
            .max()
            .unwrap();
        let bottom = panels
            .iter()
            .map(|p| p["y"].as_i64().unwrap() + p["height"].as_i64().unwrap())
            .max()
            .unwrap();
        if let Some(center) = spec["row_center_x"].as_f64() {
            let tolerance = spec["row_center_tolerance"].as_f64().unwrap_or(12.);
            let mut rows: Vec<Vec<&Value>> = Vec::new();
            for panel in &panels {
                if let Some(row) = rows.iter_mut().find(|row| {
                    (row[0]["y"].as_f64().unwrap() - panel["y"].as_f64().unwrap()).abs() <= 3.
                }) {
                    row.push(panel);
                } else {
                    rows.push(vec![panel]);
                }
            }
            for row in rows {
                let l = row
                    .iter()
                    .map(|p| p["x"].as_f64().unwrap())
                    .fold(f64::INFINITY, f64::min);
                let r = row
                    .iter()
                    .map(|p| p["x"].as_f64().unwrap() + p["width"].as_f64().unwrap())
                    .fold(f64::NEG_INFINITY, f64::max);
                if ((l + r) / 2. - center).abs() > tolerance {
                    return Err(bad("Split-pot row is not aligned with its source group"));
                }
            }
        }
        json!({"x":left,"y":top,"width":right-left,"height":bottom-top})
    } else {
        let anchor = &spec["anchor"];
        let ax = anchor["x"]
            .as_f64()
            .ok_or_else(|| bad("Missing panel anchor"))?;
        let ay = anchor["y"]
            .as_f64()
            .ok_or_else(|| bad("Missing panel anchor"))?;
        let alignment = spec["alignment"].as_str().unwrap_or("center");
        let matches = panels
            .into_iter()
            .filter(|p| {
                let px = p["x"].as_f64().unwrap();
                let py = p["y"].as_f64().unwrap();
                let pw = p["width"].as_f64().unwrap();
                let ph = p["height"].as_f64().unwrap();
                let edge = match alignment {
                    "left" => px,
                    "right" => px + pw,
                    _ => px + pw / 2.,
                };
                (edge - ax).abs() <= spec["anchor_tolerance"].as_f64().unwrap_or(8.)
                    && ay >= py - 2.
                    && ay <= py + ph + 2.
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            if observed.is_empty() && spec["empty_slot_fallback"] == true {
                if empty_original_slot(rgb, &region["bounds"]) {
                    let mut old = region.clone();
                    old.as_object_mut().unwrap().remove("localizer");
                    old["localization"] = json!({"policy":"baseline_field_panels_v3","state":"original_negative_slot"});
                    return Ok(old);
                }
            }
            if spec["allow_pause_text"] == true && observed.is_empty() {
                let mut pause = region.clone();
                pause["localizer"]["kind"] = json!("text_line");
                pause["localizer"]["min_height"] = json!(8);
                pause["localizer"]["max_height"] = json!(40);
                pause["localizer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("max_currency_badges");
                pause["localizer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("allow_pause_text");
                return resolve(image, &pause);
            }
            return Err(bad("Panel is missing, merged, clipped, or ambiguous"));
        }
        matches[0].clone()
    };
    let x = selected["x"].as_f64().unwrap();
    let y = selected["y"].as_f64().unwrap();
    let w = selected["width"].as_f64().unwrap();
    let h = selected["height"].as_f64().unwrap();
    let mut resolved = region.clone();
    resolved.as_object_mut().unwrap().remove("localizer");
    resolved["bounds"] = selected.clone();
    resolved["polygon"] = json!([{"x":x,"y":y},{"x":x+w,"y":y},{"x":x+w,"y":y+h},{"x":x,"y":y+h}]);
    resolved["rotation"] = json!(0);
    resolved["localization"] = json!({"policy":"baseline_field_panels_v3","bounds":selected,"search_bounds":spec["search_bounds"],"kind":spec["kind"],"panels":if spec["kind"]=="pot_row"{json!(observed)}else{json!([selected])}});
    resolved["guide"] = json!({"slot":selected,"anchor":{"x":x+w/2.,"y":y+h/2.},"alignment":"center","family":region["guide"]["family"],"source":"pixel_panel"});
    Ok(resolved)
}

pub fn resolve_profile(image: &DynamicImage, profile: &Value) -> LabResult<Value> {
    resolve_profile_cancellable(image, profile, &|| false)
}
pub fn resolve_profile_cancellable(
    image: &DynamicImage,
    profile: &Value,
    cancelled: &dyn Fn() -> bool,
) -> LabResult<Value> {
    let check = || {
        if cancelled() {
            Err(bad("Gameplay preparation cancelled"))
        } else {
            Ok(())
        }
    };
    check()?;
    let rgb_image;
    let image = if image.as_rgb8().is_some() {
        image
    } else {
        rgb_image = DynamicImage::ImageRgb8(image.to_rgb8());
        &rgb_image
    };
    let occupied_profile = super::regions::resolve_seat_occupancy(image, profile);
    let profile = &occupied_profile;
    let mut snapshot = profile.clone();
    let mut resolved = Vec::new();
    let mut unavailable = Vec::new();
    let source_regions = profile["regions"]
        .as_array()
        .ok_or_else(|| bad("Missing source fields"))?;
    let card_rgb = image
        .as_rgb8()
        .ok_or_else(|| bad("Screenshot RGB conversion failed"))?;
    let mut pose_profile = profile.clone();
    if let Some(priors) = pose_profile["card_priors"].as_object_mut() {
        for region in source_regions
            .iter()
            .filter(|r| super::regions::seat_is_empty(r))
        {
            if let Some(id) = region["card_prior_id"].as_str() {
                priors.remove(id);
            }
        }
    }
    let card_poses = super::card_fields::poses(card_rgb, &pose_profile)?;
    let bets = source_regions
        .iter()
        .filter(|r| r["category"] == "bet" && !super::regions::seat_is_empty(r))
        .filter_map(|r| resolve(image, r).ok())
        .filter(|r| r["localization"]["state"] != "original_negative_slot")
        .map(|r| r["bounds"].clone())
        .collect::<Vec<_>>();
    let upper_pot = source_regions
        .iter()
        .find(|r| r["id"] == "pot")
        .and_then(|r| resolve(image, r).ok())
        .map(|r| r["bounds"].clone());
    for source in source_regions {
        check()?;
        let mut region = source.clone();
        if super::regions::seat_is_empty(&region) {
            resolved.push(region);
            continue;
        }
        if region["localizer"]["kind"] == "pot_row" {
            region["localizer"]["excluded_bounds"] = json!(bets);
            if let Some(bounds) = &upper_pot {
                region["localizer"]["upper_pot_bounds"] = bounds.clone();
            }
        }
        match resolve(image, &region) {
            Ok(mut field) => {
                field = match super::card_fields::resolve(card_rgb, profile, &field, &card_poses) {
                    Ok(field) => field,
                    Err(error) if field["card_prior_id"].is_string() => {
                        let mut nominal = field;
                        nominal["card_nominal_fallback_reason"] = json!(error.message);
                        nominal
                    }
                    Err(error) => return Err(error),
                };
                if !field["crop_mask_source"].is_null()
                    && field["localization"]["state"] != "original_negative_slot"
                    && !(field["category"] == "pot" && field["localization"]["kind"] == "text_line")
                {
                    let source: super::crop_mask::SourcePanel =
                        serde_json::from_value(field["crop_mask_source"].clone())?;
                    let b = &field["bounds"];
                    let origin = [
                        b["x"]
                            .as_f64()
                            .ok_or_else(|| bad("Missing mask crop origin"))?
                            .floor(),
                        b["y"]
                            .as_f64()
                            .ok_or_else(|| bad("Missing mask crop origin"))?
                            .floor(),
                    ];
                    let rectangles = if field["crop_mask_parent_bounds"].is_object() {
                        vec![field["crop_mask_parent_bounds"].clone()]
                    } else {
                        field["localization"]["panels"]
                            .as_array()
                            .cloned()
                            .unwrap_or_else(|| vec![b.clone()])
                    };
                    let rectangles = rectangles
                        .into_iter()
                        .map(serde_json::from_value::<super::crop_mask::Rect>)
                        .collect::<Result<Vec<_>, _>>()?;
                    let mut descriptor =
                        super::crop_mask::from_resolved_panels(source, origin, &rectangles)?;
                    if let Some(radius) = field["localization"]["corner_radius"].as_f64() {
                        for panel in &mut descriptor.panels {
                            panel.corners = [super::crop_mask::CornerRadius {
                                x: radius,
                                y: radius,
                            }; 4];
                        }
                    }
                    if let Some(corners) = field["crop_mask_corners"].as_array() {
                        let corners: Vec<super::crop_mask::CornerRadius> = corners
                            .iter()
                            .cloned()
                            .map(serde_json::from_value)
                            .collect::<Result<_, _>>()?;
                        let corners: [super::crop_mask::CornerRadius; 4] = corners
                            .try_into()
                            .map_err(|_| bad("Expected four source panel corners"))?;
                        for panel in &mut descriptor.panels {
                            panel.corners = corners;
                        }
                    }
                    field["crop_mask"] = serde_json::to_value(descriptor)?;
                }
                resolved.push(field)
            }
            Err(error) => {
                let mut field = region.clone();
                field["localization_error"] = json!(error.message);
                unavailable.push(json!({"id":field["id"],"reason":error.message}));
                resolved.push(field);
            }
        }
    }
    if snapshot["cv_regions"].is_object() {
        for region in &resolved {
            let Some(id) = region["id"].as_str() else {
                continue;
            };
            if id.ends_with(".suit")
                || id == "table.info"
                || !region["localization_error"].is_null()
            {
                continue;
            }
            let b = region.get("cv_bounds").unwrap_or(&region["bounds"]);
            let (Some(x), Some(y), Some(w), Some(h)) = (
                b["x"].as_f64(),
                b["y"].as_f64(),
                b["width"].as_f64(),
                b["height"].as_f64(),
            ) else {
                continue;
            };
            let rect = json!({"x":x.floor() as u32,"y":y.floor() as u32,"w":((x+w).ceil()-x.floor()) as u32,"h":((y+h).ceil()-y.floor()) as u32});
            let path = id.replace('[', ".").replace(']', "");
            let parts = path.split('.').collect::<Vec<_>>();
            let mut target = &mut snapshot["cv_regions"];
            for part in &parts[..parts.len() - 1] {
                target = if let Ok(index) = part.parse::<usize>() {
                    &mut target[index]
                } else {
                    &mut target[*part]
                };
            }
            if let Ok(index) = parts[parts.len() - 1].parse::<usize>() {
                target[index] = rect;
            } else {
                target[parts[parts.len() - 1]] = rect;
            }
        }
    }
    if profile["presence_policy"] == super::presence::POLICY {
        for field in &mut resolved {
            check()?;
            field["presence"] = super::presence::assess(image, field);
        }
    }
    snapshot["regions"] = json!(resolved);
    snapshot["unavailable_regions"] = json!(unavailable);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    #[test]
    fn cancellation_is_checked_between_source_fields_without_mutating_profile() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(20, 20, Rgb([25, 42, 53])));
        let profile = json!({"regions":[{"id":"a","category":"name","bounds":{"x":1,"y":1,"width":4,"height":4}},{"id":"b","category":"name","bounds":{"x":8,"y":1,"width":4,"height":4}}]});
        let original = profile.clone();
        let checks = std::cell::Cell::new(0);
        let error = resolve_profile_cancellable(&image, &profile, &|| {
            checks.set(checks.get() + 1);
            checks.get() >= 3
        })
        .unwrap_err();
        assert_eq!(error.message, "Gameplay preparation cancelled");
        assert_eq!(checks.get(), 3);
        assert_eq!(profile, original);
    }
    fn panel(image: &mut RgbImage, x: u32, y: u32, w: u32) {
        for yy in y..y + 30 {
            for xx in x..x + w {
                image.put_pixel(xx, yy, Rgb([25, 42, 53]));
            }
        }
        for yy in y + 5..y + 25 {
            for xx in x + 6..x + 22 {
                image.put_pixel(xx, yy, Rgb([90, 200, 0]));
            }
        }
        for yy in y + 8..y + 22 {
            for xx in x + 28..x + w - 6 {
                image.put_pixel(xx, yy, Rgb([240, 240, 240]));
            }
        }
    }
    fn field(kind: &str) -> Value {
        json!({"id":"split_pot","bounds":{"x":120.,"y":40.,"width":100.,"height":30.},"guide":{"family":"split_pot"},"localizer":{"kind":kind,"require_currency_badge":true,"search_bounds":{"x":10.,"y":20.,"width":480.,"height":100.},"anchor":{"x":250.,"y":55.},"alignment":"center","anchor_tolerance":3.,"min_height":20.,"max_height":46.}})
    }
    #[test]
    fn pixel_panel_grows_and_shrinks_without_using_the_search_window_as_crop() {
        for w in [100, 160, 210, 100] {
            let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
            panel(&mut image, 250 - w / 2, 40, w);
            let resolved = resolve(&DynamicImage::ImageRgb8(image), &field("panel")).unwrap();
            assert_eq!(resolved["bounds"]["width"], w);
            assert_eq!(resolved["bounds"]["height"], 30);
            assert_eq!(resolved["guide"]["slot"], resolved["bounds"]);
            assert!(resolved.get("localizer").is_none());
        }
    }
    #[test]
    fn split_pot_preserves_two_visible_amount_panels_as_one_logical_list() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        panel(&mut image, 80, 40, 100);
        panel(&mut image, 190, 40, 150);
        let resolved = resolve(&DynamicImage::ImageRgb8(image.clone()), &field("pot_row")).unwrap();
        assert_eq!(resolved["id"], "split_pot");
        assert_eq!(
            resolved["bounds"],
            json!({"x":80,"y":40,"width":260,"height":30})
        );
        let mut competing = field("panel");
        competing["localizer"]["anchor_tolerance"] = json!(500.);
        assert!(resolve(&DynamicImage::ImageRgb8(image), &competing).is_err());
    }
    #[test]
    fn wrapped_split_pot_keeps_all_rows_in_reading_order_and_rejects_overlap() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        for (y, xs) in [
            (80, vec![288, 396, 504, 612]),
            (126, vec![288, 396, 504, 612]),
            (172, vec![396, 504]),
        ] {
            for x in xs {
                panel(&mut image, x, y, 100);
            }
        }
        let mut f = field("pot_row");
        f["localizer"]["search_bounds"] = json!({"x":260,"y":60,"width":480,"height":170});
        f["localizer"]["row_center_x"] = json!(500.);
        f["localizer"]["row_center_y"] = json!(141.);
        f["localizer"]["row_pitch"] = json!(46.);
        f["localizer"]["row_width"] = json!(440.);
        f["localizer"]["chip_gap"] = json!(8.);
        f["localizer"]["panel_height"] = json!(30.);
        let resolved = resolve(&DynamicImage::ImageRgb8(image.clone()), &f).unwrap();
        let panels = resolved["localization"]["panels"].as_array().unwrap();
        assert_eq!(panels.len(), 10);
        assert!(panels
            .windows(2)
            .all(|pair| (pair[0]["y"].as_i64(), pair[0]["x"].as_i64())
                <= (pair[1]["y"].as_i64(), pair[1]["x"].as_i64())));
        let mut missing = image.clone();
        for y in 80..110 {
            for x in 396..496 {
                missing.put_pixel(x, y, Rgb([60, 60, 60]));
            }
        }
        assert!(resolve(&DynamicImage::ImageRgb8(missing), &f).is_err());
        f["localizer"]["excluded_bounds"] = json!([{"x":270,"y":80,"width":40,"height":30}]);
        assert!(resolve(&DynamicImage::ImageRgb8(image), &f).is_err());
    }
    #[test]
    fn merged_or_edge_cut_amounts_never_fall_back_to_a_large_search_crop() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        panel(&mut image, 200, 40, 100);
        panel(&mut image, 300, 40, 100);
        let mut f = field("panel");
        f["localizer"]["empty_slot_fallback"] = json!(true);
        assert!(resolve(&DynamicImage::ImageRgb8(image), &f).is_err());
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        panel(&mut image, 10, 40, 100);
        assert!(resolve(&DynamicImage::ImageRgb8(image), &field("panel")).is_err());
    }
    #[test]
    fn split_row_excludes_independently_localized_player_bets() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        panel(&mut image, 200, 75, 100);
        panel(&mut image, 350, 40, 100);
        let mut f = field("pot_row");
        f["localizer"]["row_center_x"] = json!(250.);
        f["localizer"]["row_center_tolerance"] = json!(3.);
        f["localizer"]["excluded_bounds"] = json!([{"x":350.,"y":40.,"width":100.,"height":30.}]);
        let resolved = resolve(&DynamicImage::ImageRgb8(image.clone()), &f).unwrap();
        assert_eq!(
            resolved["bounds"],
            json!({"x":200,"y":75,"width":100,"height":30})
        );
        f["localizer"]
            .as_object_mut()
            .unwrap()
            .remove("excluded_bounds");
        assert!(resolve(&DynamicImage::ImageRgb8(image), &f).is_err());
    }
    #[test]
    fn gold_currency_badges_are_localized_and_unrecognized_positive_panels_are_not_negatives() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        panel(&mut image, 200, 40, 100);
        for yy in 45..65 {
            for xx in 206..222 {
                image.put_pixel(xx, yy, Rgb([250, 205, 0]));
            }
        }
        let resolved = resolve(&DynamicImage::ImageRgb8(image.clone()), &field("panel")).unwrap();
        assert_eq!(resolved["bounds"]["width"], 100);
        for yy in 45..65 {
            for xx in 206..222 {
                image.put_pixel(xx, yy, Rgb([220, 0, 220]));
            }
        }
        let mut f = field("pot_row");
        f["bounds"] = json!({"x":220.,"y":40.,"width":70.,"height":30.});
        f["localizer"]["empty_slot_fallback"] = json!(true);
        assert!(resolve(&DynamicImage::ImageRgb8(image), &f).is_err());
    }
    #[test]
    fn run_it_twice_pot_text_does_not_require_a_currency_badge() {
        let mut image = ImageBuffer::from_pixel(1920, 1080, Rgb([60, 60, 60]));
        for glyph in 0..8 {
            for y in 45..61 {
                for x in (170 + glyph * 16)..(180 + glyph * 16) {
                    image.put_pixel(x, y, Rgb([240, 240, 240]));
                }
            }
        }
        let mut f = field("panel");
        f["id"] = json!("pot");
        f["category"] = json!("pot");
        f["localizer"]
            .as_object_mut()
            .unwrap()
            .remove("require_currency_badge");
        f["localizer"]["max_currency_badges"] = json!(1);
        f["localizer"]["allow_pause_text"] = json!(true);
        let resolved = resolve(&DynamicImage::ImageRgb8(image), &f).unwrap();
        assert_eq!(resolved["localization"]["kind"], "text_line");
        assert_eq!(resolved["id"], "pot");
        assert!(crate::labels::validate_label("pot", "Run It Twice pause (12 sec)").is_ok());
    }
}
