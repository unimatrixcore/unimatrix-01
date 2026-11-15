use image::{DynamicImage, RgbImage};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const POLICY: &str = "source_free_seat_occupancy_v1";

pub fn is_empty(region: &Value) -> bool {
    region["seat_occupancy"]["state"] == "empty"
}

fn seat_key(region: &Value) -> Option<String> {
    let id = region["id"].as_str()?;
    if let Some(rest) = id.strip_prefix("seats[") {
        let (index, _) = rest.split_once(']')?;
        index.parse::<usize>().ok()?;
        Some(format!("seats[{index}]"))
    } else {
        let rest = id.strip_prefix("seat.")?;
        let (index, _) = rest.split_once('.')?;
        index.parse::<usize>().ok()?;
        Some(format!("seat.{index}"))
    }
}

fn decision(state: &str, reason: &str, evidence: Value) -> Value {
    json!({"state":state,"source":"source_free_seat_pixels","reason":reason,
        "policy":POLICY,"evidence":evidence})
}

fn near(a: [u8; 3], b: [u8; 3], tolerance: i16) -> bool {
    a.into_iter()
        .zip(b)
        .all(|(a, b)| (i16::from(a) - i16::from(b)).abs() <= tolerance)
}

fn pixel(rgb: &RgbImage, x: f64, y: f64) -> Option<[u8; 3]> {
    if x < 0. || y < 0. || x >= rgb.width() as f64 || y >= rgb.height() as f64 {
        None
    } else {
        Some(rgb.get_pixel(x.floor() as u32, y.floor() as u32).0)
    }
}

fn assess(rgb: &RgbImage, plate: &Value) -> Value {
    let b = &plate["bounds"];
    let Some((((x, y), w), h)) = b["x"]
        .as_f64()
        .zip(b["y"].as_f64())
        .zip(b["width"].as_f64())
        .zip(b["height"].as_f64())
    else {
        return decision(
            "unknown",
            "Source nameplate allocation is missing",
            Value::Null,
        );
    };
    // react.css default seat: 8.675em wide, bar 3.51em high, free-seat 4.135em.
    // The nine template offsets vary, so search the source seat allocation rather
    // than treating one captured seat's button coordinates as universal.
    let em = w / 8.675;
    if ![x, y, w, h, em].into_iter().all(f64::is_finite)
        || em < 8.
        || em > 50.
        || (h / em - 3.51).abs() > 0.08
    {
        return decision(
            "unknown",
            "Unsupported source seat geometry",
            json!({"nameplate":b}),
        );
    }
    let sample = |u: f64, v: f64| pixel(rgb, x + u * w, y + v * h);
    let panel_samples = [
        (0.08, 0.2),
        (0.92, 0.2),
        (0.08, 0.8),
        (0.92, 0.8),
        (0.15, 0.5),
        (0.85, 0.5),
    ];
    let panel_support = panel_samples
        .into_iter()
        .filter(|&(u, v)| sample(u, v).is_some_and(|p| near(p, [26, 44, 56], 3)))
        .count();
    let size = 4.135 * em;
    let scale = size / 50.;
    // a0583ac8c6c540eba2f4fb75.svg: downward shaft, both chevrons and
    // separated underline. White probes and negative-space probes are inside
    // the recovered path/clip; no text, avatar or darkness threshold is used.
    let white = [
        (25., 18.),
        (25., 22.),
        (25., 27.),
        (21., 24.),
        (29., 24.),
        (19.7, 23.4),
        (30.3, 23.4),
        (20., 33.),
        (25., 33.),
        (30., 33.),
    ];
    let gaps = [
        (20., 18.),
        (30., 18.),
        (19., 28.),
        (31., 28.),
        (25., 31.),
        (16., 25.),
        (34., 25.),
    ];
    let ring = [
        (0., -0.35),
        (0.35, 0.),
        (0., 0.35),
        (-0.35, 0.),
        (0.25, -0.25),
        (-0.25, -0.25),
        (0.25, 0.25),
        (-0.25, 0.25),
    ];
    for cy in
        ((y - 3.51 * em).floor().max(0.) as u32)..((y + h).ceil().min(rgb.height() as f64) as u32)
    {
        for cx in (x.floor().max(0.) as u32)..((x + w).ceil().min(rgb.width() as f64) as u32) {
            if rgb.get_pixel(cx, cy).0.iter().any(|v| *v < 235) {
                continue;
            }
            let probe = |u: f64, v: f64| {
                pixel(
                    rgb,
                    cx as f64 + (u - 25.) * scale,
                    cy as f64 + (v - 24.) * scale,
                )
            };
            if !white
                .into_iter()
                .all(|(u, v)| probe(u, v).is_some_and(|p| p.iter().all(|v| *v >= 225)))
            {
                continue;
            }
            let Some(bg) = probe(12., 12.) else {
                continue;
            };
            if ![[47, 69, 83], [85, 112, 134]]
                .into_iter()
                .any(|p| near(bg, p, 5))
            {
                continue;
            }
            if !gaps
                .into_iter()
                .all(|(u, v)| probe(u, v).is_some_and(|p| near(p, bg, 12)))
            {
                continue;
            }
            if !ring.into_iter().all(|(u, v)| {
                pixel(rgb, cx as f64 + u * size, cy as f64 + scale + v * size)
                    .is_some_and(|p| near(p, bg, 5))
            }) {
                continue;
            }
            let outside = [(0., -0.54), (0.54, 0.), (0., 0.54), (-0.54, 0.)]
                .into_iter()
                .filter(|(u, v)| {
                    pixel(rgb, cx as f64 + u * size, cy as f64 + scale + v * size)
                        .is_some_and(|p| !near(p, bg, 12))
                })
                .count();
            if outside < 3 {
                continue;
            }
            let evidence = json!({"nameplate":b,"source_em":em,"button_size":size,"glyph_anchor":{"x":cx,"y":cy},"glyph_white_probes":white.len(),"glyph_negative_probes":gaps.len(),"disk_support_probes":ring.len(),"outside_disk_probes":outside,"occupied_panel_probes":panel_support});
            if panel_support > 1 {
                return decision(
                    "unknown",
                    "Free-seat glyph conflicts with occupied nameplate pixels",
                    evidence,
                );
            }
            return decision("empty", "Source free-seat arrow, negative spaces and circular button match; occupied nameplate is absent", evidence);
        }
    }
    if panel_support >= 4 {
        decision(
            "occupied",
            "Source occupied nameplate panel is visible; no free-seat button matches",
            json!({"nameplate":b,"occupied_panel_probes":panel_support}),
        )
    } else {
        decision(
            "unknown",
            "No complete source free-seat button match; admit seat OCR",
            json!({"nameplate":b,"occupied_panel_probes":panel_support}),
        )
    }
}

