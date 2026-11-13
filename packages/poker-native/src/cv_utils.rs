use image::{DynamicImage, GenericImageView, Luma, Rgba};
use imageproc::template_matching::{match_template, MatchTemplateMethod};
use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use std::sync::OnceLock;

static OCR_ENGINE: OnceLock<OcrEngine> = OnceLock::new();

/// Initializes and returns a reference to the global OCR engine.
/// Bundles neural network models via include_bytes! for full portability.
fn get_ocr_engine() -> &'static OcrEngine {
    OCR_ENGINE.get_or_init(|| {
        eprintln!("[poker] Initializing ocrs engine...");

        // Bundle models into the binary
        let detection_model_data = include_bytes!("../assets/models/text-detection.rten");
        let recognition_model_data = include_bytes!("../assets/models/text-recognition.rten");

        let detection_model = rten::Model::load_static_slice(detection_model_data)
            .expect("Failed to load detection model");
        let recognition_model = rten::Model::load_static_slice(recognition_model_data)
            .expect("Failed to load recognition model");

        OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
        .expect("Failed to create OCR engine")
    })
}

/// Extracts text from a DynamicImage using the ocrs engine.
pub fn extract_text(img: &image::DynamicImage) -> Result<String, String> {
    let engine = get_ocr_engine();

    // Convert DynamicImage to ocrs-compatible ImageSource
    // ocrs expects RGB data.
    let rgb_img = img.to_rgb8();
    let (width, height) = rgb_img.dimensions();
    let source = ImageSource::from_bytes(rgb_img.as_raw(), (width, height))
        .map_err(|e| format!("Failed to create ImageSource: {}", e))?;

    let input = engine
        .prepare_input(source)
        .map_err(|e| format!("Failed to prepare OCR input: {}", e))?;

    let ocr_text = engine
        .get_text(&input)
        .map_err(|e| format!("OCR inference failed: {}", e))?;

    Ok(ocr_text)
}

/// Matches a template within a source image.
/// Returns the (x, y) coordinates of the best match if it exceeds the threshold.
pub fn match_feature(
    img: &DynamicImage,
    template: &DynamicImage,
    threshold: f32,
) -> Option<(u32, u32)> {
    let result = match_template(
        &img.to_luma8(),
        &template.to_luma8(),
        MatchTemplateMethod::CrossCorrelationNormalized,
    );

    let mut max_val = 0.0;
    let mut max_pos = (0, 0);

    for y in 0..result.height() {
        for x in 0..result.width() {
            let val = result.get_pixel(x, y)[0];
            if val > max_val {
                max_val = val;
                max_pos = (x, y);
            }
        }
    }

    if max_val >= threshold {
        Some(max_pos)
    } else {
        None
    }
}

/// Calculates what percentage of the image consists of the provided hex colors.
/// Returns a value between 0.0 and 1.0.
pub fn color_density(img: &DynamicImage, hex_colors: &[String], tolerance: i32) -> f32 {
    let mut target_rgbas = Vec::new();
    for hex in hex_colors {
        if let Ok(rgba) = parse_hex_to_rgba(hex) {
            target_rgbas.push(rgba);
        }
    }

    if target_rgbas.is_empty() {
        return 0.0;
    }

    let mut match_count = 0;
    let (w, h) = img.dimensions();
    let total_pixels = w * h;

    if total_pixels == 0 {
        return 0.0;
    }

    for (_, _, pixel) in img.pixels() {
        for target in &target_rgbas {
            if is_color_similar(&pixel, target, tolerance) {
                match_count += 1;
                break;
            }
        }
    }

    (match_count as f32) / (total_pixels as f32)
}

