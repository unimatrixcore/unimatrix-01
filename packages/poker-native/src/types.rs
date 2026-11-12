use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}
impl Rect {
    pub fn validate(&self, width: u32, height: u32) -> Result<(), String> {
        if self.w == 0
            || self.h == 0
            || self.w > 16384
            || self.h > 16384
            || self.x.checked_add(self.w).is_none_or(|x| x > width)
            || self.y.checked_add(self.h).is_none_or(|y| y > height)
        {
            return Err("Region exceeds image bounds or has invalid dimensions".into());
        }
        Ok(())
    }
}
pub type Regions = BTreeMap<String, Rect>;
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Pending,
    Label,
    Blank,
    Discard,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sample {
    pub key: String,
    pub region_id: String,
    pub label: String,
    pub phash: String,
    pub source: String,
    pub rect: Rect,
    pub image: String,
    pub decision: Decision,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub key: String,
    pub source: String,
    pub game_id: String,
    pub thumbnail: String,
    pub crops: Vec<Sample>,
}
#[derive(Debug, Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub frames: Vec<Frame>,
    pub pool: Vec<Sample>,
    pub current_index: usize,
    pub points: f64,
    pub streak: u32,
    pub elapsed_ms: f64,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub monitor: String,
    pub username: String,
    pub capture_interval_ms: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            monitor: String::new(),
            username: String::new(),
            capture_interval_ms: 3000,
            extra: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionSettings {
    pub regions: Regions,
    pub screen_width: u32,
    pub screen_height: u32,
}
impl Default for RegionSettings {
    fn default() -> Self {
        Self {
            regions: serde_json::from_str(include_str!("../assets/regions-flat.json"))
                .expect("bundled regions"),
            screen_width: 1920,
            screen_height: 1080,
        }
    }
}
impl RegionSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=16384).contains(&self.screen_width)
            || !(1..=16384).contains(&self.screen_height)
            || self.regions.is_empty()
            || self.regions.len() > 512
        {
            return Err("Invalid region configuration dimensions or count".into());
        }
        for (id, rect) in &self.regions {
            if !valid_region_id(id) {
                return Err(format!("Invalid canonical region ID: {id}"));
            }
            rect.validate(self.screen_width, self.screen_height)?;
        }
        Ok(())
    }
}
pub fn valid_region_id(id: &str) -> bool {
    if matches!(id, "round_id" | "pot.main" | "pot.split") {
        return true;
    }
    let parts: Vec<_> = id.split('.').collect();
    match parts.as_slice() {
        ["community", card] => card
            .strip_prefix("card_")
            .and_then(|x| x.parse::<u8>().ok())
            .is_some_and(|x| (1..=5).contains(&x)),
        ["seat", seat, field] => {
            seat.parse::<u8>().is_ok_and(|n| n < 9)
                && matches!(
                    *field,
                    "name"
                        | "nameplate"
                        | "bank"
                        | "bet"
                        | "status"
                        | "dealer"
                        | "hand_0"
                        | "hand_1"
                )
        }
        _ => false,
    }
}
pub fn canonical_id(id: &str) -> String {
    if id == "pot" {
        return "pot.main".into();
    }
    if id == "split_pot" {
        return "pot.split".into();
    }
    if let Some(n) = id
        .strip_prefix("community_cards[")
        .and_then(|x| x.strip_suffix(']'))
        .and_then(|x| x.parse::<usize>().ok())
    {
        return n
            .checked_add(1)
            .map(|n| format!("community.card_{n}"))
            .unwrap_or_else(|| id.to_owned());
    }
    if let Some(rest) = id.strip_prefix("seats[") {
        if let Some((n, field)) = rest.split_once("].") {
            if let Ok(n) = n.parse::<u8>() {
                let field = field
                    .strip_prefix("cards[")
                    .and_then(|x| x.strip_suffix(']'))
                    .map(|x| format!("hand_{x}"))
                    .unwrap_or_else(|| field.to_owned());
                return format!("seat.{n}.{field}");
            }
        }
    }
    id.to_owned()
}
impl RegionSettings {
    pub fn vision_config(&self) -> Result<crate::vision::RegionConfig, String> {
        self.validate()?;
        let mut seats = Vec::new();
        for n in 0..9 {
            let mut seat = serde_json::Map::new();
            for field in ["name", "nameplate", "bank", "bet", "status", "dealer"] {
                seat.insert(
                    field.into(),
                    serde_json::to_value(self.regions.get(&format!("seat.{n}.{field}")))
                        .map_err(|e| e.to_string())?,
                );
            }
            seat.insert(
                "cards".into(),
                serde_json::json!([
                    self.regions.get(&format!("seat.{n}.hand_0")),
                    self.regions.get(&format!("seat.{n}.hand_1"))
                ]),
            );
            seats.push(serde_json::Value::Object(seat));
        }
        let value = serde_json::json!({"screen_width":self.screen_width,"screen_height":self.screen_height,"round_id":self.regions.get("round_id"),"pot":self.regions.get("pot.main"),"split_pot":self.regions.get("pot.split"),"community_cards":(1..=5).map(|n|self.regions.get(&format!("community.card_{n}"))).collect::<Vec<_>>(),"seats":seats});
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
}