pub fn resolve(image: &DynamicImage, profile: &Value) -> Value {
    let mut output = profile.clone();
    let Some(fields) = output["regions"].as_array_mut() else {
        return output;
    };
    let supported = image.width() == 1920
        && image.height() == 1080
        && profile["viewport"]["width"] == 1920
        && profile["viewport"]["height"] == 1080;
    let owned_rgb;
    let rgb = if let Some(rgb) = image.as_rgb8() {
        rgb
    } else {
        owned_rgb = image.to_rgb8();
        &owned_rgb
    };
    let mut seats = BTreeMap::new();
    for field in fields.iter() {
        let Some(key) = seat_key(field) else {
            continue;
        };
        seats.entry(key.clone()).or_insert_with(|| {
            decision(
                "unknown",
                "Source nameplate detector is unavailable; admit seat OCR",
                Value::Null,
            )
        });
        if field["category"] == "cv_nameplate"
            || field["id"]
                .as_str()
                .is_some_and(|id| id.ends_with(".nameplate"))
        {
            seats.insert(
                key,
                if supported {
                    assess(rgb, field)
                } else {
                    decision(
                        "unknown",
                        "Occupancy supports only the source 1920x1080 viewport; admit seat OCR",
                        Value::Null,
                    )
                },
            );
        }
    }
    for field in fields.iter_mut() {
        if let Some(evidence) = seat_key(field).and_then(|key| seats.get(&key)) {
            field["seat_occupancy"] = evidence.clone();
            if is_empty(field) {
                field["overlay"] = json!(false);
                field["presence"] = json!({"state":"absent","reason":"Proven unoccupied source seat","policy":POLICY});
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_viewport_and_missing_detector_never_hide_or_skip_cards() {
        for id in ["seat.4.card.0.rank", "seats[4].cards[0]"] {
            let profile = json!({"regions":[{"id":id,"category":"card","overlay":true,"bounds":{"x":0,"y":0,"width":4,"height":4}}]});
            let resolved = resolve(&DynamicImage::new_rgb8(10, 10), &profile);
            assert_eq!(resolved["regions"][0]["seat_occupancy"]["state"], "unknown");
            assert_eq!(resolved["regions"][0]["overlay"], true);
            assert!(!is_empty(&resolved["regions"][0]));
        }
    }

    #[test]
    fn proven_empty_seat_blocks_even_invalid_card_crop_before_sampling() {
        let image = DynamicImage::new_rgb8(1, 1);
        let region = json!({"id":"seats[0].cards[0]","category":"card","seat_occupancy":{"state":"empty"},"bounds":{"x":100,"y":100,"width":4,"height":4}});
        assert_eq!(
            super::super::crop_pixels(&image, &region)
                .unwrap_err()
                .message,
            "Proven empty seat has no OCR crop"
        );
        assert_eq!(
            super::super::super::presence::assess(&image, &region)["state"],
            "absent"
        );
    }

    #[test]
    #[ignore = "requires private recorded frames and an external visual-review plan"]
    fn recorded_empty_buttons_and_occupied_negative_controls() {
        let plan: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("POKER_OCCUPANCY_ACTUAL_PLAN")
                    .expect("set POKER_OCCUPANCY_ACTUAL_PLAN"),
            )
            .unwrap(),
        )
        .unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("POKER_SOURCE_PROFILE").expect("set POKER_SOURCE_PROFILE"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut report = Vec::new();
        for case in plan["cases"].as_array().unwrap() {
            let image = image::open(case["path"].as_str().unwrap()).unwrap();
            let resolved = resolve(&image, &profile);
            for plate in resolved["regions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["category"] == "cv_nameplate")
            {
                let expected = case["empty_ids"].as_array().unwrap().contains(&plate["id"]);
                assert_eq!(
                    is_empty(plate),
                    expected,
                    "frame {} region {}: {}",
                    case["id"],
                    plate["id"],
                    plate["seat_occupancy"]
                );
                report.push(json!({"frame":case["id"],"path":case["path"],"region_id":plate["id"],"seat_occupancy":plate["seat_occupancy"]}));
            }
        }
        std::fs::write(
            plan["output"].as_str().unwrap(),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!(
            "recorded source occupancy: {} visually reviewed seat decisions",
            report.len()
        );
    }

    #[test]
    #[ignore = "requires external source-derived occupancy controls"]
    fn source_seat_controls_keep_every_occupied_state_and_skip_only_empty_buttons() {
        let root = std::path::PathBuf::from(
            std::env::var("POKER_OCCUPANCY_FIXTURE").expect("set POKER_OCCUPANCY_FIXTURE"),
        );
        let profile: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("POKER_SOURCE_PROFILE").expect("set POKER_SOURCE_PROFILE"),
            )
            .unwrap(),
        )
        .unwrap();
        let controls: Value =
            serde_json::from_slice(&std::fs::read(root.join("groundtruth.json")).unwrap()).unwrap();
        let mut report = Vec::new();
        for control in controls.as_array().unwrap() {
            let kind = control["kind"].as_str().unwrap();
            let image = image::open(root.join("frames").join(format!("{kind}.png"))).unwrap();
            let resolved = resolve(&image, &profile);
            let plates = resolved["regions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["category"] == "cv_nameplate")
                .collect::<Vec<_>>();
            assert_eq!(plates.len(), 9);
            for plate in plates {
                let evidence = &plate["seat_occupancy"];
                report.push(json!({"kind":kind,"id":plate["id"],"seat_occupancy":evidence}));
                if kind == "empty" {
                    assert_eq!(evidence["state"], "empty", "{kind}: {plate}");
                } else {
                    assert_ne!(evidence["state"], "empty", "{kind}: {plate}");
                }
                let key = seat_key(plate).unwrap();
                for field in resolved["regions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|f| seat_key(f).as_deref() == Some(key.as_str()))
                {
                    assert_eq!(field["seat_occupancy"], *evidence);
                    if kind == "empty" {
                        assert_eq!(field["presence"]["state"], "absent");
                        assert_eq!(field["overlay"], false);
                    }
                }
            }
            assert_eq!(
                resolved["regions"].as_array().unwrap().len(),
                profile["regions"].as_array().unwrap().len()
            );
            assert_eq!(resolved["cv_regions"], profile["cv_regions"]);
            for (original, resolved) in profile["regions"]
                .as_array()
                .unwrap()
                .iter()
                .zip(resolved["regions"].as_array().unwrap())
            {
                for key in [
                    "id",
                    "bounds",
                    "polygon",
                    "envelope",
                    "card_sampling",
                    "card_target_evidence",
                ] {
                    assert_eq!(original[key], resolved[key], "{kind}: preserved {key}");
                }
            }
        }
        std::fs::write(
            root.join("native-results.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!("source occupancy controls: {} seat decisions", report.len());
    }
}
