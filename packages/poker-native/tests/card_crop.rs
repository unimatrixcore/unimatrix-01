#[path = "../src/lab/gameplay/card_crop.rs"]
mod card_crop;
use card_crop::{resolve_pose, sample_field, CardPrior, CardResolution, Field, LocalRect, Point};
use image::{Rgb, RgbImage};

fn quad(origin: Point, degrees: f64) -> [Point; 4] {
    let a = degrees.to_radians();
    let u = Point {
        x: 82. * a.cos(),
        y: 82. * a.sin(),
    };
    let v = Point {
        x: -114. * a.sin(),
        y: 114. * a.cos(),
    };
    [
        origin,
        Point {
            x: origin.x + u.x,
            y: origin.y + u.y,
        },
        Point {
            x: origin.x + u.x + v.x,
            y: origin.y + u.y + v.y,
        },
        Point {
            x: origin.x + v.x,
            y: origin.y + v.y,
        },
    ]
}
fn prior(degrees: f64) -> CardPrior {
    CardPrior {
        quad: quad(Point { x: 65.2, y: 50.4 }, degrees),
        rank: LocalRect {
            x: 0.04,
            y: 0.06,
            width: 0.36,
            height: 0.28,
        },
        suit: LocalRect {
            x: 0.05,
            y: 0.35,
            width: 0.28,
            height: 0.22,
        },
        search_radius_px: 8.,
        max_angle_delta_degrees: 6.,
    }
}
fn draw_card(degrees: f64, opacity: f64, shift: Point) -> RgbImage {
    let a = degrees.to_radians();
    let origin = Point {
        x: 65.2 + shift.x,
        y: 50.4 + shift.y,
    };
    RgbImage::from_fn(260, 220, |x, y| {
        let mut total = [0.; 3];
        for sy in 0..4 {
            for sx in 0..4 {
                let dx = x as f64 + (sx as f64 + 0.5) / 4. - origin.x;
                let dy = y as f64 + (sy as f64 + 0.5) / 4. - origin.y;
                let (u, v) = (dx * a.cos() + dy * a.sin(), -dx * a.sin() + dy * a.cos());
                let bg = [63., 62., 66.];
                let ink = ((u - (8. + (30. - v) * 0.16)).abs() < 1.5 && (10. ..=30.).contains(&v))
                    || ((17. ..=29.).contains(&u)
                        && (10. ..=30.).contains(&v)
                        && (u < 19. || u > 27. || v < 12. || v > 28.))
                    || ((6. ..=30.).contains(&u) && (30. ..=32.).contains(&v))
                    || ((u - 16.).abs() + (v - 53.).abs() < 8.);
                let color = if u >= 0. && v >= 0. && u < 82. && v < 114. {
                    let c = if ink {
                        [245., 245., 245.]
                    } else {
                        [22., 96., 178.]
                    };
                    std::array::from_fn(|i| c[i] * opacity + bg[i] * (1. - opacity))
                } else {
                    bg
                };
                for i in 0..3 {
                    total[i] += color[i] / 16.;
                }
            }
        }
        Rgb(total.map(|c| c.round() as u8))
    })
}
fn pose(image: &RgbImage, p: &CardPrior) -> card_crop::CardPose {
    match resolve_pose(image, p).unwrap() {
        CardResolution::Pose { pose } => pose,
        other => panic!("Expected supported card edges, got {other:?}"),
    }
}

#[test]
fn detects_real_plane_angles_in_both_fan_directions_and_dimmed_cards() {
    for (actual, expected, opacity) in [
        (-7.5, -5., 1.),
        (7.5, 5., 1.),
        (-5., -5., 0.55),
        (5., 5., 0.55),
    ] {
        let image = draw_card(actual, opacity, Point { x: 0., y: 0. });
        let detected = pose(&image, &prior(expected));
        assert!(
            (detected.measured_angle_degrees - actual).abs() < 0.7,
            "{actual}: {detected:?}"
        );
        assert_eq!(detected.policy, card_crop::POLICY);
        assert!(detected.top_edge.is_some() || detected.left_edge.is_some());
        let rank = sample_field(&image, &detected, Field::Rank, 1.).unwrap();
        let suit = sample_field(&image, &detected, Field::Suit, 1.).unwrap();
        assert!(!rank.exact_axis_aligned);
        assert!(!suit.exact_axis_aligned);
        assert_eq!(rank.source_angle_degrees, suit.source_angle_degrees);
        assert!(rank.rgb.width() >= 30 && rank.rgb.height() >= 32);
        assert!(rank.rgb.pixels().any(|p| p[0] > 140 && p[1] > 140));
        assert!(suit.rgb.pixels().any(|p| p[0] > 140 && p[1] > 140));
        assert!(rank.pixel_to_frame.iter().all(|v| v.is_finite()));
        assert!(rank.source_quad.iter().all(|p| p.x > 0. && p.y > 0.));
    }
}

