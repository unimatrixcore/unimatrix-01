use image::{Rgb, RgbImage};
use serde::{Deserialize, Serialize};

pub const POLICY: &str = "card_plane_edges_bilinear_v1";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct LocalRect {
    pub x: f64,
    pub y: f64,
    #[serde(alias = "w")]
    pub width: f64,
    #[serde(alias = "h")]
    pub height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardPrior {
    pub quad: [Point; 4],
    pub rank: LocalRect,
    pub suit: LocalRect,
    pub search_radius_px: f64,
    pub max_angle_delta_degrees: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EdgeEvidence {
    pub samples: usize,
    pub inliers: usize,
    pub span_fraction: f64,
    pub rms_px: f64,
    pub angle_delta_degrees: f64,
    pub offset_px: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CardPose {
    pub policy: String,
    pub prior_quad: [Point; 4],
    pub quad: [Point; 4],
    pub rank: LocalRect,
    pub suit: LocalRect,
    pub prior_angle_degrees: f64,
    pub measured_angle_degrees: f64,
    pub applied_angle_degrees: f64,
    pub adjusted: bool,
    pub top_edge: Option<EdgeEvidence>,
    pub left_edge: Option<EdgeEvidence>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CardResolution {
    Pose { pose: CardPose },
    Fallback { reason: String },
}
#[derive(Clone, Copy, Debug)]
pub enum Field {
    Rank,
    Suit,
}
pub struct RectifiedCrop {
    pub rgb: RgbImage,
    pub source_quad: [Point; 4],
    pub source_angle_degrees: f64,
    // Maps output pixel centers into the original screenshot, before sampling.
    pub pixel_to_frame: [f64; 6],
    pub exact_axis_aligned: bool,
}

fn add(a: Point, b: Point) -> Point {
    Point {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}
fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}
fn mul(a: Point, s: f64) -> Point {
    Point {
        x: a.x * s,
        y: a.y * s,
    }
}
fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}
fn length(a: Point) -> f64 {
    dot(a, a).sqrt()
}
fn finite(p: Point) -> bool {
    p.x.is_finite() && p.y.is_finite()
}
fn valid_rect(r: LocalRect) -> bool {
    [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
        && r.width > 0.
        && r.height > 0.
        && r.width <= 1.
        && r.height <= 1.
}
fn angle(p: Point) -> f64 {
    p.y.atan2(p.x).to_degrees()
}
fn inside(frame: &RgbImage, p: Point) -> bool {
    finite(p) && p.x >= 0. && p.y >= 0. && p.x < frame.width() as f64 && p.y < frame.height() as f64
}
fn at(frame: &RgbImage, p: Point) -> Option<[f64; 3]> {
    if !inside(frame, p) {
        return None;
    }
    let x = (p.x - 0.5).clamp(0., frame.width().saturating_sub(1) as f64);
    let y = (p.y - 0.5).clamp(0., frame.height().saturating_sub(1) as f64);
    let (ix, iy) = (x.floor() as u32, y.floor() as u32);
    let (jx, jy) = (
        (ix + 1).min(frame.width() - 1),
        (iy + 1).min(frame.height() - 1),
    );
    let (fx, fy) = (x - ix as f64, y - iy as f64);
    Some(std::array::from_fn(|c| {
        let a =
            frame.get_pixel(ix, iy)[c] as f64 * (1. - fx) + frame.get_pixel(jx, iy)[c] as f64 * fx;
        let b =
            frame.get_pixel(ix, jy)[c] as f64 * (1. - fx) + frame.get_pixel(jx, jy)[c] as f64 * fx;
        a * (1. - fy) + b * fy
    }))
}
fn color_distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

struct Fit {
    evidence: EdgeEvidence,
    intercept: f64,
}
fn fit_edge(
    frame: &RgbImage,
    origin: Point,
    axis: Point,
    normal: Point,
    len: f64,
    prior: &CardPrior,
    invert: bool,
) -> Option<Fit> {
    let count = 40;
    let mut points = Vec::new();
    for i in 0..count {
        let s = len * (0.15 + 0.7 * i as f64 / (count - 1) as f64);
        let base = add(origin, mul(axis, s));
        let mut best = None;
        for step in -(prior.search_radius_px * 2.).floor() as i32
            ..=(prior.search_radius_px * 2.).floor() as i32
        {
            let d = step as f64 / 2.;
            let p = add(base, mul(normal, d));
            let (Some(a), Some(b)) = (
                at(frame, add(p, mul(normal, -1.25))),
                at(frame, add(p, mul(normal, 1.25))),
            ) else {
                continue;
            };
            let contrast = color_distance(a, b);
            if contrast < 22. {
                continue;
            }
            let score = contrast - d.abs() * 2.;
            if best.as_ref().is_none_or(|(_, _, v)| score > *v) {
                best = Some((s, d, score));
            }
        }
        if let Some((s, d, w)) = best {
            points.push((s, d, w));
        }
    }
    if points.len() < 16 {
        return None;
    }
    let mut best: Option<Vec<usize>> = None;
    for i in 0..points.len() {
        for j in i + 1..points.len() {
            let dx = points[j].0 - points[i].0;
            if dx < len * 0.4 {
                continue;
            }
            let slope = (points[j].1 - points[i].1) / dx;
            if slope.atan().to_degrees().abs() > prior.max_angle_delta_degrees {
                continue;
            }
            let intercept = points[i].1 - slope * points[i].0;
            let inliers = points
                .iter()
                .enumerate()
                .filter(|(_, p)| (p.1 - slope * p.0 - intercept).abs() < 0.85)
                .map(|(n, _)| n)
                .collect::<Vec<_>>();
            if best.as_ref().is_none_or(|b| inliers.len() > b.len()) {
                best = Some(inliers);
            }
        }
    }
    let indices = best?;
    if indices.len() < 22 {
        return None;
    }
    let min = indices
        .iter()
        .map(|i| points[*i].0)
        .fold(f64::INFINITY, f64::min);
    let max = indices
        .iter()
        .map(|i| points[*i].0)
        .fold(f64::NEG_INFINITY, f64::max);
    if (max - min) / len < 0.55 {
        return None;
    }
    let n = indices.len() as f64;
    let sx = indices.iter().map(|i| points[*i].0).sum::<f64>();
    let sy = indices.iter().map(|i| points[*i].1).sum::<f64>();
    let sxx = indices.iter().map(|i| points[*i].0.powi(2)).sum::<f64>();
    let sxy = indices
        .iter()
        .map(|i| points[*i].0 * points[*i].1)
        .sum::<f64>();
    let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    let intercept = (sy - slope * sx) / n;
    let rms = (indices
        .iter()
        .map(|i| (points[*i].1 - slope * points[*i].0 - intercept).powi(2))
        .sum::<f64>()
        / n)
        .sqrt();
    let delta = slope.atan().to_degrees() * if invert { -1. } else { 1. };
    if !delta.is_finite() || delta.abs() > prior.max_angle_delta_degrees || rms > 0.65 {
        return None;
    }
    Some(Fit {
        evidence: EdgeEvidence {
            samples: count,
            inliers: indices.len(),
            span_fraction: (max - min) / len,
            rms_px: rms,
            angle_delta_degrees: delta,
            offset_px: intercept,
        },
        intercept,
    })
}

pub fn resolve_pose(frame: &RgbImage, prior: &CardPrior) -> Result<CardResolution, String> {
    if frame.width() == 0
        || frame.height() == 0
        || prior.quad.iter().any(|p| !finite(*p))
        || !valid_rect(prior.rank)
        || !valid_rect(prior.suit)
        || !prior.search_radius_px.is_finite()
        || prior.search_radius_px <= 0.
        || !prior.max_angle_delta_degrees.is_finite()
        || !(0. ..=25.).contains(&prior.max_angle_delta_degrees)
    {
        return Err("Invalid card-plane prior".into());
    }
    let u = sub(prior.quad[1], prior.quad[0]);
    let v = sub(prior.quad[3], prior.quad[0]);
    let (w, h) = (length(u), length(v));
    if w < 12.
        || h < 20.
        || w * h > 1_000_000.
        || dot(u, v).abs() / (w * h) > 0.03
        || u.x * v.y - u.y * v.x <= 0.
        || length(sub(prior.quad[2], add(prior.quad[0], add(u, v)))) > 1.
    {
        return Err("Card prior must describe one rectangular plane".into());
    }
    if prior.quad.iter().any(|p| !inside(frame, *p)) {
        return Ok(CardResolution::Fallback {
            reason: "Card plane is clipped by the screenshot".into(),
        });
    }
    let (u, v) = (mul(u, 1. / w), mul(v, 1. / h));
    let top = fit_edge(frame, prior.quad[0], u, v, w, prior, false);
    let left = fit_edge(frame, prior.quad[0], v, u, h, prior, true);
    if top.is_none() && left.is_none() {
        return Ok(CardResolution::Fallback{reason:"No supported straight card-plane edges; preserve the original negative/admission path".into()});
    }
    if let (Some(a), Some(b)) = (&top, &left) {
        if (a.evidence.angle_delta_degrees - b.evidence.angle_delta_degrees).abs() > 1.5 {
            return Ok(CardResolution::Fallback {
                reason: "Card edge directions disagree".into(),
            });
        }
    }
    let delta = match (&top, &left) {
        (Some(a), Some(b)) => {
            (a.evidence.angle_delta_degrees + b.evidence.angle_delta_degrees) / 2.
        }
        (Some(a), _) => a.evidence.angle_delta_degrees,
        (_, Some(b)) => b.evidence.angle_delta_degrees,
        _ => unreachable!(),
    };
    let prior_angle = angle(u);
    let theta = (prior_angle + delta).to_radians();
    let nu = Point {
        x: theta.cos(),
        y: theta.sin(),
    };
    let nv = Point {
        x: -theta.sin(),
        y: theta.cos(),
    };
    let offset_v = top.as_ref().map_or(0., |e| e.intercept);
    let offset_u = left.as_ref().map_or(0., |e| e.intercept);
    let origin = add(prior.quad[0], add(mul(u, offset_u), mul(v, offset_v)));
    let moved = length(sub(origin, prior.quad[0]));
    let adjusted = delta.abs() > 0.35 || moved > 1.;
    let quad = if adjusted {
        [
            origin,
            add(origin, mul(nu, w)),
            add(origin, add(mul(nu, w), mul(nv, h))),
            add(origin, mul(nv, h)),
        ]
    } else {
        prior.quad
    };
    if quad.iter().any(|p| !inside(frame, *p)) {
        return Ok(CardResolution::Fallback {
            reason: "Measured card plane is clipped".into(),
        });
    }
    Ok(CardResolution::Pose {
        pose: CardPose {
            policy: POLICY.into(),
            prior_quad: prior.quad,
            quad,
            rank: prior.rank,
            suit: prior.suit,
            prior_angle_degrees: prior_angle,
            measured_angle_degrees: prior_angle + delta,
            applied_angle_degrees: if adjusted {
                prior_angle + delta
            } else {
                prior_angle
            },
            adjusted,
            top_edge: top.map(|x| x.evidence),
            left_edge: left.map(|x| x.evidence),
        },
    })
}

pub fn sample_field(
    frame: &RgbImage,
    pose: &CardPose,
    field: Field,
    margin_px: f64,
) -> Result<RectifiedCrop, String> {
    if !margin_px.is_finite() || !(0. ..=8.).contains(&margin_px) {
        return Err("Invalid glyph margin".into());
    }
    let u = sub(pose.quad[1], pose.quad[0]);
    let v = sub(pose.quad[3], pose.quad[0]);
    let (w, h) = (length(u), length(v));
    let r = match field {
        Field::Rank => pose.rank,
        Field::Suit => pose.suit,
    };
    let x = r.x - margin_px / w;
    let y = r.y - margin_px / h;
    let rw = r.width + 2. * margin_px / w;
    let rh = r.height + 2. * margin_px / h;
    let origin = add(pose.quad[0], add(mul(u, x), mul(v, y)));
    let a = mul(u, rw);
    let b = mul(v, rh);
    let source_quad = [
        origin,
        add(origin, a),
        add(origin, add(a, b)),
        add(origin, b),
    ];
    if source_quad.iter().any(|p| !inside(frame, *p)) {
        return Err("Glyph sampling would exceed the screenshot".into());
    }
    let axis = a.y.abs() < 1e-8 && b.x.abs() < 1e-8 && a.x > 0. && b.y > 0.;
    if axis {
        let left = origin.x.floor() as u32;
        let top = origin.y.floor() as u32;
        let right = (origin.x + a.x).ceil() as u32;
        let bottom = (origin.y + b.y).ceil() as u32;
        return Ok(RectifiedCrop {
            rgb: image::imageops::crop_imm(frame, left, top, right - left, bottom - top).to_image(),
            source_quad,
            source_angle_degrees: pose.applied_angle_degrees,
            pixel_to_frame: [1., 0., left as f64, 0., 1., top as f64],
            exact_axis_aligned: true,
        });
    }
    let width = length(a).ceil() as u32;
    let height = length(b).ceil() as u32;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 1_000_000 {
        return Err("Unsupported rectified glyph dimensions".into());
    }
    let du = mul(a, 1. / width as f64);
    let dv = mul(b, 1. / height as f64);
    let mut rgb = RgbImage::new(width, height);
    for yy in 0..height {
        for xx in 0..width {
            let p = add(
                origin,
                add(mul(du, xx as f64 + 0.5), mul(dv, yy as f64 + 0.5)),
            );
            let value = at(frame, p).ok_or("Glyph sampling exceeds screenshot")?;
            rgb.put_pixel(xx, yy, Rgb(value.map(|v| v.round().clamp(0., 255.) as u8)));
        }
    }
    Ok(RectifiedCrop {
        rgb,
        source_quad,
        source_angle_degrees: pose.applied_angle_degrees,
        pixel_to_frame: [du.x, dv.x, origin.x, du.y, dv.y, origin.y],
        exact_axis_aligned: false,
    })
}
