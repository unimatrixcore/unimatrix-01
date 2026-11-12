use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
pub fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image size exceeds limit".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("Image decode failed: {e}"))
}
pub fn png(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    img.write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
}
pub fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}
pub fn from_data_url(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > MAX_IMAGE_BYTES * 2 {
        return Err("Image data too large".into());
    }
    let value = value
        .strip_prefix("data:image/png;base64,")
        .or_else(|| value.strip_prefix("data:image/jpeg;base64,"))
        .ok_or("Unsupported image data URL")?;
    let bytes = STANDARD.decode(value).map_err(|e| e.to_string())?;
    decode_image(&bytes)?;
    Ok(bytes)
}
pub fn collector_grayscale(img: &DynamicImage) -> image::GrayImage {
    let rgb = img.to_rgb8();
    image::GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let p = rgb.get_pixel(x, y);
        image::Luma([((19595 * u32::from(p[0])
            + 38470 * u32::from(p[1])
            + 7471 * u32::from(p[2])
            + 32768)
            >> 16) as u8])
    })
}
fn legacy_resize(image: &image::GrayImage, width: u32, height: u32) -> image::GrayImage {
    const PRECISION: i64 = 1 << 22;
    fn coefficients(input: u32, output: u32) -> Vec<(u32, Vec<i64>)> {
        let scale = f64::from(input) / f64::from(output);
        let filter_scale = scale.max(1.0);
        let support = 3.0 * filter_scale;
        (0..output)
            .map(|position| {
                let center = (f64::from(position) + 0.5) * scale;
                let minimum = ((center - support + 0.5) as i64).max(0) as u32;
                let maximum = ((center + support + 0.5) as i64).min(i64::from(input)) as u32;
                let weights: Vec<f64> = (minimum..maximum)
                    .map(|sample| {
                        let x = (f64::from(sample) - center + 0.5) / filter_scale;
                        if x == 0.0 {
                            1.0
                        } else if !(-3.0..3.0).contains(&x) {
                            0.0
                        } else {
                            let pi_x = x * std::f64::consts::PI;
                            (pi_x.sin() / pi_x) * ((pi_x / 3.0).sin() / (pi_x / 3.0))
                        }
                    })
                    .collect();
                let sum: f64 = weights.iter().sum();
                let weights = weights
                    .into_iter()
                    .map(|weight| {
                        let scaled = if sum == 0.0 { 0.0 } else { weight / sum } * PRECISION as f64;
                        (scaled + if scaled < 0.0 { -0.5 } else { 0.5 }) as i64
                    })
                    .collect();
                (minimum, weights)
            })
            .collect()
    }
    let horizontal = if image.width() == width {
        image.clone()
    } else {
        let coefficients = coefficients(image.width(), width);
        image::GrayImage::from_fn(width, image.height(), |x, y| {
            let (minimum, weights) = &coefficients[x as usize];
            let total = weights
                .iter()
                .enumerate()
                .fold(PRECISION / 2, |sum, (i, weight)| {
                    sum + i64::from(image.get_pixel(*minimum + i as u32, y)[0]) * weight
                });
            image::Luma([(total >> 22).clamp(0, 255) as u8])
        })
    };
    if image.height() == height {
        return horizontal;
    }
    let coefficients = coefficients(image.height(), height);
    image::GrayImage::from_fn(width, height, |x, y| {
        let (minimum, weights) = &coefficients[y as usize];
        let total = weights
            .iter()
            .enumerate()
            .fold(PRECISION / 2, |sum, (i, weight)| {
                sum + i64::from(horizontal.get_pixel(x, *minimum + i as u32)[0]) * weight
            });
        image::Luma([(total >> 22).clamp(0, 255) as u8])
    })
}
pub fn dhash(img: &DynamicImage) -> String {
    let resized = legacy_resize(&collector_grayscale(img), 17, 16);
    let mut bytes = [0u8; 32];
    for row in 0..16 {
        for col in 0..16 {
            if resized.get_pixel(col, row)[0] > resized.get_pixel(col + 1, row)[0] {
                let n = (row * 16 + col) as usize;
                bytes[n / 8] |= 1 << (n % 8);
            }
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hamming(a: &str, b: &str) -> u32 {
    if !a.is_ascii() || !b.is_ascii() || a.len() != 64 || b.len() != 64 {
        return u32::MAX;
    }
    let mut count = 0;
    for n in (0..64).step_by(2) {
        let (Ok(a), Ok(b)) = (
            u8::from_str_radix(&a[n..n + 2], 16),
            u8::from_str_radix(&b[n..n + 2], 16),
        ) else {
            return u32::MAX;
        };
        count += (a ^ b).count_ones();
    }
    count
}
