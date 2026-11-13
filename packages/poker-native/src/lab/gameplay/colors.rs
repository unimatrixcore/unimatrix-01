use crate::assistant::vision::{card_color, nameplate_in_play, ColorConfig, RegionConfig};
use image::DynamicImage;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, fs, io::Read, path::Path, time::SystemTime};

#[derive(PartialEq)]
struct Key {
    id: String,
    image_hash: String,
    config_hash: String,
    bytes: u64,
    modified: Option<SystemTime>,
}

#[derive(Default)]
pub(super) struct ColorCache(VecDeque<(Key, Value)>);
impl ColorCache {
    pub(super) fn enrich(&mut self, root: &Path, mut frame: Value) -> Value {
        let id = frame["id"].as_str().unwrap_or("");
        let config = &frame["config_snapshot"];
        let unknown = || derive(None, config);
        let color_state = (|| {
            if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            let path = root.join("frames").join(format!("{id}.png"));
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_file() || metadata.len() > crate::media::MAX_IMAGE_BYTES as u64 {
                return None;
            }
            let key = Key {
                id: id.to_owned(),
                image_hash: frame["image_sha256"].as_str()?.to_owned(),
                config_hash: format!("{:x}", Sha256::digest(config.to_string().as_bytes())),
                bytes: metadata.len(),
                modified: metadata.modified().ok(),
            };
            if let Some(index) = self.0.iter().position(|(cached, _)| cached == &key) {
                let entry = self.0.remove(index)?;
                let state = entry.1.clone();
                self.0.push_back(entry);
                return Some(state);
            }
            let mut bytes = Vec::new();
            fs::File::open(path)
                .ok()?
                .take(crate::media::MAX_IMAGE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if format!("{:x}", Sha256::digest(&bytes)) != key.image_hash {
                return None;
            }
            let image = crate::media::decode_image(&bytes).ok()?;
            let state = derive(Some(&image), config);
            if self.0.len() == 16 {
                self.0.pop_front();
            }
            self.0.push_back((key, state.clone()));
            Some(state)
        })()
        .unwrap_or_else(unknown);
        frame["color_state"] = color_state;
        frame
    }
}

fn derive(image: Option<&DynamicImage>, config: &Value) -> Value {
    let regions = serde_json::from_value::<RegionConfig>(config["regions"].clone()).ok();
    let colors = serde_json::from_value::<ColorConfig>(config["colors"].clone()).ok();
    let image = image.filter(|image| {
        regions
            .as_ref()
            .is_some_and(|r| (image.width(), image.height()) == (r.screen_width, r.screen_height))
    });
    let card = |rect| {
        image
            .zip(colors.as_ref())
            .and_then(|(image, colors)| card_color(image, rect, colors).map(|(suit, _)| suit))
    };
    let board = regions.as_ref().and_then(|r| r.community_cards.as_ref());
    let community: Vec<_> = board
        .map(|cards| cards.iter().map(|r| card(*r)).collect())
        .unwrap_or_else(|| vec![None; 5]);
    let mut seats = serde_json::Map::new();
    if let Some(configured) = regions.as_ref().and_then(|r| r.seats.as_ref()) {
        for (index, seat) in configured.iter().enumerate() {
            let in_play = image.zip(colors.as_ref()).and_then(|(image, colors)| {
                nameplate_in_play(image, seat.as_ref().and_then(|s| s.nameplate), colors)
            });
            let suits: Vec<_> = seat
                .as_ref()
                .and_then(|s| s.cards.as_ref())
                .map(|cards| cards.iter().map(|r| card(*r)).collect())
                .unwrap_or_else(|| vec![None; 2]);
            seats.insert(
                index.to_string(),
                json!({"in_play":in_play,"hand_suits":suits}),
            );
        }
    }
    json!({"configuration":if image.is_some() && colors.is_some() {"recorded"} else {"unavailable"},
        "community_suits":community,"seats":seats})
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    fn config() -> Value {
        json!({"regions":{"screen_width":100,"screen_height":20,
            "community_cards":[{"x":0,"y":0,"w":10,"h":10},null],
            "seats":[{"nameplate":{"x":10,"y":0,"w":10,"h":10},
                "cards":[{"x":20,"y":0,"w":10,"h":10},null]},
                {"nameplate":{"x":30,"y":0,"w":10,"h":10}},
                {"nameplate":{"x":99,"y":0,"w":10,"h":10}}]},
            "colors":{"nameplate":"#192a35","in_turn":"#8900f2","in_turn_urgent":"#e13e5e",
                "card_text":"#f2f2f2","dim_text":"#939393",
                "suits":{"clubs":"#00b801","spades":"#101010","hearts":"#b10d2e","diamonds":"#1473dd"},
                "dim_suits":{"clubs":"#1c781c","spades":"#222222","hearts":"#792334","diamonds":"#245285"}}})
    }
    fn image() -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_fn(100, 20, |x, y| {
            Rgb(if y >= 10 {
                [100, 100, 100]
            } else if x < 10 {
                [0, 184, 1]
            } else if x < 20 {
                [25, 42, 53]
            } else if x < 30 {
                [34, 34, 34]
            } else {
                [100, 100, 100]
            })
        }))
    }
    #[test]
    fn recorded_pixels_determine_color_without_ocr_and_preserve_unknown() {
        let result = derive(Some(&image()), &config());
        assert_eq!(result["community_suits"], json!(["c", null]));
        assert_eq!(
            result["seats"]["0"],
            json!({"in_play":true,"hand_suits":["s",null]})
        );
        assert_eq!(result["seats"]["1"]["in_play"], false);
        assert_eq!(result["seats"]["2"]["in_play"], Value::Null);
        let mismatch = DynamicImage::new_rgb8(99, 20);
        let unknown = derive(Some(&mismatch), &config());
        assert_eq!(unknown["configuration"], "unavailable");
        assert_eq!(unknown["seats"]["0"]["in_play"], Value::Null);
        let mut invalid = config();
        invalid["colors"]["suits"]["clubs"] = json!("#ééé");
        assert_eq!(
            derive(Some(&image()), &invalid)["community_suits"],
            json!([null, null])
        );
    }
    #[test]
    fn suit_requires_strictly_more_than_forty_percent_palette_support() {
        let config = config();
        let colors: ColorConfig = serde_json::from_value(config["colors"].clone()).unwrap();
        let rect = Some(crate::assistant::vision::RegionRect {
            x: 0,
            y: 0,
            w: 10,
            h: 10,
        });
        for (pixels, expected) in [(40, None), (41, Some(("c", false)))] {
            let image = DynamicImage::ImageRgb8(ImageBuffer::from_fn(10, 10, |x, y| {
                Rgb(if y * 10 + x < pixels {
                    [0, 184, 1]
                } else {
                    [100, 100, 100]
                })
            }));
            assert_eq!(card_color(&image, rect, &colors), expected);
        }
    }
    #[test]
    fn cache_is_bounded_validates_original_identity_and_does_not_mutate_frame() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("frames")).unwrap();
        let bytes = crate::media::png(&image()).unwrap();
        let mut cache = ColorCache::default();
        for n in 0..18 {
            let id = format!("{n:032x}");
            fs::write(root.path().join("frames").join(format!("{id}.png")), &bytes).unwrap();
            let frame = json!({"id":id,"image_sha256":format!("{:x}",Sha256::digest(&bytes)),
                "config_snapshot":config(),"results":{"unchanged":"rank"}});
            let result = cache.enrich(root.path(), frame.clone());
            assert_eq!(result["color_state"]["community_suits"][0], "c");
            let mut without = result;
            without.as_object_mut().unwrap().remove("color_state");
            assert_eq!(without, frame);
        }
        assert_eq!(cache.0.len(), 16);
        let mut frame =
            json!({"id":format!("{:032x}",17),"image_sha256":"wrong","config_snapshot":config()});
        assert_eq!(
            cache.enrich(root.path(), frame.clone())["color_state"]["configuration"],
            "unavailable"
        );
        frame["id"] = json!("../../outside");
        assert_eq!(
            cache.enrich(root.path(), frame)["color_state"]["configuration"],
            "unavailable"
        );
    }
    #[test]
    #[ignore = "requires the private recorded pixel fixture, never reads live data"]
    fn private_recorded_frame_pixels() {
        let root = std::path::PathBuf::from(
            std::env::var_os("POKER_GAMEPLAY_COLOR_FIXTURE").expect("isolated fixture path"),
        );
        let config: Value =
            serde_json::from_slice(&fs::read(root.join("config.json")).unwrap()).unwrap();
        let image = crate::media::decode_image(&fs::read(root.join("frame.png")).unwrap()).unwrap();
        let result = derive(Some(&image), &config);
        println!("{result}");
        assert_eq!(
            result["community_suits"],
            json!(["c", "s", "s", null, null])
        );
        assert_eq!(result["seats"]["1"]["hand_suits"], json!(["s", "c"]));
        assert_eq!(result["seats"]["0"]["in_play"], false);
        assert_eq!(result["seats"]["2"]["in_play"], false);
        assert_eq!(result["seats"]["5"]["in_play"], false);
    }
}