/// Helper to parse #RRGGBB or #RRGGBBAA to Rgba<u8>
fn parse_hex_to_rgba(hex: &str) -> Result<Rgba<u8>, String> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 && hex.len() != 8 {
        return Err("Invalid hex length".into());
    }

    let r = u8::from_str_radix(&hex[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&hex[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&hex[4..6], 16).map_err(|e| e.to_string())?;
    let a = if hex.len() == 8 {
        u8::from_str_radix(&hex[6..8], 16).map_err(|e| e.to_string())?
    } else {
        255
    };

    Ok(Rgba([r, g, b, a]))
}

/// Simple color similarity check with a tolerance
fn is_color_similar(c1: &Rgba<u8>, c2: &Rgba<u8>, tolerance: i32) -> bool {
    let dr = (c1[0] as i32 - c2[0] as i32).abs();
    let dg = (c1[1] as i32 - c2[1] as i32).abs();
    let db = (c1[2] as i32 - c2[2] as i32).abs();

    dr <= tolerance && dg <= tolerance && db <= tolerance
}

/// Preprocesses a name region image for better OCR.
/// Converts to grayscale and applies a threshold to make text stand out.
pub fn preprocess_for_ocr(img: &DynamicImage) -> DynamicImage {
    let mut grayscale = img.to_luma8();

    // Apply threshold: everything > 120 becomes white, else black.
    // Lowered from 140 to be more inclusive of dim cards or shadows.
    for pixel in grayscale.pixels_mut() {
        if pixel.0[0] > 120 {
            *pixel = Luma([255]);
        } else {
            *pixel = Luma([0]);
        }
    }

    DynamicImage::ImageLuma8(grayscale)
}

/// Detects the dominant suit color in an image region.
/// Returns the key of the suit if it exceeds the minimum density threshold.
pub fn detect_suit(
    img: &DynamicImage,
    suit_colors: &std::collections::HashMap<String, String>,
    threshold: f32,
) -> Option<String> {
    let mut best_suit = None;
    let mut max_density = 0.0;
    let mut debug_info = Vec::new();

    for (suit, hex) in suit_colors {
        // Increased tolerance to 30 to handle compression/lighting variations
        let density = color_density(img, &[hex.clone()], 30);
        debug_info.push(format!("{}: {:.4}", suit, density));
        if density > threshold && density > max_density {
            max_density = density;
            best_suit = Some(suit.clone());
        }
    }

    if let Some(ref s) = best_suit {
        eprintln!(
            "[poker] Suit detected: '{}' (density: {:.4}) - All: [{}]",
            s,
            max_density,
            debug_info.join(", ")
        );
    } else if max_density > 0.001 {
        eprintln!(
            "[poker] No suit met threshold ({:.3}) - All: [{}]",
            threshold,
            debug_info.join(", ")
        );
    }

    best_suit
}

/// Isolates a specific color in the image, making it black and everything else white (or vice versa).
/// Good for OCR when text color is known.
pub fn isolate_color(img: &DynamicImage, target_hex: &str, tolerance: i32) -> DynamicImage {
    let target = parse_hex_to_rgba(target_hex).unwrap_or(Rgba([242, 242, 242, 255]));
    let (w, h) = img.dimensions();
    let mut out = image::ImageBuffer::new(w, h);

    for (x, y, pixel) in img.pixels() {
        if is_color_similar(&pixel, &target, tolerance) {
            out.put_pixel(x, y, Luma([0])); // Black text
        } else {
            out.put_pixel(x, y, Luma([255])); // White background
        }
    }

    DynamicImage::ImageLuma8(out)
}

/// Identifies a card rank from an image region using OCR.
pub fn detect_rank(img: &DynamicImage, target_text_color: Option<&str>) -> Option<String> {
    // 1. Check rank color density before proceeding
    if let Some(hex) = target_text_color {
        let density = color_density(img, &[hex.to_string()], 35);
        if density < 0.01 {
            // If less than 1% of the image has the text color, it's likely not a card face
            return None;
        }
    }

    // 2. Upscale the image (OCR typically performs better on larger text)
    let (w, h) = img.dimensions();
    let upscaled = img.resize(w * 3, h * 3, image::imageops::FilterType::Lanczos3);

    // 3. Preprocess for OCR
    // Note: ocrs often requires less preprocessing than Tesseract.
    // If accuracy is low, consider reducing thresholding or using just contrast/upscale.
    let preprocessed = if let Some(hex) = target_text_color {
        isolate_color(&upscaled, hex, 35) // Using color isolation if hex is provided
    } else {
        preprocess_for_ocr(&upscaled)
    };

    let text = extract_text(&preprocessed)
        .unwrap_or_default()
        .to_uppercase();

    // Clean text: only keep alphanumeric
    let cleaned: String = text.chars().filter(|c| c.is_alphanumeric()).collect();

    // Debug log to terminal
    if !cleaned.is_empty() {
        eprintln!(
            "[poker] OCR Rank raw: '{}' cleaned: '{}'",
            text.trim(),
            cleaned
        );
    }

    let ranks = vec![
        "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
    ];

    // Try exact match first
    for rank in ranks {
        if cleaned == rank {
            return Some(rank.to_string());
        }
    }

    // Common OCR misreads (exact matches)
    match cleaned.as_str() {
        "B" | "3" => return Some("8".to_string()), // 8 often read as B or 3
        "S" | "5" => return Some("5".to_string()),
        "G" | "6" => return Some("6".to_string()),
        "Z" | "2" => return Some("2".to_string()),
        "T" | "0" | "10" | "IO" | "1O" | "I0" => return Some("10".to_string()),
        "Q" | "O" => {
            // If it's just 'O' it might be 'Q' or part of '10'.
            // Contains check below might handle '10'.
        }
        _ => {}
    }

    // Try contains (for noise around the rank)
    let ranks_priority = vec![
        "10", "A", "2", "3", "4", "5", "6", "7", "8", "9", "J", "Q", "K",
    ];
    for rank in ranks_priority {
        if cleaned.contains(rank) {
            return Some(rank.to_string());
        }
    }

    // Specific contains fallbacks
    if cleaned.contains("IO") || cleaned.contains("1O") || cleaned.contains("I0") {
        return Some("10".to_string());
    }
    if cleaned.contains("B") {
        return Some("8".to_string());
    }

    None
}
