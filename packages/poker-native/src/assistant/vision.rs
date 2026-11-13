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

#[derive(Debug, Deserialize, Serialize)]
pub struct SeatRegions {
    pub name: Option<RegionRect>,
    pub nameplate: Option<RegionRect>,
    pub bank: Option<RegionRect>,
    pub bet: Option<RegionRect>,
    pub cards: Option<Vec<Option<RegionRect>>>,
    pub status: Option<RegionRect>,
    pub dealer: Option<RegionRect>,
}

#[derive(Debug, Deserialize, Serialize)]
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
pub fn verify_fullscreen_game(screenshot_bytes: &[u8]) -> Result<bool, String> {
    let img = image::load_from_memory(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    // Load config to find round_id region
    let config_str = &crate::assistant::storage_paths::config_string(
        "regions.json",
        include_str!("../../assets/regions.json"),
    )?;
    let config: RegionConfig = serde_json::from_str(config_str)
        .map_err(|e| format!("Failed to parse regions.json: {}", e))?;

    if let Some(rect) = config.round_id {
        if rect.x + rect.w <= img.width() && rect.y + rect.h <= img.height() {
            let cropped = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
            let text = crate::assistant::cv_utils::extract_text(&cropped)?;

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
pub fn extract_regions(screenshot_bytes: &[u8]) -> Result<Vec<CroppedRegion>, String> {
    // Load config from compiled assets
    let config_str = &crate::assistant::storage_paths::config_string(
        "regions.json",
        include_str!("../../assets/regions.json"),
    )?;
    let config: RegionConfig = serde_json::from_str(config_str)
        .map_err(|e| format!("Failed to parse regions.json: {}", e))?;

    let img = image::load_from_memory(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

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
    pub seat_banks: std::collections::HashMap<u32, String>,
    pub seat_statuses: std::collections::HashMap<u32, String>,
    pub seat_dealers: std::collections::HashMap<u32, String>,
    pub pot: Option<String>,
    pub split_pot: Option<String>,
}

/// Identifies which seats are in play and finds the user's seat index using OCR.
pub fn process_game_state(
    screenshot_bytes: &[u8],
    target_username: &str,
) -> Result<GameState, String> {
    let img = image::load_from_memory(screenshot_bytes)
        .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    let config_str = &crate::assistant::storage_paths::config_string(
        "regions.json",
        include_str!("../../assets/regions.json"),
    )?;
    let config: RegionConfig = serde_json::from_str(config_str)
        .map_err(|e| format!("Failed to parse regions.json: {}", e))?;

    let color_str = &crate::assistant::storage_paths::config_string(
        "colors.json",
        include_str!("../../assets/colors.json"),
    )?;
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
            let text = crate::assistant::cv_utils::extract_text(&cropped).unwrap_or_default();

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
                        let d =
                            crate::assistant::cv_utils::color_density(&cropped, &[hex.clone()], 15);
                        if d > max_suit_density {
                            max_suit_density = d;
                            best_suit = Some(s.clone());
                            suit_suggests_dimmed = false;
                        }
                    }
                    for (s, hex) in &dim_suit_map {
                        let d =
                            crate::assistant::cv_utils::color_density(&cropped, &[hex.clone()], 15);
                        if d > max_suit_density {
                            max_suit_density = d;
                            best_suit = Some(s.clone());
                            suit_suggests_dimmed = true;
                        }
                    }

                    let (suit, is_dimmed) = if max_suit_density > 0.40 {
                        // Verify state with text color density
                        let normal_text_d = crate::assistant::cv_utils::color_density(
                            &cropped,
                            &[colors.card_text.clone()],
                            20,
                        );
                        let dimmed_text_d = crate::assistant::cv_utils::color_density(
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
                        crate::assistant::cv_utils::detect_rank(&cropped, Some(text_color))
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
                        let preprocessed =
                            crate::assistant::cv_utils::preprocess_for_ocr(&bet_cropped);
                        if let Ok(text) = crate::assistant::cv_utils::extract_text(&preprocessed) {
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
                        let density =
                            crate::assistant::cv_utils::color_density(&cropped, &target_colors, 5);

                        if density >= 0.05 {
                            in_play_seats.push(i as u32);

                            // Detect if this seat is currently in-turn
                            let turn_density = crate::assistant::cv_utils::color_density(
                                &cropped,
                                &[colors.in_turn.clone()],
                                5,
                            );
                            let urgent_density = crate::assistant::cv_utils::color_density(
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
                                        crate::assistant::cv_utils::preprocess_for_ocr(
                                            &name_cropped,
                                        );
                                    let ocr_text =
                                        crate::assistant::cv_utils::extract_text(&preprocessed)
                                            .unwrap_or_else(|_| "OCR_FAIL".to_string())
                                            .trim()
                                            .trim_matches(|c: char| {
                                                !c.is_alphanumeric() && c != '.'
                                            })
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
                                                let d = crate::assistant::cv_utils::color_density(
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
                                                let d = crate::assistant::cv_utils::color_density(
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
                                                let normal_text_d =
                                                    crate::assistant::cv_utils::color_density(
                                                        &cropped,
                                                        &[colors.card_text.clone()],
                                                        20,
                                                    );
                                                let dimmed_text_d =
                                                    crate::assistant::cv_utils::color_density(
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
                                                crate::assistant::cv_utils::detect_rank(
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
        seat_banks: Default::default(),
        seat_statuses: Default::default(),
        seat_dealers: Default::default(),
        pot: None,
        split_pot: None,
    })
}

pub fn detect_table_roi(
    screenshot_bytes: &[u8],
) -> Result<(Vec<u8>, (u32, u32, u32, u32)), String> {
    let img = image::load_from_memory(screenshot_bytes)
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

/// Read only confirmed text; blank and unknown remain distinct in the raw OCR
/// region map returned alongside GameState. Never repair a recognized glyph.
fn confirmed_text<'a>(regions: &'a serde_json::Value, id: &str) -> Option<&'a str> {
    let decision = regions.get(id)?.get("decision")?;
    if decision.get("state")?.as_str()? != "text" {
        return None;
    }
    decision.get("text")?.as_str()
}

/// Combine a validated rank with color evidence from the exact source pixels.
/// The old OCR rank reader is deliberately absent from this production path.
fn validated_card(
    img: &DynamicImage,
    rect: Option<RegionRect>,
    rank: Option<&str>,
    colors: &ColorConfig,
) -> Option<String> {
    let rank = rank?;
    if ![
        "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
    ]
    .contains(&rank)
    {
        return None;
    }
    let (suit, dimmed) = card_color(img, rect, colors)?;
    Some(format!("{}{}{}", rank, suit, if dimmed { "_" } else { "" }))
}

fn color_hex(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 6 | 8) && digits.bytes().all(|c| c.is_ascii_hexdigit())
    })
}

fn color_crop(img: &DynamicImage, rect: Option<RegionRect>) -> Option<DynamicImage> {
    let r = rect?;
    if r.w == 0
        || r.h == 0
        || r.x.checked_add(r.w)? > img.width()
        || r.y.checked_add(r.h)? > img.height()
    {
        return None;
    }
    Some(img.crop_imm(r.x, r.y, r.w, r.h))
}

pub fn nameplate_in_play(
    img: &DynamicImage,
    rect: Option<RegionRect>,
    colors: &ColorConfig,
) -> Option<bool> {
    let crop = color_crop(img, rect)?;
    let palette = [
        colors.nameplate.clone(),
        colors.in_turn.clone(),
        colors.in_turn_urgent.clone(),
    ];
    if !palette.iter().all(|hex| color_hex(hex)) {
        return None;
    }
    Some(
        crate::assistant::cv_utils::color_density(&crop, &palette, 5) >= 0.05
            || crate::assistant::cv_utils::turn_palette_density(&crop, &colors.in_turn) >= 0.05
            || crate::assistant::cv_utils::turn_palette_density(&crop, &colors.in_turn_urgent)
                >= 0.05,
    )
}

pub fn card_color(
    img: &DynamicImage,
    rect: Option<RegionRect>,
    colors: &ColorConfig,
) -> Option<(&'static str, bool)> {
    let crop = color_crop(img, rect)?;
    if ![
        &colors.card_text,
        &colors.dim_text,
        &colors.suits.diamonds,
        &colors.suits.spades,
        &colors.suits.clubs,
        &colors.suits.hearts,
        &colors.dim_suits.diamonds,
        &colors.dim_suits.spades,
        &colors.dim_suits.clubs,
        &colors.dim_suits.hearts,
    ]
    .iter()
    .all(|hex| color_hex(hex))
    {
        return None;
    }
    let mut best = None;
    let mut density = 0.40;
    for (dimmed, palette) in [(false, &colors.suits), (true, &colors.dim_suits)] {
        for (suit, hex) in [
            ("d", &palette.diamonds),
            ("s", &palette.spades),
            ("c", &palette.clubs),
            ("h", &palette.hearts),
        ] {
            let current = crate::assistant::cv_utils::color_density(&crop, &[hex.clone()], 15);
            if current > density {
                density = current;
                best = Some((suit, dimmed));
            }
        }
    }
    let (suit, suggested_dimmed) = best?;
    let normal = crate::assistant::cv_utils::color_density(&crop, &[colors.card_text.clone()], 20);
    let dim = crate::assistant::cv_utils::color_density(&crop, &[colors.dim_text.clone()], 20);
    let dimmed = if dim > normal + 0.02 {
        true
    } else if normal > dim + 0.02 {
        false
    } else {
        suggested_dimmed
    };
    Some((suit, dimmed))
}

/// Compose display state without invoking RTen. The caller must supply the
/// source image named by the reader's pixel-validation provenance.
pub fn compose_validated_state(
    screenshot_bytes: &[u8],
    value: &serde_json::Value,
    target_username: &str,
) -> Result<GameState, String> {
    let img = image::load_from_memory(screenshot_bytes)
        .map_err(|e| format!("Invalid source pixels: {e}"))?;
    compose_validated_image(&img, value, target_username)
}

/// Reuse a decoded immutable source image between polls. OCR decisions remain
/// independently refreshed; only lossless PNG decoding is cached.
pub fn compose_validated_image(
    img: &DynamicImage,
    value: &serde_json::Value,
    target_username: &str,
) -> Result<GameState, String> {
    let config: RegionConfig =
        serde_json::from_str(&crate::assistant::storage_paths::config_string(
            "regions.json",
            include_str!("../../assets/regions.json"),
        )?)
        .map_err(|e| e.to_string())?;
    let colors: ColorConfig =
        serde_json::from_str(&crate::assistant::storage_paths::config_string(
            "colors.json",
            include_str!("../../assets/colors.json"),
        )?)
        .map_err(|e| e.to_string())?;
    if (img.width(), img.height()) != (config.screen_width, config.screen_height) {
        return Err("Source dimensions changed".into());
    }
    let regions = value.get("regions").ok_or("Missing OCR regions")?;
    let active = value
        .get("active_seats")
        .and_then(|v| v.as_array())
        .ok_or("Missing active seat evidence")?;
    let mut state = GameState {
        in_play_seats: active
            .iter()
            .filter_map(|v| v.as_u64().and_then(|n| u32::try_from(n).ok()))
            .collect(),
        seat_usernames: Default::default(),
        seat_cards: Default::default(),
        seat_bets: Default::default(),
        active_seat: None,
        active_seat_color: None,
        my_seat_index: None,
        community_cards: Vec::new(),
        game_id: confirmed_text(regions, "round_id").map(str::to_owned),
        seat_banks: Default::default(),
        seat_statuses: Default::default(),
        seat_dealers: Default::default(),
        pot: confirmed_text(regions, "pot").map(str::to_owned),
        split_pot: confirmed_text(regions, "split_pot").map(str::to_owned),
    };
    if state.game_id.is_none() {
        return Err("Game ID is not confirmed".into());
    }
    if let Some(cards) = config.community_cards {
        for (index, rect) in cards.iter().enumerate() {
            // Preserve every board position even when an earlier rank is unknown.
            state.community_cards.push(validated_card(
                &img,
                *rect,
                confirmed_text(regions, &format!("community_cards[{index}]")),
                &colors,
            ));
        }
    }
    // Keep every candidate until the full frame has been examined. Two turn
    // highlights during a transition are ambiguous, so neither may win by order.
    let mut turn_candidates = Vec::new();
    if let Some(seats) = config.seats {
        for (index, seat) in seats.iter().enumerate() {
            let Some(seat) = seat else { continue };
            let id = index as u32;
            for (field, destination) in [
                ("name", &mut state.seat_usernames),
                ("bank", &mut state.seat_banks),
                ("bet", &mut state.seat_bets),
                ("status", &mut state.seat_statuses),
                ("dealer", &mut state.seat_dealers),
            ] {
                if let Some(text) = confirmed_text(regions, &format!("seats[{index}].{field}")) {
                    destination.insert(id, text.to_owned());
                }
            }
            if !state.in_play_seats.contains(&id) {
                continue;
            }
            if let Some(rect) = seat.nameplate {
                if rect.x.checked_add(rect.w).is_some_and(|x| x <= img.width())
                    && rect
                        .y
                        .checked_add(rect.h)
                        .is_some_and(|y| y <= img.height())
                {
                    let crop = img.crop_imm(rect.x, rect.y, rect.w, rect.h);
                    // Only seats already admitted from this exact source may
                    // provide turn evidence. Match the bounded brightness policy
                    // used by that admission, including the brighter live hue.
                    let normal =
                        crate::assistant::cv_utils::turn_palette_density(&crop, &colors.in_turn);
                    let urgent = crate::assistant::cv_utils::turn_palette_density(
                        &crop,
                        &colors.in_turn_urgent,
                    );
                    if normal >= 0.03 || urgent >= 0.03 {
                        turn_candidates.push((
                            id,
                            if normal > urgent {
                                colors.in_turn.clone()
                            } else {
                                colors.in_turn_urgent.clone()
                            },
                        ));
                    }
                }
            }
            if let Some(cards) = &seat.cards {
                let positions: Vec<Option<String>> = cards
                    .iter()
                    .enumerate()
                    .map(|(c, rect)| {
                        validated_card(
                            &img,
                            *rect,
                            confirmed_text(regions, &format!("seats[{index}].cards[{c}]")),
                            &colors,
                        )
                    })
                    .collect();
                // The old UI accepts complete two-card hands only. Do not compact
                // an unknown first card into the second card's position.
                if positions.len() == 2 && positions.iter().all(Option::is_some) {
                    state
                        .seat_cards
                        .insert(id, positions.into_iter().flatten().collect());
                }
            }
        }
    }
    if turn_candidates.len() == 1 {
        let (seat, color) = turn_candidates.pop().unwrap();
        state.active_seat = Some(seat);
        // Keep the configured canonical color for existing UI consumers; the
        // observed brightness variation is evidence, not a new theme color.
        state.active_seat_color = Some(color);
    }
    // Truncated names can share a prefix. Resolve the user only once all
    // admitted names are known; never let the last matching seat win.
    state.my_seat_index = unique_user_seat(&state.seat_usernames, target_username);
    Ok(state)
}

/// Prefer an exact username and require a unique candidate. Multiple matching
/// ellipses are ambiguous even when every OCR transcription is correct.
fn unique_user_seat(names: &std::collections::HashMap<u32, String>, target: &str) -> Option<u32> {
    let target = target.to_lowercase();
    if target.is_empty() {
        return None;
    }
    let mut exact = Vec::new();
    let mut abbreviated = Vec::new();
    for (&seat, name) in names {
        let name = name.to_lowercase();
        if name == target {
            exact.push(seat);
        } else if name
            .strip_suffix("...")
            .is_some_and(|prefix| !prefix.is_empty() && target.starts_with(prefix))
        {
            abbreviated.push(seat);
        }
    }
    if exact.len() == 1 {
        exact.first().copied()
    } else if exact.is_empty() && abbreviated.len() == 1 {
        abbreviated.first().copied()
    } else {
        None
    }
}

#[cfg(test)]
mod validated_tests {
    use super::*;

    /// Build only pixel evidence and an explicit admitted-seat list. These
    /// controls exercise composition without invoking OCR or a live capture.
    fn turn_scene(highlights: &[(usize, [u8; 3])], admitted: &[usize]) -> GameState {
        let config: RegionConfig =
            serde_json::from_str(include_str!("../../assets/regions.json")).unwrap();
        let mut image = image::RgbImage::new(config.screen_width, config.screen_height);
        for (seat, rgb) in highlights {
            let rect = config.seats.as_ref().unwrap()[*seat]
                .as_ref()
                .unwrap()
                .nameplate
                .unwrap();
            for y in rect.y..rect.y + rect.h {
                for x in rect.x..rect.x + rect.w {
                    image.put_pixel(x, y, image::Rgb(*rgb));
                }
            }
        }
        let value = serde_json::json!({"active_seats":admitted,"regions":{"round_id":{"decision":{"state":"text","text":"#123456"}}}});
        compose_validated_image(&DynamicImage::ImageRgb8(image), &value, "").unwrap()
    }

    #[test]
    fn turn_highlight_requires_admission_and_a_unique_candidate() {
        let single = turn_scene(&[(0, [144, 0, 255])], &[0]);
        assert_eq!(single.active_seat, Some(0));
        assert_eq!(single.active_seat_color.as_deref(), Some("#8900f2"));
        assert_eq!(turn_scene(&[(0, [144, 0, 255])], &[]).active_seat, None);
        let ambiguous = turn_scene(&[(0, [144, 0, 255]), (1, [234, 65, 98])], &[0, 1]);
        assert_eq!(ambiguous.active_seat, None);
        assert_eq!(ambiguous.active_seat_color, None);
        let urgent = turn_scene(&[(0, [72, 0, 128]), (1, [234, 65, 98])], &[0, 1]);
        assert_eq!(urgent.active_seat, Some(1));
        assert_eq!(urgent.active_seat_color.as_deref(), Some("#e13e5e"));
    }

    #[test]
    #[ignore = "Opt-in archived pixel replay; no live capture or model inference"]
    fn turn_archived_postrepair_sources_match_independent_visual_truth() {
        let root = std::path::PathBuf::from(
            std::env::var("POKER_OCR_TURN_REPLAY_ROOT").expect("archived root required"),
        );
        let output = std::path::PathBuf::from(
            std::env::var("POKER_OCR_TURN_REPLAY_REPORT").expect("report path required"),
        );
        let frames = std::fs::read_to_string(root.join("visual-review/frame-truth.jsonl")).unwrap();
        let expected = [
            Some(4),
            Some(5),
            Some(5),
            None,
            Some(7),
            Some(7),
            Some(7),
            Some(7),
            Some(7),
            Some(7),
            Some(8),
            Some(8),
            Some(1),
            Some(1),
            Some(1),
            Some(2),
            Some(2),
            Some(2),
            Some(2),
            Some(2),
        ];
        let mut observations = Vec::new();
        for line in frames.lines() {
            let truth: serde_json::Value = serde_json::from_str(line).unwrap();
            let index = truth["frame_index"].as_u64().unwrap() as usize;
            let filename = format!("frames/{index:06}.png");
            let image = image::open(root.join(&filename)).unwrap();
            let value = serde_json::json!({"active_seats":truth["active_seats"],"regions":{"round_id":{"decision":{"state":"text","text":"#123456"}}}});
            let start = std::time::Instant::now();
            let state = compose_validated_image(&image, &value, "").unwrap();
            let milliseconds = start.elapsed().as_secs_f64() * 1000.0;
            observations.push(serde_json::json!({"frame_index":index,"file":filename,"source_sha256":truth["source_sha256"],"expected_turn_seat":expected[index],"observed_turn_seat":state.active_seat,"canonical_color":state.active_seat_color,"compose_ms":milliseconds,"matches":state.active_seat==expected[index]}));
        }
        assert_eq!(observations.len(), 20);
        std::fs::write(output, serde_json::to_vec_pretty(&serde_json::json!({"scope":"Previously captured source pixels, root independent visual turn truth; not fresh prospective acceptance or model accuracy.","observations":observations})).unwrap()).unwrap();
        assert!(observations.iter().all(|row| row["matches"] == true));
    }

    #[test]
    fn ambiguous_abbreviations_do_not_assign_the_wrong_seat() {
        let mut names =
            std::collections::HashMap::from([(0, "Ali...".into()), (1, "Alice...".into())]);
        assert_eq!(unique_user_seat(&names, "Alice123"), None);
        names.insert(2, "Alice123".into());
        assert_eq!(unique_user_seat(&names, "Alice123"), Some(2));
        names.remove(&0);
        names.remove(&2);
        assert_eq!(unique_user_seat(&names, "Alice123"), Some(1));
        names.insert(2, "ALICE123".into());
        names.insert(3, "Alice123".into());
        assert_eq!(unique_user_seat(&names, "Alice123"), None);
        assert_eq!(unique_user_seat(&names, ""), None);
    }
    #[test]
    fn unknown_and_blank_never_become_text() {
        let regions = serde_json::json!({"a":{"decision":{"state":"unknown","text":"8"}},"b":{"decision":{"state":"blank","text":""}},"c":{"decision":{"state":"text","text":"Q"}}});
        assert_eq!(confirmed_text(&regions, "a"), None);
        assert_eq!(confirmed_text(&regions, "b"), None);
        assert_eq!(confirmed_text(&regions, "c"), Some("Q"));
        assert_eq!(confirmed_text(&regions, "missing"), None);
    }
    #[test]
    fn glyph_substitutions_are_not_used() {
        let colors: ColorConfig =
            serde_json::from_str(include_str!("../../assets/colors.json")).unwrap();
        let image = DynamicImage::new_rgb8(10, 10);
        assert!(validated_card(
            &image,
            Some(RegionRect {
                x: 0,
                y: 0,
                w: 10,
                h: 10
            }),
            Some("B"),
            &colors
        )
        .is_none());
    }
    #[test]
    fn unknown_board_position_is_not_compacted() {
        let colors: ColorConfig =
            serde_json::from_str(include_str!("../../assets/colors.json")).unwrap();
        let hex = colors.suits.hearts.trim_start_matches('#');
        let rgb = image::Rgb([
            u8::from_str_radix(&hex[0..2], 16).unwrap(),
            u8::from_str_radix(&hex[2..4], 16).unwrap(),
            u8::from_str_radix(&hex[4..6], 16).unwrap(),
        ]);
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1920, 1080, rgb));
        let value = serde_json::json!({"active_seats":[],"regions":{"round_id":{"decision":{"state":"text","text":"#123456"}},"community_cards[0]":{"decision":{"state":"unknown","text":"A"}},"community_cards[1]":{"decision":{"state":"text","text":"Q"}}}});
        let state = compose_validated_image(&image, &value, "").unwrap();
        assert_eq!(state.community_cards.len(), 5);
        assert!(state.community_cards[0].is_none());
        assert!(state.community_cards[1]
            .as_ref()
            .is_some_and(|card| card.starts_with('Q')));
        assert!(state.community_cards[2].is_none());
    }
}
