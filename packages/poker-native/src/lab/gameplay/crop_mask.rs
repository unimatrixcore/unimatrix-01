use crate::lab::{bad, LabResult};
use image::{GrayImage, Luma, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

pub const POLICY: &str = "source_css_rounded_panels_rgb_v1";
pub const NEUTRAL_RGB: [u8; 3] = [15, 33, 46];

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct CornerRadius {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RoundedPanel {
    pub bounds: Rect,
    // CSS order: top-left, top-right, bottom-right, bottom-left.
    pub corners: [CornerRadius; 4],
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourcePanel {
    SpDefaultNameplate,
    ChipColumnsValue,
    SingleChipValue,
    UpperPot,
    StatusAnnouncement,
    GameIdTab,
}

impl SourcePanel {
    pub fn radius_fraction(self) -> f64 {
        match self {
            // Recovered react.css: SP radius .91em; default player-bar height 3.51em.
            Self::SpDefaultNameplate => 0.91 / 3.51,
            // .3em / (line 1em + vertical padding .1em + .1em).
            Self::ChipColumnsValue => 0.3 / 1.2,
            Self::SingleChipValue => 0.2 / 1.2,
            // SP content line-height 1.1em outranks the generic line-height override.
            Self::UpperPot => 0.3 / 1.1,
            Self::StatusAnnouncement => 0.28 / 1.25,
            Self::GameIdTab => 0.5 / 1.6,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MaskDescriptor {
    pub policy: String,
    pub source: SourcePanel,
    pub neutral_rgb: [u8; 3],
    pub panels: Vec<RoundedPanel>,
}

pub struct MaskedCrop {
    pub rgb: RgbImage,
    // Coverage is separate from canonical RGB and must accompany masked CV inputs.
    pub valid_mask: GrayImage,
}

fn valid_rect(rect: Rect) -> bool {
    [rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|value| value.is_finite())
        && rect.width > 0.0
        && rect.height > 0.0
        && (rect.x + rect.width).is_finite()
        && (rect.y + rect.height).is_finite()
}

pub fn from_resolved_panels(
    source: SourcePanel,
    crop_origin: [f64; 2],
    resolved_panels: &[Rect],
) -> LabResult<MaskDescriptor> {
    if crop_origin.iter().any(|value| !value.is_finite())
        || resolved_panels.is_empty()
        || resolved_panels.len() > 10
        || resolved_panels.iter().any(|rect| !valid_rect(*rect))
    {
        return Err(bad("A crop mask requires finite resolved panel bounds"));
    }
    let panels = resolved_panels
        .iter()
        .map(|rect| {
            let radius = rect.height * source.radius_fraction();
            RoundedPanel {
                bounds: Rect {
                    x: rect.x - crop_origin[0],
                    y: rect.y - crop_origin[1],
                    ..*rect
                },
                corners: if source == SourcePanel::GameIdTab {
                    [
                        CornerRadius { x: 0., y: 0. },
                        CornerRadius {
                            x: radius,
                            y: radius,
                        },
                        CornerRadius {
                            x: radius,
                            y: radius,
                        },
                        CornerRadius { x: 0., y: 0. },
                    ]
                } else {
                    [CornerRadius {
                        x: radius,
                        y: radius,
                    }; 4]
                },
            }
        })
        .collect();
    Ok(MaskDescriptor {
        policy: POLICY.into(),
        source,
        neutral_rgb: NEUTRAL_RGB,
        panels,
    })
}

fn normalized(panel: &RoundedPanel) -> LabResult<RoundedPanel> {
    if !valid_rect(panel.bounds)
        || panel.corners.iter().any(|radius| {
            !radius.x.is_finite() || !radius.y.is_finite() || radius.x < 0.0 || radius.y < 0.0
        })
    {
        return Err(bad(
            "Crop mask bounds and corner radii must be finite and nonnegative",
        ));
    }
    let mut result = panel.clone();
    for radius in &mut result.corners {
        if radius.x == 0.0 || radius.y == 0.0 {
            *radius = CornerRadius { x: 0.0, y: 0.0 };
        }
    }
    let c = result.corners;
    let mut factor = 1.0f64;
    for (available, requested) in [
        (panel.bounds.width, c[0].x + c[1].x),
        (panel.bounds.width, c[3].x + c[2].x),
        (panel.bounds.height, c[0].y + c[3].y),
        (panel.bounds.height, c[1].y + c[2].y),
    ] {
        if !requested.is_finite() {
            return Err(bad("Crop mask corner radii overflow their bounds"));
        }
        if requested > available {
            factor = factor.min(available / requested);
        }
    }
    for radius in &mut result.corners {
        radius.x *= factor;
        radius.y *= factor;
    }
    Ok(result)
}

fn contains(panel: &RoundedPanel, x: f64, y: f64) -> bool {
    let b = panel.bounds;
    let x = x - b.x;
    let y = y - b.y;
    if x < 0.0 || y < 0.0 || x > b.width || y > b.height {
        return false;
    }
    for (radius, cx, cy, corner) in [
        (panel.corners[0], panel.corners[0].x, panel.corners[0].y, 0),
        (
            panel.corners[1],
            b.width - panel.corners[1].x,
            panel.corners[1].y,
            1,
        ),
        (
            panel.corners[2],
            b.width - panel.corners[2].x,
            b.height - panel.corners[2].y,
            2,
        ),
        (
            panel.corners[3],
            panel.corners[3].x,
            b.height - panel.corners[3].y,
            3,
        ),
    ] {
        let in_corner = match corner {
            0 => x < cx && y < cy,
            1 => x > cx && y < cy,
            2 => x > cx && y > cy,
            _ => x < cx && y > cy,
        };
        if in_corner && radius.x > 0.0 && radius.y > 0.0 {
            if ((x - cx) / radius.x).powi(2) + ((y - cy) / radius.y).powi(2) > 1.0 {
                return false;
            }
        }
    }
    true
}

pub fn apply(crop: &RgbImage, descriptor: &MaskDescriptor) -> LabResult<MaskedCrop> {
    if descriptor.policy != POLICY
        || descriptor.panels.is_empty()
        || descriptor.panels.len() > 10
        || crop.width() == 0
        || crop.height() == 0
        || u64::from(crop.width()) * u64::from(crop.height()) > 16_000_000
    {
        return Err(bad("Unsupported or empty crop mask"));
    }
    let panels = descriptor
        .panels
        .iter()
        .map(normalized)
        .collect::<LabResult<Vec<_>>>()?;
    if panels.iter().any(|panel| {
        panel.bounds.x >= f64::from(crop.width())
            || panel.bounds.y >= f64::from(crop.height())
            || panel.bounds.x + panel.bounds.width <= 0.0
            || panel.bounds.y + panel.bounds.height <= 0.0
    }) {
        return Err(bad("Resolved mask panel does not intersect its crop"));
    }
    let mut rgb = RgbImage::new(crop.width(), crop.height());
    let mut valid_mask = GrayImage::new(crop.width(), crop.height());
    for (x, y, input) in crop.enumerate_pixels() {
        let (left, top) = (f64::from(x), f64::from(y));
        let interior = panels.iter().any(|panel| {
            [
                (left, top),
                (left + 1.0, top),
                (left, top + 1.0),
                (left + 1.0, top + 1.0),
            ]
            .iter()
            .all(|(x, y)| contains(panel, *x, *y))
        });
        let samples = if interior {
            16u16
        } else {
            let mut samples = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = left + (f64::from(sx) + 0.5) / 4.0;
                    let py = top + (f64::from(sy) + 0.5) / 4.0;
                    samples += u16::from(panels.iter().any(|panel| contains(panel, px, py)));
                }
            }
            samples
        };
        let coverage = ((samples * 255 + 8) / 16) as u8;
        let output = std::array::from_fn(|channel| {
            ((u16::from(input.0[channel]) * samples
                + u16::from(descriptor.neutral_rgb[channel]) * (16 - samples)
                + 8)
                / 16) as u8
        });
        rgb.put_pixel(x, y, Rgb(output));
        valid_mask.put_pixel(x, y, Luma([coverage]));
    }
    Ok(MaskedCrop { rgb, valid_mask })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor(width: f64, height: f64) -> MaskDescriptor {
        from_resolved_panels(
            SourcePanel::ChipColumnsValue,
            [0.0, 0.0],
            &[Rect {
                x: 0.0,
                y: 0.0,
                width,
                height,
            }],
        )
        .unwrap()
    }
    #[test]
    fn source_rules_distinguish_panel_families_and_width_growth_preserves_radius() {
        assert_eq!(
            SourcePanel::SpDefaultNameplate.radius_fraction(),
            0.91 / 3.51
        );
        assert_eq!(SourcePanel::UpperPot.radius_fraction(), 0.3 / 1.1);
        assert_ne!(
            SourcePanel::SingleChipValue.radius_fraction(),
            SourcePanel::ChipColumnsValue.radius_fraction()
        );
        assert_eq!(
            descriptor(60.0, 36.0).panels[0].corners,
            descriptor(600.0, 36.0).panels[0].corners
        );
    }
    #[test]
    fn asymmetric_zero_and_css_overlapping_radii_follow_each_corner() {
        let mut d = descriptor(20.0, 20.0);
        d.panels[0].corners = [
            CornerRadius { x: 8.0, y: 8.0 },
            CornerRadius { x: 0.0, y: 0.0 },
            CornerRadius { x: 4.0, y: 8.0 },
            CornerRadius { x: 0.0, y: 0.0 },
        ];
        let crop = RgbImage::from_pixel(20, 20, Rgb([255, 255, 255]));
        let result = apply(&crop, &d).unwrap();
        assert_eq!(result.valid_mask.get_pixel(0, 0).0, [0]);
        assert_eq!(result.valid_mask.get_pixel(19, 0).0, [255]);
        assert_eq!(result.valid_mask.get_pixel(0, 19).0, [255]);
        assert!(result.valid_mask.get_pixel(19, 19).0[0] < 255);
        d.panels[0].corners = [CornerRadius { x: 30.0, y: 10.0 }; 4];
        let n = normalized(&d.panels[0]).unwrap();
        assert_eq!(n.corners[0].x, 10.0);
        assert!((n.corners[0].y - 10.0 / 3.0).abs() < 1e-9);
    }
    #[test]
    fn overlapping_corner_regions_must_satisfy_both_ellipses() {
        let panel = RoundedPanel {
            bounds: Rect {
                x: 0.,
                y: 0.,
                width: 10.,
                height: 10.,
            },
            corners: [
                CornerRadius { x: 8., y: 8. },
                CornerRadius { x: 0., y: 0. },
                CornerRadius { x: 8., y: 8. },
                CornerRadius { x: 0., y: 0. },
            ],
        };
        assert!(!contains(&panel, 7.9, 7.9));
    }
    #[test]
    fn invalid_radii_and_missing_panels_fail_closed() {
        let crop = RgbImage::from_pixel(20, 20, Rgb([255, 255, 255]));
        for value in [-1.0, f64::NAN, f64::INFINITY] {
            let mut d = descriptor(20.0, 20.0);
            d.panels[0].corners[0].x = value;
            assert!(apply(&crop, &d).is_err());
        }
        assert!(from_resolved_panels(SourcePanel::UpperPot, [0.0, 0.0], &[]).is_err());
    }
    #[test]
    fn separate_panels_mask_gap_preserve_marker_and_antialias_edges() {
        let crop = RgbImage::from_pixel(90, 30, Rgb([180, 220, 255]));
        let d = from_resolved_panels(
            SourcePanel::ChipColumnsValue,
            [0.0, 0.0],
            &[
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 40.0,
                    height: 30.0,
                },
                Rect {
                    x: 50.0,
                    y: 0.0,
                    width: 40.0,
                    height: 30.0,
                },
            ],
        )
        .unwrap();
        let result = apply(&crop, &d).unwrap();
        assert_eq!(result.rgb.get_pixel(45, 15).0, NEUTRAL_RGB);
        for (x, y) in [(8, 15), (18, 15), (31, 15), (58, 15), (78, 15)] {
            assert_eq!(result.rgb.get_pixel(x, y), crop.get_pixel(x, y));
            assert_eq!(result.valid_mask.get_pixel(x, y).0, [255]);
        }
        assert!(result
            .valid_mask
            .pixels()
            .any(|pixel| pixel.0[0] > 0 && pixel.0[0] < 255));
    }
    #[test]
    fn subrows_intersect_full_nameplate_shape_instead_of_rounding_row() {
        let full = Rect {
            x: 100.0,
            y: 200.0,
            width: 200.0,
            height: 81.0,
        };
        let top =
            from_resolved_panels(SourcePanel::SpDefaultNameplate, [100.0, 200.0], &[full]).unwrap();
        let lower =
            from_resolved_panels(SourcePanel::SpDefaultNameplate, [100.0, 240.0], &[full]).unwrap();
        let top = apply(&RgbImage::from_pixel(200, 40, Rgb([255, 255, 255])), &top).unwrap();
        let lower = apply(&RgbImage::from_pixel(200, 33, Rgb([255, 255, 255])), &lower).unwrap();
        assert_eq!(top.valid_mask.get_pixel(0, 0).0, [0]);
        assert_eq!(top.valid_mask.get_pixel(0, 39).0, [255]);
        assert_eq!(lower.valid_mask.get_pixel(0, 0).0, [255]);
        assert!(lower.valid_mask.get_pixel(0, 32).0[0] < 255);
    }
}

#[cfg(test)]
mod game_id_tab_tests {
    use super::*;
    #[test]
    fn source_game_id_tab_only_rounds_its_right_caps() {
        let d = from_resolved_panels(
            SourcePanel::GameIdTab,
            [0., 0.],
            &[Rect {
                x: 0.,
                y: 0.,
                width: 100.,
                height: 32.,
            }],
        )
        .unwrap();
        let p = &d.panels[0];
        assert_eq!(p.corners[0], CornerRadius { x: 0., y: 0. });
        assert_eq!(p.corners[3], CornerRadius { x: 0., y: 0. });
        assert_eq!(p.corners[1], CornerRadius { x: 10., y: 10. });
        assert_eq!(p.corners[2], p.corners[1]);
        let image = RgbImage::from_pixel(100, 32, Rgb([200; 3]));
        let result = apply(&image, &d).unwrap();
        assert_eq!(result.valid_mask.get_pixel(0, 0).0[0], 255);
        assert_eq!(result.valid_mask.get_pixel(99, 0).0[0], 0);
    }
}
