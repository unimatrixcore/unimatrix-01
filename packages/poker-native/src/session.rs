use crate::types::*;
use serde_json::Value;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn sample(v: &Value, source: &str, index: usize) -> Option<Sample> {
    let region = text(v, "regionId");
    let region = if region.is_empty() {
        text(v, "id")
    } else {
        region
    };
    let rect: Rect = serde_json::from_value(v.get("rect")?.clone()).ok()?;
    let label = text(v, "label").to_owned();
    let phash = text(v, "phash").to_owned();
    let mut image = text(v, "image").to_owned();
    if image.is_empty() {
        let b64 = text(v, "base64_image");
        if !b64.is_empty() {
            image = format!("data:image/png;base64,{b64}");
        }
    }
    let source = if text(v, "source").is_empty() {
        source
    } else {
        text(v, "source")
    };
    // Legacy absence, empty labels and discarded flags never establish a blank.
    let decision = if v.get("discarded").and_then(Value::as_bool) == Some(true) {
        Decision::Discard
    } else if let Ok(d) = serde_json::from_value::<Decision>(v["decision"].clone()) {
        d
    } else {
        Decision::Pending
    };
    let key = if text(v, "key").is_empty() {
        format!("{source}:{region}:{phash}:{index}")
    } else {
        text(v, "key").into()
    };
    Some(Sample {
        key,
        region_id: region.into(),
        label,
        phash,
        source: source.into(),
        rect,
        image,
        decision,
    })
}
pub fn normalize(v: &Value) -> Session {
    if let Ok(s) = serde_json::from_value::<Session>(v.clone()) {
        return s;
    }
    let frames = v["frames"]
        .as_array()
        .map(|frames| {
            frames
                .iter()
                .enumerate()
                .filter_map(|(index, f)| {
                    if f["loading"].as_bool() == Some(true) {
                        return None;
                    }
                    let source = text(f, "source");
                    let crops = f
                        .get("crops")
                        .or_else(|| f.get("regions"))
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .enumerate()
                                .filter_map(|(i, c)| sample(c, source, i))
                                .collect()
                        })
                        .unwrap_or_default();
                    let thumbnail = text(f, "thumbnail");
                    let thumbnail = if thumbnail.starts_with("data:") || thumbnail.is_empty() {
                        thumbnail.to_owned()
                    } else {
                        format!("data:image/jpeg;base64,{thumbnail}")
                    };
                    Some(Frame {
                        key: f
                            .get("key")
                            .or_else(|| f.get("id"))
                            .map(|v| {
                                v.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| v.to_string())
                            })
                            .unwrap_or_else(|| format!("legacy-{index}")),
                        source: source.into(),
                        game_id: f
                            .get("gameId")
                            .or_else(|| f.get("game_id"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        thumbnail,
                        crops,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let pool = v["pool"]
        .as_array()
        .map(|p| {
            p.iter()
                .enumerate()
                .filter_map(|(i, c)| sample(c, "", i))
                .collect()
        })
        .unwrap_or_default();
    Session {
        frames,
        pool,
        current_index: v
            .get("currentIndex")
            .or_else(|| v.get("currentReviewIdx"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        points: v
            .get("points")
            .or_else(|| v.get("sessionScore"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0),
        streak: v
            .get("streak")
            .or_else(|| v.get("currentCombo"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32,
        elapsed_ms: v
            .get("elapsedMs")
            .or_else(|| v.get("totalLabelingTime"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0),
    }
}
pub fn validate(session: &Session) -> Result<(), String> {
    if !session.points.is_finite()
        || session.points < 0.0
        || !session.elapsed_ms.is_finite()
        || session.elapsed_ms < 0.0
        || session.pool.len() > 50000
        || session.frames.len() > 10000
    {
        return Err("Invalid session size or scoring fields".into());
    }
    for sample in session
        .pool
        .iter()
        .chain(session.frames.iter().flat_map(|f| f.crops.iter()))
    {
        sample.rect.validate(16384, 16384)?;
        crate::store::safe_name(&sample.source)?;
        if sample.key.is_empty()
            || sample.key.len() > 512
            || sample.region_id.is_empty()
            || sample.region_id.len() > 128
            || !sample.phash.is_ascii()
            || sample.phash.len() != 64
            || !sample.phash.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid sample identity or hash".into());
        }
        if sample.image.len() > crate::media::MAX_IMAGE_BYTES * 2 {
            return Err("Sample image too large".into());
        }
    }
    for frame in &session.frames {
        crate::store::safe_name(&frame.source)?;
    }
    Ok(())
}
pub fn settings(v: &Value) -> Settings {
    let mut settings: Settings =
        serde_json::from_value(v.clone()).unwrap_or_else(|_| Settings::default());
    if settings.monitor.is_empty() {
        settings.monitor = text(v, "last_monitor").into();
    }
    if settings.username.is_empty() {
        settings.username = text(v, "username").into();
    }
    if let Some(map) = v.as_object() {
        for (k, v) in map {
            if !["monitor", "username", "captureIntervalMs"].contains(&k.as_str()) {
                settings.extra.insert(k.clone(), v.clone());
            }
        }
    }
    settings
}
