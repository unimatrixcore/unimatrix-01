use super::{bad, region_group, Item, LabResult};
use ab_glyph::FontArc;
use image::{
    imageops::{self, FilterType},
    DynamicImage, ImageFormat, Rgb, RgbImage,
};
use imageproc::drawing::{draw_text_mut, text_size};
use std::io::Cursor;
pub fn build(items: &[Item], blind: bool) -> LabResult<Vec<u8>> {
    if items.is_empty() || items.len() > 24 {
        return Err(bad("A grid requires 1 to 24 crops"));
    }
    let font = [
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    .iter()
    .find_map(|path| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| FontArc::try_from_vec(bytes).ok())
    })
    .or_else(|| FontArc::try_from_slice(include_bytes!("DejaVuSansMono.ttf")).ok())
    .ok_or_else(|| bad("Visual review contact sheet font is invalid"))?;
    let columns = items.len().min(4) as u32;
    let rows = (items.len() as u32).div_ceil(columns);
    let mut canvas = RgbImage::from_pixel(columns * 420, 44 + rows * 204, Rgb([17, 19, 21]));
    let title = format!(
        "{} / {}",
        region_group(&items[0].region_id),
        if blind {
            "independent reading"
        } else {
            "label check"
        }
    );
    draw_text_mut(
        &mut canvas,
        Rgb([231, 238, 238]),
        14,
        12,
        19.,
        &font,
        &title.chars().take(100).collect::<String>(),
    );
    for (index, item) in items.iter().enumerate() {
        let x = index as u32 % columns * 420;
        let y = 44 + index as u32 / columns * 204;
        for (cx, cy, color) in [(x, y, Rgb([8, 10, 11])), (x, y + 132, Rgb([28, 32, 35]))] {
            let h = if cy == y { 132 } else { 72 };
            for yy in cy..cy + h {
                for xx in cx..cx + 420 {
                    canvas.put_pixel(
                        xx,
                        yy,
                        if yy == cy || yy == cy + h - 1 || xx == cx || xx == cx + 419 {
                            Rgb([69, 80, 84])
                        } else {
                            color
                        },
                    );
                }
            }
        }
        draw_text_mut(
            &mut canvas,
            Rgb([204, 216, 219]),
            (x + 10) as i32,
            (y + 8) as i32,
            15.,
            &font,
            &format!("ID {}  {}", item.ordinal, item.region_id),
        );
        let (width, height) = image::ImageReader::new(Cursor::new(&item.crop))
            .with_guessed_format()
            .map_err(|e| bad(e.to_string()))?
            .into_dimensions()
            .map_err(|e| bad(e.to_string()))?;
        if width as u64 * height as u64 > 16_000_000 {
            return Err(bad("Crop exceeds image limit"));
        }
        let original = image::load_from_memory(&item.crop).map_err(|e| bad(e.to_string()))?;
        let scale = (396.0 / original.width() as f64)
            .min(90.0 / original.height() as f64)
            .min(4.);
        let w = (original.width() as f64 * scale).round().max(1.) as u32;
        let h = (original.height() as f64 * scale).round().max(1.) as u32;
        let crop = imageops::resize(&original.to_rgb8(), w, h, FilterType::Nearest);
        imageops::replace(
            &mut canvas,
            &crop,
            (x + (420 - w) / 2) as i64,
            (y + 30 + (98 - h) / 2) as i64,
        );
        let label = if blind {
            "Read crop only"
        } else if item.prior_label.is_empty() {
            "(empty label)"
        } else {
            &item.prior_label
        };
        let mut remaining = label.to_string();
        let mut cell = RgbImage::from_pixel(400, 64, Rgb([28, 32, 35]));
        for line in 0..2 {
            let chars: Vec<_> = remaining.chars().collect();
            let mut take = chars.len();
            while take > 0
                && text_size(19., &font, &chars[..take].iter().collect::<String>()).0 > 396
            {
                take -= 1;
            }
            let mut text = chars[..take].iter().collect::<String>();
            remaining = chars[take..].iter().collect();
            if line == 1 && !remaining.is_empty() {
                text = text
                    .chars()
                    .take(text.chars().count().saturating_sub(3))
                    .chain("...".chars())
                    .collect();
            }
            draw_text_mut(
                &mut cell,
                Rgb([231, 238, 238]),
                0,
                line * 25,
                19.,
                &font,
                &text,
            );
            if remaining.is_empty() {
                break;
            }
        }
        imageops::replace(&mut canvas, &cell, (x + 10) as i64, (y + 139) as i64);
    }
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(canvas)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| bad(e.to_string()))?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;
    #[test]
    fn contact_sheet_keeps_color_geometry_identity_and_blind_label_separate() {
        let mut crop = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(20, 10, Rgb([230, 40, 70])))
            .write_to(&mut crop, ImageFormat::Png)
            .unwrap();
        let item = Item {
            job_id: "fixture".into(),
            ordinal: 29,
            batch_index: 0,
            queue_id: 1,
            sample_key: "sample".into(),
            region_id: "seats[2].name".into(),
            group_name: "seats[*].name".into(),
            prior_label: "Alice".into(),
            prior_prediction_id: None,
            pixel_sha256: "hash".into(),
            prior_event_id: 0,
            crop: crop.into_inner(),
        };
        let annotated = build(std::slice::from_ref(&item), false).unwrap();
        let blind = build(std::slice::from_ref(&item), true).unwrap();
        let image = image::load_from_memory(&annotated).unwrap().to_rgb8();
        let independent = image::load_from_memory(&blind).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (420, 248));
        assert_eq!(*image.get_pixel(210, 123), Rgb([230, 40, 70]));
        assert_eq!(
            image.view(0, 44, 420, 132).to_image(),
            independent.view(0, 44, 420, 132).to_image()
        );
        assert_ne!(
            image.view(0, 176, 420, 72).to_image(),
            independent.view(0, 176, 420, 72).to_image()
        );
        assert!(build(&[], false).is_err());
        assert!(build(&vec![item; 25], false).is_err());
    }
}
