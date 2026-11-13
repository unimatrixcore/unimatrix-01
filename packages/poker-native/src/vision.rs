use base64::Engine;
use image::{DynamicImage, GenericImageView};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
pub struct RegionRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SeatRegions {
    pub name: Option<RegionRect>,
    pub nameplate: Option<RegionRect>,
    pub bank: Option<RegionRect>,
    pub bet: Option<RegionRect>,
    pub cards: Option<Vec<Option<RegionRect>>>,
    pub status: Option<RegionRect>,
    pub dealer: Option<RegionRect>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegionConfig {
    pub screen_width: u32,
    pub screen_height: u32,
    pub note: Option<String>,
    pub round_id: Option<RegionRect>,
    pub community_cards: Option<Vec<Option<RegionRect>>>,
    pub pot: Option<RegionRect>,
    pub split_pot: Option<RegionRect>,
    pub seats: Option<Vec<Option<SeatRegions>>>,
}

#[derive(Serialize)]
pub struct CroppedRegion {
    pub id: String,
    pub rect: RegionRect,
    // Base64 PNG image for frontend processing or debugging
    pub base64_image: String,
}

/// Verifies if a game is open in fullscreen by checking for a game ID in the round_id region.
pub fn verify_fullscreen_game(
    screenshot_bytes: &[u8],
    active_config: &RegionConfig,
) -> Result<bool, String> {
    let img = crate::media::decode_image(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    // Load config to find round_id region
    let config = active_config.clone();
    validate_active_config(&config, &img)?;

    if let Some(rect) = config.round_id {
        if rect.x + rect.w <= img.width() && rect.y + rect.h <= img.height() {
            let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
            let text = crate::cv_utils::extract_text(&cropped)?;

            // Regex for game ID like # 123456
            let re = Regex::new(r"#\s*\d{6,15}").map_err(|e| e.to_string())?;
            return Ok(re.is_match(&text));
        }
    }

    Ok(false)
}

/// Helper function to crop a specific rect from an image and encode it to base64
fn crop_and_encode(img: &DynamicImage, rect: &RegionRect) -> Result<String, String> {
    let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    cropped
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Parses the regions.json config and crops all defined regions from the screenshot.
/// Returns a list of cropped regions with their ID, coordinates, and base64 encoded PNG data.
pub fn extract_regions(
    screenshot_bytes: &[u8],
    active_config: &RegionConfig,
) -> Result<Vec<CroppedRegion>, String> {
    // Load config from compiled assets
    let config = active_config.clone();

    let img = crate::media::decode_image(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    validate_active_config(&config, &img)?;
    let mut results = Vec::new();

    let mut add_crop = |id: &str, rect: Option<RegionRect>| {
        if let Some(r) = rect {
            if r.x + r.w <= img.width() && r.y + r.h <= img.height() {
                if let Ok(b64) = crop_and_encode(&img, &r) {
                    results.push(CroppedRegion {
                        id: id.to_string(),
                        rect: r,
                        base64_image: b64,
                    });
                }
            }
        }
    };

    // Game info
    add_crop("round_id", config.round_id);
    add_crop("pot.main", config.pot);
    add_crop("pot.split", config.split_pot);

    // Community cards
    if let Some(cards) = config.community_cards {
        for (i, card) in cards.iter().enumerate() {
            add_crop(&format!("community.card_{}", i + 1), *card);
        }
    }

    // Seats
    if let Some(seats) = config.seats {
        for (i, seat) in seats.iter().enumerate() {
            if let Some(s) = seat {
                add_crop(&format!("seat.{}.name", i), s.name);
                add_crop(&format!("seat.{}.nameplate", i), s.nameplate);
                add_crop(&format!("seat.{}.bank", i), s.bank);
                add_crop(&format!("seat.{}.bet", i), s.bet);
                add_crop(&format!("seat.{}.status", i), s.status);
                add_crop(&format!("seat.{}.dealer", i), s.dealer);

                if let Some(ref cards) = s.cards {
                    for (c_idx, card) in cards.iter().enumerate() {
                        add_crop(&format!("seat.{}.hand_{}", i, c_idx), *card);
                    }
                }
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SuitColors {
    pub diamonds: String,
    pub spades: String,
    pub clubs: String,
    pub hearts: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ColorConfig {
    pub nameplate: String,
    pub in_turn: String,
    pub in_turn_urgent: String,
    pub card_text: String,
    pub dim_text: String,
    pub suits: SuitColors,
    pub dim_suits: SuitColors,
}

#[derive(Serialize)]
pub struct GameState {
    pub in_play_seats: Vec<u32>,
    pub seat_usernames: std::collections::HashMap<u32, String>,
    pub seat_cards: std::collections::HashMap<u32, Vec<String>>,
    pub seat_bets: std::collections::HashMap<u32, String>,
    pub active_seat: Option<u32>,
    pub active_seat_color: Option<String>,
    pub my_seat_index: Option<u32>,
    pub community_cards: Vec<Option<String>>,
    pub game_id: Option<String>,
}

/// Identifies which seats are in play and finds the user's seat index using OCR.
pub fn process_game_state(
    screenshot_bytes: &[u8],
    target_username: &str,
    active_config: &RegionConfig,
) -> Result<GameState, String> {
    let img = crate::media::decode_image(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    let config = active_config.clone();
    validate_active_config(&config, &img)?;

    let color_str = include_str!("../assets/colors.json");
    let colors: ColorConfig = serde_json::from_str(color_str)
        .map_err(|e| format!("Failed to parse colors.json: {}", e))?;

    let mut in_play_seats = Vec::new();
    let mut seat_usernames = std::collections::HashMap::new();
    let mut seat_cards = std::collections::HashMap::new();
    let mut seat_bets = std::collections::HashMap::new();
    let mut active_seat = None;
    let mut active_seat_color = None;
    let mut my_seat_index = None;
    let mut game_id = None;
    let mut community_cards = Vec::new();

    let mut suit_map = std::collections::HashMap::new();
    suit_map.insert("d".to_string(), colors.suits.diamonds.clone());
    suit_map.insert("s".to_string(), colors.suits.spades.clone());
    suit_map.insert("c".to_string(), colors.suits.clubs.clone());
    suit_map.insert("h".to_string(), colors.suits.hearts.clone());

    let mut dim_suit_map = std::collections::HashMap::new();
    dim_suit_map.insert("d".to_string(), colors.dim_suits.diamonds.clone());
    dim_suit_map.insert("s".to_string(), colors.dim_suits.spades.clone());
    dim_suit_map.insert("c".to_string(), colors.dim_suits.clubs.clone());
    dim_suit_map.insert("h".to_string(), colors.dim_suits.hearts.clone());

    // Extract Game ID first
    if let Some(rect) = config.round_id {
        if rect.x + rect.w <= img.width() && rect.y + rect.h <= img.height() {
            let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
            let text = crate::cv_utils::extract_text(&cropped).unwrap_or_default();

            let re = Regex::new(r"[#HMIt]\s*(\d{6,15})").map_err(|e| e.to_string())?;
            if let Some(caps) = re.captures(&text) {
                game_id = Some(caps.get(1).map_or("", |m| m.as_str()).to_string());
            }
        }
    }

    // Community Cards detection
    if let Some(cards) = config.community_cards {
        let mut last_was_empty = false;

        for (i, card_rect_opt) in cards.iter().enumerate() {
            if let Some(rect) = card_rect_opt {
                if rect.x + rect.w <= img.width() && rect.y + rect.h <= img.height() {
                    let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);

                    eprintln!("[poker] Processing community card {}...", i);

                    // Robust card detection: Check suit density and text density independently
                    let mut best_suit = None;
                    let mut max_suit_density = 0.0;
                    let mut suit_suggests_dimmed = false;

                    for (s, hex) in &suit_map {
                        let d = crate::cv_utils::color_density(&cropped, &[hex.clone()], 15);
                        if d > max_suit_density {
                            max_suit_density = d;
                            best_suit = Some(s.clone());
                            suit_suggests_dimmed = false;
                        }
                    }
                    for (s, hex) in &dim_suit_map {
                        let d = crate::cv_utils::color_density(&cropped, &[hex.clone()], 15);
                        if d > max_suit_density {
                            max_suit_density = d;
                            best_suit = Some(s.clone());
                            suit_suggests_dimmed = true;
                        }
                    }

                    let (suit, is_dimmed) = if max_suit_density > 0.40 {
                        // Verify state with text color density
                        let normal_text_d = crate::cv_utils::color_density(
                            &cropped,
                            &[colors.card_text.clone()],
                            20,
                        );
                        let dimmed_text_d = crate::cv_utils::color_density(
                            &cropped,
                            &[colors.dim_text.clone()],
                            20,
                        );

                        let final_dimmed = if dimmed_text_d > normal_text_d + 0.02 {
                            true
                        } else if normal_text_d > dimmed_text_d + 0.02 {
                            false
                        } else {
                            suit_suggests_dimmed
                        };
                        (best_suit, final_dimmed)
                    } else {
                        (None, false)
                    };

                    let rank = if suit.is_some() {
                        let text_color = if is_dimmed {
                            &colors.dim_text
                        } else {
                            &colors.card_text
                        };
                        crate::cv_utils::detect_rank(&cropped, Some(text_color))
                    } else {
                        None
                    };

                    match (rank, suit) {
                        (Some(r), Some(s)) => {
                            if last_was_empty {
                                eprintln!("[poker] Community card {} detected after empty spot, ignoring.", i);
                                community_cards.push(None);
                            } else {
                                let dimmed_suffix = if is_dimmed { "_" } else { "" };
                                eprintln!(
                                    "[poker] Community card {} detected: {}{}{}",
                                    i, r, s, dimmed_suffix
                                );
                                community_cards.push(Some(format!("{}{}{}", r, s, dimmed_suffix)));
                            }
                        }
                        _ => {
                            community_cards.push(None);
                            last_was_empty = true;
                        }
                    }
                } else {
                    community_cards.push(None);
                    last_was_empty = true;
                }
            } else {
                community_cards.push(None);
                last_was_empty = true;
            }
        }
    }

    // Player detection colors
    let target_colors = vec![
        colors.nameplate.clone(),
        colors.in_turn.clone(),
        colors.in_turn_urgent.clone(),
    ];

    if let Some(seats) = config.seats {
        for (i, seat_opt) in seats.iter().enumerate() {
            if let Some(seat) = seat_opt {
                // ALWAYS capture bets for all seats that have a bet region defined,
                // regardless of whether they are "in play" or not.
                if let Some(bet_rect) = seat.bet {
                    if bet_rect.x + bet_rect.w <= img.width()
                        && bet_rect.y + bet_rect.h <= img.height()
                    {
                        let bet_cropped =
                            img.crop_imm(bet_rect.x, bet_rect.y, bet_rect.w, bet_rect.h);
                        let preprocessed = crate::cv_utils::preprocess_for_ocr(&bet_cropped);
                        if let Ok(text) = crate::cv_utils::extract_text(&preprocessed) {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                seat_bets.insert(i as u32, trimmed.to_string());
                            }
                        }
                    }
                }

                if let Some(rect) = seat.nameplate {
                    if rect.x + rect.w <= img.width() && rect.y + rect.h <= img.height() {
                        let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
                        let density = crate::cv_utils::color_density(&cropped, &target_colors, 5);

                        if density >= 0.05 {
                            in_play_seats.push(i as u32);

                            // Detect if this seat is currently in-turn
                            let turn_density = crate::cv_utils::color_density(
                                &cropped,
                                &[colors.in_turn.clone()],
                                5,
                            );
                            let urgent_density = crate::cv_utils::color_density(
                                &cropped,
                                &[colors.in_turn_urgent.clone()],
                                5,
                            );

                            if turn_density >= 0.03 || urgent_density >= 0.03 {
                                eprintln!("[poker] Turn detected for seat {}: in_turn={:.4}, urgent={:.4}", i, turn_density, urgent_density);
                                active_seat = Some(i as u32);
                                if turn_density > urgent_density {
                                    active_seat_color = Some(colors.in_turn.clone());
                                } else {
                                    active_seat_color = Some(colors.in_turn_urgent.clone());
                                }
                            }

                            if let Some(name_rect) = seat.name {
                                if name_rect.x + name_rect.w <= img.width()
                                    && name_rect.y + name_rect.h <= img.height()
                                {
                                    let name_cropped = img.crop_imm(
                                        name_rect.x,
                                        name_rect.y,
                                        name_rect.w,
                                        name_rect.h,
                                    );
                                    let preprocessed =
                                        crate::cv_utils::preprocess_for_ocr(&name_cropped);
                                    let ocr_text = crate::cv_utils::extract_text(&preprocessed)
                                        .unwrap_or_else(|_| "OCR_FAIL".to_string())
                                        .trim()
                                        .trim_matches(|c: char| !c.is_alphanumeric() && c != '.')
                                        .to_string();

                                    seat_usernames.insert(i as u32, ocr_text.clone());

                                    let ocr_lower = ocr_text.to_lowercase();
                                    let target_lower = target_username.to_lowercase();

                                    if ocr_lower.ends_with("...") {
                                        let prefix = ocr_lower.trim_end_matches("...");
                                        if !prefix.is_empty() && target_lower.starts_with(prefix) {
                                            my_seat_index = Some(i as u32);
                                        }
                                    } else if ocr_lower == target_lower {
                                        my_seat_index = Some(i as u32);
                                    }
                                }
                            }

                            if let Some(ref card_rects) = seat.cards {
                                let mut detected_cards = Vec::new();
                                for (c_idx, card_opt) in card_rects.iter().enumerate() {
                                    if let Some(rect) = card_opt {
                                        if rect.x + rect.w <= img.width()
                                            && rect.y + rect.h <= img.height()
                                        {
                                            let cropped =
                                                img.crop_imm(rect.x, rect.y, rect.w, rect.h);

                                            eprintln!(
                                                "[poker] Processing seat {} card {}...",
                                                i, c_idx
                                            );

                                            let mut best_suit = None;
                                            let mut max_suit_density = 0.0;
                                            let mut suit_suggests_dimmed = false;

                                            for (s, hex) in &suit_map {
                                                let d = crate::cv_utils::color_density(
                                                    &cropped,
                                                    &[hex.clone()],
                                                    15,
                                                );
                                                if d > max_suit_density {
                                                    max_suit_density = d;
                                                    best_suit = Some(s.clone());
                                                    suit_suggests_dimmed = false;
                                                }
                                            }
                                            for (s, hex) in &dim_suit_map {
                                                let d = crate::cv_utils::color_density(
                                                    &cropped,
                                                    &[hex.clone()],
                                                    15,
                                                );
                                                if d > max_suit_density {
                                                    max_suit_density = d;
                                                    best_suit = Some(s.clone());
                                                    suit_suggests_dimmed = true;
                                                }
                                            }

                                            let (suit, is_dimmed) = if max_suit_density > 0.40 {
                                                let normal_text_d = crate::cv_utils::color_density(
                                                    &cropped,
                                                    &[colors.card_text.clone()],
                                                    20,
                                                );
                                                let dimmed_text_d = crate::cv_utils::color_density(
                                                    &cropped,
                                                    &[colors.dim_text.clone()],
                                                    20,
                                                );

                                                let final_dimmed =
                                                    if dimmed_text_d > normal_text_d + 0.02 {
                                                        true
                                                    } else if normal_text_d > dimmed_text_d + 0.02 {
                                                        false
                                                    } else {
                                                        suit_suggests_dimmed
                                                    };
                                                (best_suit, final_dimmed)
                                            } else {
                                                (None, false)
                                            };

                                            let rank = if suit.is_some() {
                                                let text_color = if is_dimmed {
                                                    &colors.dim_text
                                                } else {
                                                    &colors.card_text
                                                };
                                                crate::cv_utils::detect_rank(
                                                    &cropped,
                                                    Some(text_color),
                                                )
                                            } else {
                                                None
                                            };

                                            if let (Some(r), Some(s)) = (rank, suit) {
                                                let dimmed_suffix =
                                                    if is_dimmed { "_" } else { "" };
                                                eprintln!(
                                                    "[poker] Seat {} card {} detected: {}{}{}",
                                                    i, c_idx, r, s, dimmed_suffix
                                                );
                                                detected_cards
                                                    .push(format!("{}{}{}", r, s, dimmed_suffix));
                                            }
                                        }
                                    }
                                }

                                if detected_cards.len() == 2 {
                                    seat_cards.insert(i as u32, detected_cards);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(GameState {
        in_play_seats,
        seat_usernames,
        seat_cards,
        seat_bets,
        active_seat,
        active_seat_color,
        my_seat_index,
        community_cards,
        game_id,
    })
}

pub fn detect_table_roi(
    screenshot_bytes: &[u8],
) -> Result<(Vec<u8>, (u32, u32, u32, u32)), String> {
    let img = crate::media::decode_image(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    let (width, height) = img.dimensions();
    let roi_x = width / 4;
    let roi_y = height / 4;
    let roi_width = width / 2;
    let roi_height = height / 2;

    let cropped = img.crop_imm(roi_x, roi_y, roi_width, roi_height);

    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    cropped
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode cropped image: {}", e))?;

    Ok((bytes, (roi_x, roi_y, roi_width, roi_height)))
}

fn validate_active_config(config: &RegionConfig, img: &DynamicImage) -> Result<(), String> {
    if config.screen_width != img.width() || config.screen_height != img.height() {
        return Err("Image dimensions differ from active region configuration".into());
    }
    fn walk(node: &serde_json::Value, width: u32, height: u32) -> Result<(), String> {
        if node.get("x").is_some() {
            let rect: crate::types::Rect =
                serde_json::from_value(node.clone()).map_err(|e| e.to_string())?;
            return rect.validate(width, height);
        }
        if let Some(fields) = node.as_object() {
            for child in fields.values() {
                walk(child, width, height)?;
            }
        }
        if let Some(items) = node.as_array() {
            for child in items {
                walk(child, width, height)?;
            }
        }
        Ok(())
    }
    walk(
        &serde_json::to_value(config).map_err(|e| e.to_string())?,
        img.width(),
        img.height(),
    )
}
