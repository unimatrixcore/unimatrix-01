use image::RgbImage;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const POLICY: &str = "source_seeded_card_components_v1";
pub const FOREGROUND_DELTA: f64 = 12.;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct InkBounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphFit {
    pub bounds: InkBounds,
    pub erase_pixels: Vec<[u32; 2]>,
    pub background_rgb: [u8; 3],
    #[serde(default)]
    pub boundary_contact: [bool; 4],
}
/// Source SVG rank and suit are separate paths. Seed only above suit support,
/// then retain entire connected strokes, including both digits and descenders.
#[cfg(test)]
pub fn fit(image: &RgbImage, seed_end: f64, above: bool, polarity: &str) -> Option<InkBounds> {
    components(image, seed_end, above, polarity, None).map(|fit| fit.bounds)
}
pub fn components(
    image: &RgbImage,
    seed_end: f64,
    above: bool,
    polarity: &str,
    background_rgb: Option<[u8; 3]>,
) -> Option<GlyphFit> {
    if image.width() < 3 || image.height() < 3 || !seed_end.is_finite() {
        return None;
    }
    let mut colors = BTreeMap::<[u8; 3], usize>::new();
    for pixel in image.pixels() {
        *colors.entry(pixel.0.map(|v| v / 4 * 4)).or_default() += 1;
    }
    let bg = background_rgb.unwrap_or(colors.into_iter().max_by_key(|(_, n)| *n)?.0);
    let background = bg.iter().map(|v| f64::from(*v)).sum::<f64>() / 3.;
    let (mut lighter, mut darker) = (0., 0.);
    for (_, y, p) in image.enumerate_pixels() {
        let seeded = if above {
            f64::from(y) + 0.5 < seed_end
        } else {
            f64::from(y) + 0.5 > seed_end
        };
        if !seeded {
            continue;
        }
        let delta = p.0.iter().map(|v| f64::from(*v)).sum::<f64>() / 3. - background;
        if delta > FOREGROUND_DELTA {
            lighter += delta;
        } else if delta < -FOREGROUND_DELTA {
            darker -= delta;
        }
    }
    let spread = bg.iter().max().unwrap() - bg.iter().min().unwrap();
    let detected = if background_rgb.is_some() && spread <= 40 && background >= 90. && darker > 0. {
        "dark"
    } else if background_rgb.is_some() && (spread > 40 || background < 90.) && lighter > 0. {
        "light"
    } else if lighter > darker * 2. && lighter > 0. {
        "light"
    } else if darker > lighter * 2. && darker > 0. {
        "dark"
    } else {
        return None;
    };
    let polarity = if polarity == "auto" {
        detected
    } else if ["light", "dark"].contains(&polarity) {
        polarity
    } else {
        return None;
    };
    let (w, h) = (image.width() as usize, image.height() as usize);
    let mut visited = vec![false; w * h];
    let foreground = |x: usize, y: usize| {
        let p = image.get_pixel(x as u32, y as u32).0;
        let value = p.iter().map(|v| f64::from(*v)).sum::<f64>() / 3.;
        let delta = if polarity == "light" {
            value - background
        } else {
            background - value
        };
        delta > FOREGROUND_DELTA
    };
    let mut selected = Vec::new();
    let mut retained = vec![false; w * h];
    let mut rejected = vec![false; w * h];
    for start in 0..visited.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let (x, y) = (start % w, start / w);
        if !foreground(x, y) {
            continue;
        }
        let mut queue = vec![(x, y)];
        let mut pixels = Vec::new();
        let (mut left, mut right, mut top, mut bottom, mut area, mut seeded) =
            (x, x, y, y, 0usize, false);
        while let Some((x, y)) = queue.pop() {
            area += 1;
            pixels.push((x, y));
            left = left.min(x);
            right = right.max(x);
            top = top.min(y);
            bottom = bottom.max(y);
            seeded |= if above {
                y as f64 + 0.5 < seed_end
            } else {
                y as f64 + 0.5 > seed_end
            };
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx.abs() + dy.abs() != 1 {
                        continue;
                    }
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let index = ny as usize * w + nx as usize;
                    if visited[index] {
                        continue;
                    }
                    visited[index] = true;
                    if foreground(nx as usize, ny as usize) {
                        queue.push((nx as usize, ny as usize));
                    }
                }
            }
        }
        if seeded && area >= 2 {
            selected.push((left, right, top, bottom, area));
            for (x, y) in pixels {
                retained[y * w + x] = true;
            }
        } else {
            for (x, y) in pixels {
                rejected[y * w + x] = true;
            }
        }
    }
    if selected.is_empty()
        || selected.len() > 8
        || selected.iter().map(|s| s.4).sum::<usize>() > w * h * 9 / 10
    {
        return None;
    }
    let left = selected.iter().map(|s| s.0).min()?.saturating_sub(1);
    let right = (selected.iter().map(|s| s.1).max()? + 2).min(w);
    let top = selected.iter().map(|s| s.2).min()?.saturating_sub(1);
    let bottom = (selected.iter().map(|s| s.3).max()? + 2).min(h);
    let mut erase_pixels = Vec::new();
    for y in top..bottom {
        for x in left..right {
            let neighbors = (y.saturating_sub(1)..=(y + 1).min(h - 1))
                .flat_map(|yy| {
                    (x.saturating_sub(1)..=(x + 1).min(w - 1)).map(move |xx| yy * w + xx)
                })
                .collect::<Vec<_>>();
            let retained_near = (y.saturating_sub(1)..=(y + 1).min(h - 1))
                .flat_map(|yy| (x.saturating_sub(1)..=(x + 1).min(w - 1)).map(move |xx| (xx, yy)))
                .any(|(xx, yy)| xx.abs_diff(x) + yy.abs_diff(y) <= 1 && retained[yy * w + xx]);
            if neighbors.iter().any(|i| rejected[*i]) && !retained_near {
                erase_pixels.push([(x - left) as u32, (y - top) as u32]);
            }
        }
    }
    Some(GlyphFit {
        boundary_contact: [
            selected.iter().any(|s| s.0 == 0),
            selected.iter().any(|s| s.2 == 0),
            selected.iter().any(|s| s.1 + 1 == w),
            selected.iter().any(|s| s.3 + 1 == h),
        ],
        bounds: InkBounds {
            x: left as u32,
            y: top as u32,
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        },
        erase_pixels,
        background_rgb: bg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    #[test]
    fn separate_suit_is_excluded_but_connected_descender_and_two_digits_survive() {
        let mut i = RgbImage::from_pixel(30, 40, Rgb([0, 100, 0]));
        for y in 3..24 {
            for x in [5, 6, 13, 14] {
                i.put_pixel(x, y, Rgb([255; 3]));
            }
        }
        for y in 27..36 {
            for x in 6..15 {
                i.put_pixel(x, y, Rgb([255; 3]));
            }
        }
        let b = fit(&i, 25., true, "auto").unwrap();
        assert_eq!((b.x, b.y, b.width, b.height), (4, 2, 12, 23));
        assert!(b.y + b.height < 27);
        let s = fit(&i, 25., false, "auto").unwrap();
        assert_eq!(s.y, 26);
    }
    #[test]
    fn disconnected_suit_pixel_inside_rank_descender_bounds_is_masked_without_chopping_tail() {
        let mut image = RgbImage::from_pixel(30, 40, Rgb([20; 3]));
        for y in 3..23 {
            for x in 10..15 {
                image.put_pixel(x, y, Rgb([220; 3]));
            }
        }
        for y in 20..28 {
            for x in 13..18 {
                image.put_pixel(x, y, Rgb([220; 3]));
            }
        }
        image.put_pixel(9, 26, Rgb([220; 3]));
        let fit = components(&image, 24., true, "auto", Some([20; 3])).unwrap();
        assert_eq!(fit.bounds.y + fit.bounds.height, 29);
        assert!(fit
            .erase_pixels
            .contains(&[9 - fit.bounds.x, 26 - fit.bounds.y]));
        assert!(!fit
            .erase_pixels
            .contains(&[15 - fit.bounds.x, 26 - fit.bounds.y]));
    }
    #[test]
    fn dark_and_faded_foreground_are_supported_without_using_suit_color() {
        for (bg, fg) in [(230, 40), (100, 35), (30, 85)] {
            let mut i = RgbImage::from_pixel(20, 30, Rgb([bg; 3]));
            for y in 3..18 {
                for x in 4..9 {
                    i.put_pixel(x, y, Rgb([fg; 3]));
                }
            }
            let b = fit(&i, 22., true, "auto").unwrap();
            assert_eq!((b.x, b.y, b.width, b.height), (3, 2, 7, 17));
        }
    }
    #[test]
    fn uniform_or_unattributable_pixels_do_not_invent_glyphs() {
        assert!(fit(
            &RgbImage::from_pixel(20, 30, Rgb([40; 3])),
            22.,
            true,
            "auto"
        )
        .is_none());
    }

    #[test]
    fn source_support_boundary_contact_is_evidence_without_rewriting_pixels() {
        let mut image = RgbImage::from_pixel(20, 30, Rgb([20; 3]));
        for y in 0..20 {
            for x in 4..9 {
                image.put_pixel(x, y, Rgb([230; 3]));
            }
        }
        let fit = components(&image, 22., true, "auto", Some([20; 3])).unwrap();
        assert_eq!(fit.boundary_contact, [false, true, false, false]);
        assert_eq!(fit.bounds.y, 0);
        assert!(fit.erase_pixels.is_empty());
    }
}