#[test]
fn upright_board_keeps_exact_original_floor_ceil_pixels() {
    let image = draw_card(0., 1., Point { x: 0., y: 0. });
    let p = prior(0.);
    let detected = pose(&image, &p);
    assert!(!detected.adjusted);
    let crop = sample_field(&image, &detected, Field::Rank, 0.).unwrap();
    let x = p.quad[0].x + p.rank.x * 82.;
    let y = p.quad[0].y + p.rank.y * 114.;
    let expected = image::imageops::crop_imm(
        &image,
        x.floor() as u32,
        y.floor() as u32,
        (x + p.rank.width * 82.).ceil() as u32 - x.floor() as u32,
        (y + p.rank.height * 114.).ceil() as u32 - y.floor() as u32,
    )
    .to_image();
    assert!(crop.exact_axis_aligned);
    assert_eq!(crop.rgb, expected);
}

#[test]
fn rectification_does_not_straighten_the_fonts_intrinsic_italic_stem() {
    let image = draw_card(-7.5, 1., Point { x: 0., y: 0. });
    let detected = pose(&image, &prior(-5.));
    let crop = sample_field(&image, &detected, Field::Rank, 0.).unwrap();
    let rows = (6..20)
        .filter_map(|y| {
            let xs = (0..12)
                .filter(|x| crop.rgb.get_pixel(*x, y)[0] > 170)
                .collect::<Vec<_>>();
            (!xs.is_empty()).then(|| {
                (
                    y as f64,
                    xs.iter().map(|x| *x as f64).sum::<f64>() / xs.len() as f64,
                )
            })
        })
        .collect::<Vec<_>>();
    let n = rows.len() as f64;
    let sy = rows.iter().map(|r| r.0).sum::<f64>();
    let sx = rows.iter().map(|r| r.1).sum::<f64>();
    let slope = (n * rows.iter().map(|r| r.0 * r.1).sum::<f64>() - sx * sy)
        / (n * rows.iter().map(|r| r.0 * r.0).sum::<f64>() - sy * sy);
    assert!(
        slope < -0.06 && slope > -0.3,
        "Italic design was altered: {slope}"
    );
}

#[test]
fn rectified_card_baseline_is_horizontal_in_both_fan_directions() {
    for (actual, expected) in [(-7.5, -5.), (7.5, 5.)] {
        let image = draw_card(actual, 0.55, Point { x: 0., y: 0. });
        let detected = pose(&image, &prior(expected));
        let crop = sample_field(&image, &detected, Field::Rank, 0.).unwrap();
        let points = (5..23)
            .map(|x| {
                let y = (17..29)
                    .rev()
                    .find(|y| crop.rgb.get_pixel(x, *y)[0] > 110)
                    .expect("Full baseline stroke must remain visible");
                (x as f64, y as f64)
            })
            .collect::<Vec<_>>();
        let n = points.len() as f64;
        let sx = points.iter().map(|p| p.0).sum::<f64>();
        let sy = points.iter().map(|p| p.1).sum::<f64>();
        let slope = (n * points.iter().map(|p| p.0 * p.1).sum::<f64>() - sx * sy)
            / (n * points.iter().map(|p| p.0 * p.0).sum::<f64>() - sx * sx);
        assert!(slope.abs() < 0.05, "Residual baseline slope: {slope}");
    }
}

#[test]
fn absent_and_avatar_like_curves_return_explicit_fallback() {
    let absent = RgbImage::from_pixel(260, 220, Rgb([63, 62, 66]));
    let avatar = RgbImage::from_fn(260, 220, |x, y| {
        if (x as f64 - 106.).hypot(y as f64 - 105.) < 60. {
            Rgb([160, 40, 90])
        } else {
            Rgb([63, 62, 66])
        }
    });
    for image in [absent, avatar] {
        assert!(matches!(
            resolve_pose(&image, &prior(-5.)).unwrap(),
            CardResolution::Fallback { .. }
        ));
    }
}

#[test]
fn rejects_invalid_geometry_and_preserves_clipped_fallback() {
    let image = draw_card(5., 1., Point { x: 0., y: 0. });
    let mut p = prior(5.);
    p.search_radius_px = f64::NAN;
    assert!(resolve_pose(&image, &p).is_err());
    let mut p = prior(5.);
    p.quad[2].x += 5.;
    assert!(resolve_pose(&image, &p).is_err());
    let mut p = prior(5.);
    p.quad = quad(Point { x: -10., y: -10. }, 5.);
    assert!(matches!(
        resolve_pose(&image, &p).unwrap(),
        CardResolution::Fallback { .. }
    ));
    let p = pose(&image, &prior(5.));
    assert!(sample_field(&image, &p, Field::Rank, -1.).is_err());
}

#[path = "../src/lab/gameplay/card_fields.rs"]
mod card_fields;
#[path = "../src/lab/gameplay/card_glyph.rs"]
mod card_glyph;
mod lab {
    pub type LabResult<T> = anyhow::Result<T>;
    pub fn bad(reason: impl std::fmt::Display) -> anyhow::Error {
        anyhow::anyhow!(reason.to_string())
    }
}

#[test]
#[ignore = "requires private offline pixel fixtures"]
fn offline_card_evidence() {
    let plan = std::env::var_os("POKER_CARD_PROOF_PLAN").expect("set POKER_CARD_PROOF_PLAN");
    let plan: serde_json::Value = serde_json::from_slice(&std::fs::read(plan).unwrap()).unwrap();
    let profile: serde_json::Value =
        serde_json::from_slice(&std::fs::read(plan["profile"].as_str().unwrap()).unwrap()).unwrap();
    let output = std::path::Path::new(plan["output"].as_str().unwrap());
    std::fs::create_dir_all(output).unwrap();
    let mut receipts = Vec::new();
    for case in plan["cases"].as_array().unwrap() {
        let frame = image::open(case["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        let mut selected_profile = profile.clone();
        selected_profile["card_priors"]
            .as_object_mut()
            .unwrap()
            .retain(|id, _| {
                case["regions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r.as_str().unwrap().trim_end_matches(".suit") == id)
            });
        let poses = card_fields::poses(&frame, &selected_profile).unwrap();
        for id in case["regions"].as_array().unwrap() {
            let region = profile["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == *id)
                .unwrap();
            let resolved = card_fields::resolve(&frame, &profile, region, &poses).unwrap();
            let filename = format!("{:04}.png", receipts.len());
            let presence = poker_native::lab::gameplay::presence::assess(
                &image::DynamicImage::ImageRgb8(frame.clone()),
                &resolved,
            );
            assert_eq!(presence["state"], "present");
            assert!(resolved["localization_error"].is_null());
            if case["require_review"] == true {
                assert_ne!(presence["target_support"], "supported");
                assert!(resolved["guideUnsupportedReason"].is_string());
            }
            if let Some(crop) = card_fields::sample(&frame, &resolved).unwrap() {
                if let Some(expected) = case["expected"][id.as_str().unwrap()]["png"].as_str() {
                    assert_eq!(
                        crop.to_rgb8(),
                        image::open(expected).unwrap().to_rgb8(),
                        "{} {}",
                        case["id"],
                        id
                    );
                }
                crop.save(output.join(&filename)).unwrap();
            } else if case["expected"][id.as_str().unwrap()].is_object() {
                assert!(case["expected"][id.as_str().unwrap()]["card_sampling"].is_null());
                assert_eq!(
                    resolved["bounds"],
                    case["expected"][id.as_str().unwrap()]["bounds"]
                );
                assert_eq!(resolved["polygon"], region["polygon"]);
                std::fs::copy(
                    case["expected"][id.as_str().unwrap()]["png"]
                        .as_str()
                        .unwrap(),
                    output.join(&filename),
                )
                .unwrap();
            }
            let exported = poker_native::lab::gameplay::ai::GameplayAi::export_pixel_evidence(
                &serde_json::to_vec(&profile).unwrap(),
                &std::fs::read(case["path"].as_str().unwrap()).unwrap(),
                &[id.as_str().unwrap().to_owned()],
            )
            .unwrap()
            .remove(0);
            std::fs::write(output.join(&filename), &exported.png).unwrap();
            let presence = exported.presence;
            let payload = serde_json::json!({"presence":presence});
            let region_id = id.as_str().unwrap();
            let blank_contradiction =
                poker_native::lab::gameplay::ai::evidence_cache::blank_contradicts_foreground(
                    region_id, &payload, "",
                );
            let automatic_support =
                poker_native::lab::gameplay::ai::evidence_cache::automatic_support(
                    region_id, &payload,
                );
            assert!(!automatic_support || blank_contradiction);
            if let Some(expected) = case["blank_contradiction"].as_bool() {
                assert_eq!(
                    blank_contradiction, expected,
                    "{} {} presence {} resolved {}",
                    case["id"], id, presence, resolved
                );
            }
            receipts.push(serde_json::json!({"case":case["id"],"region":resolved,"presence":presence,"filename":filename,"native_guide":exported.guide,"blank_contradiction":blank_contradiction,"automatic_support":automatic_support,"blank_auto_acceptable":automatic_support && !blank_contradiction}));
        }
    }
    std::fs::write(
        output.join("receipt.json"),
        serde_json::to_vec_pretty(&receipts).unwrap(),
    )
    .unwrap();
}
