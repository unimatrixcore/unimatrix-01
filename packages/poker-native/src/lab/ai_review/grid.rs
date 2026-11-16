use super::{bad, region_group, Item, LabResult};
use ab_glyph::FontArc;
use image::{
    imageops::{self, FilterType},
    DynamicImage, ImageFormat, Rgb, RgbImage,
};
use imageproc::drawing::{draw_text_mut, text_size};
use std::io::Cursor;
pub(super) fn panel_key(guide: &serde_json::Value, pixels: &str) -> Option<String> {
    if guide["family"] != "split_pot_group"
        || guide["ordinal_basis"] != "rendered_visible_order"
        || guide["target_ordinal"].as_u64().is_none()
    {
        return None;
    }
    let mut shared = guide.clone();
    shared.as_object_mut()?.remove("target_ordinal");
    Some(crate::lab::sha256(format!("{pixels}:{shared}").as_bytes()))
}
fn row_guide(row: &serde_json::Value) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(row["payload"].as_str().unwrap_or("{}"))
        .unwrap_or(serde_json::Value::Null)["guide"]
        .clone()
}
fn fits_batch(rows: &[serde_json::Value], indices: &[usize]) -> bool {
    if !indices
        .iter()
        .any(|index| !row_guide(&rows[*index]).is_null())
    {
        return true;
    }
    let mut panels = Vec::<(u64, u64, usize)>::new();
    let mut keys = std::collections::BTreeMap::<String, usize>::new();
    for index in indices {
        let row = &rows[*index];
        let guide = row_guide(row);
        let (Some(w), Some(h)) = (guide["crop_width"].as_u64(), guide["crop_height"].as_u64())
        else {
            return false;
        };
        let key = panel_key(&guide, row["pixel_sha256"].as_str().unwrap_or(""));
        if let Some(index) = key.as_ref().and_then(|key| keys.get(key)).copied() {
            panels[index].2 += 1;
        } else {
            if let Some(key) = key {
                keys.insert(key, panels.len());
            }
            panels.push((w, h, 1));
        }
    }
    let (mut x, mut y, mut row_height) = (0u64, 44u64, 0u64);
    for (w, h, count) in panels {
        let width = (w + 24).max(420);
        let height = (h + 42).max(132)
            + if count > 1 {
                12 + count as u64 * 22
            } else {
                72
            };
        if width > 2048 {
            return false;
        }
        if x > 0 && x + width > 1600 {
            y += row_height;
            x = 0;
            row_height = 0;
        }
        x += width;
        row_height = row_height.max(height);
    }
    y + row_height <= 2048
}
#[cfg(test)]
pub(super) fn plan_batches(
    rows: &[serde_json::Value],
    requested: i64,
) -> LabResult<Vec<Vec<usize>>> {
    plan_batches_mixed(rows, requested, false)
}
pub(super) fn plan_batches_mixed(
    rows: &[serde_json::Value],
    requested: i64,
    mixed: bool,
) -> LabResult<Vec<Vec<usize>>> {
    let requested = requested as usize;
    let mut chunks = Vec::<(String, Vec<usize>)>::new();
    let mut grouped = std::collections::BTreeMap::<String, usize>::new();
    for (index, row) in rows.iter().enumerate() {
        let guide = row_guide(row);
        let group = if !guide.is_null() {
            let id = row["region_id"].as_str().unwrap_or("");
            if id.starts_with("board.")
                || id.contains(".card.")
                || id.starts_with("community_cards[")
                || id.contains(".cards[")
            {
                let frame = row["frame_id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("isolated-{index}"));
                let card = id.strip_suffix(".suit").unwrap_or(id);
                let card = if card.starts_with("board.") || card.contains(".card.") {
                    card.strip_suffix(".rank").unwrap_or(card)
                } else {
                    card
                };
                format!("card:{frame}:{card}")
            } else {
                format!("guided:{}", guide["family"].as_str().unwrap_or(id))
            }
        } else if mixed {
            "mixed-pilot".to_owned()
        } else {
            region_group(row["region_id"].as_str().unwrap_or(""))
        };
        let key = panel_key(&row_guide(row), row["pixel_sha256"].as_str().unwrap_or(""));
        if let Some(found) = key
            .as_ref()
            .and_then(|key| grouped.get(&format!("{group}:{key}")))
            .copied()
        {
            chunks[found].1.push(index);
        } else {
            if let Some(key) = key {
                grouped.insert(format!("{group}:{key}"), chunks.len());
            }
            chunks.push((group, vec![index]));
        }
    }
    if rows.iter().any(|row| !row_guide(row).is_null()) {
        chunks.sort_by(|a, b| a.0.cmp(&b.0));
    }
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_group = String::new();
    for (group, indices) in chunks {
        for chunk in indices.chunks(requested) {
            let mut candidate = current.clone();
            candidate.extend_from_slice(chunk);
            if !current.is_empty()
                && (group != current_group
                    || candidate.len() > requested
                    || !fits_batch(rows, &candidate))
            {
                batches.push(std::mem::take(&mut current));
            }
            if !fits_batch(rows, chunk) {
                return Err(bad(
                    "A guided panel exceeds native-pixel presentation limits",
                ));
            }
            current_group = group.clone();
            current.extend_from_slice(chunk);
        }
    }
    if !current.is_empty() {
        batches.push(current);
    }
    Ok(batches)
}
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
    let guided = items.iter().any(|item| !item.guide.is_null());
    let mut panels: Vec<Vec<&Item>> = Vec::new();
    let mut grouped = std::collections::BTreeMap::<String, usize>::new();
    for item in items {
        let key = panel_key(&item.guide, &crate::lab::sha256(&item.crop));
        if let Some(index) = key.as_ref().and_then(|key| grouped.get(key)).copied() {
            panels[index].push(item);
        } else {
            if let Some(key) = key {
                grouped.insert(key, panels.len());
            }
            panels.push(vec![item]);
        }
    }
    let dimensions = panels
        .iter()
        .map(|members| {
            let item = members[0];
            image::ImageReader::new(Cursor::new(&item.crop))
                .with_guessed_format()
                .map_err(|e| bad(e.to_string()))?
                .into_dimensions()
                .map_err(|e| bad(e.to_string()))
        })
        .collect::<LabResult<Vec<_>>>()?;
    if dimensions
        .iter()
        .any(|(w, h)| *w == 0 || *h == 0 || u64::from(*w) * u64::from(*h) > 16_000_000)
    {
        return Err(bad("Crop exceeds image limit"));
    }
    let mut layout = Vec::with_capacity(panels.len());
    let (sheet_width, sheet_height) = if guided {
        let (mut x, mut y, mut row_height, mut widest) = (0u32, 44u32, 0u32, 0u32);
        for (index, (width, height)) in dimensions.iter().enumerate() {
            let cell_width = width.saturating_add(24).max(420);
            let panel_height = height.saturating_add(42).max(132);
            if x > 0 && x + cell_width > 1600 {
                y += row_height;
                x = 0;
                row_height = 0;
            }
            let legend_height = if panels[index].len() > 1 {
                12 + panels[index].len() as u32 * 22
            } else {
                72
            };
            layout.push((x, y, cell_width, panel_height, legend_height));
            x += cell_width;
            widest = widest.max(x);
            row_height = row_height.max(panel_height + legend_height);
        }
        (widest, y + row_height)
    } else {
        let columns = items.len().min(4) as u32;
        for i in 0..items.len() as u32 {
            layout.push((i % columns * 420, 44 + i / columns * 204, 420, 132, 72));
        }
        (
            columns * 420,
            44 + (items.len() as u32).div_ceil(columns) * 204,
        )
    };
    if u64::from(sheet_width) * u64::from(sheet_height) > 32_000_000
        || guided && (sheet_width > 2048 || sheet_height > 2048)
    {
        return Err(bad(
            "Guided review sheet exceeds native-pixel presentation limits; use a smaller batch",
        ));
    }
    let mut canvas = RgbImage::from_pixel(sheet_width, sheet_height, Rgb([17, 19, 21]));
    let title = format!(
        "{} / {}",
        if items
            .iter()
            .map(|item| region_group(&item.region_id))
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            > 1
        {
            "mixed game-state fields".into()
        } else {
            region_group(&items[0].region_id)
        },
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
    for (index, members) in panels.iter().enumerate() {
        let item = members[0];
        let (x, y, cell_width, panel_height, legend_height) = layout[index];
        for (cx, cy, color) in [
            (x, y, Rgb([8, 10, 11])),
            (x, y + panel_height, Rgb([28, 32, 35])),
        ] {
            let h = if cy == y { panel_height } else { legend_height };
            for yy in cy..cy + h {
                for xx in cx..cx + cell_width {
                    canvas.put_pixel(
                        xx,
                        yy,
                        if yy == cy || yy == cy + h - 1 || xx == cx || xx == cx + cell_width - 1 {
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
            &if item.guide.is_null() {
                format!("ID {}  {}", item.ordinal, item.region_id)
            } else {
                format!(
                    "ID {} {} [{} / {}]",
                    item.ordinal,
                    item.region_id,
                    item.guide["family"].as_str().unwrap_or("target"),
                    item.guide["alignment"].as_str().unwrap_or("center")
                )
            },
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
        let scale = if guided {
            1.
        } else {
            (396.0 / original.width() as f64)
                .min(90.0 / original.height() as f64)
                .min(4.)
        };
        let w = (original.width() as f64 * scale).round().max(1.) as u32;
        let h = (original.height() as f64 * scale).round().max(1.) as u32;
        let crop = imageops::resize(&original.to_rgb8(), w, h, FilterType::Nearest);
        imageops::replace(
            &mut canvas,
            &crop,
            (x + (cell_width - w) / 2) as i64,
            (y + 30 + (panel_height - 34 - h) / 2) as i64,
        );
        if let (Some(ax), Some(ay)) = (
            item.guide["anchor"]["x"].as_f64(),
            item.guide["anchor"]["y"].as_f64(),
        ) {
            let left = x + (cell_width - w) / 2;
            let top = y + 30 + (panel_height - 34 - h) / 2;
            let gx = left + (ax * scale).round().clamp(0., (w - 1) as f64) as u32;
            let gy = top + (ay * scale).round().clamp(0., (h - 1) as f64) as u32;
            for distance in 1u32..=5 {
                for offset in -(distance as i32 / 2)..=distance as i32 / 2 {
                    for (px, py) in [
                        (gx as i32 + offset, top as i32 - distance as i32),
                        (gx as i32 + offset, (top + h - 1 + distance) as i32),
                        (left as i32 - distance as i32, gy as i32 + offset),
                        ((left + w - 1 + distance) as i32, gy as i32 + offset),
                    ] {
                        if px >= 0
                            && py >= 0
                            && (px as u32) < canvas.width()
                            && (py as u32) < canvas.height()
                        {
                            canvas.put_pixel(px as u32, py as u32, Rgb([30, 220, 240]));
                        }
                    }
                }
            }
        }
        if members.len() > 1 {
            for (line, member) in members.iter().enumerate() {
                let label = if blind {
                    "read independently"
                } else if member.prior_label.is_empty() {
                    "(empty label)"
                } else {
                    member.prior_label.as_str()
                };
                let text = format!(
                    "ID {} -> visible {}: {}",
                    member.ordinal,
                    member.guide["target_ordinal"].as_u64().unwrap_or(0),
                    label
                );
                draw_text_mut(
                    &mut canvas,
                    Rgb([231, 238, 238]),
                    (x + 10) as i32,
                    (y + panel_height + 7 + line as u32 * 22) as i32,
                    16.,
                    &font,
                    &text,
                );
            }
            continue;
        }
        let label = if blind {
            "Read crop only"
        } else if item.prior_label.is_empty() {
            "(empty label)"
        } else {
            &item.prior_label
        };
        let mut remaining = label.to_string();
        let mut cell = RgbImage::from_pixel(cell_width - 20, 64, Rgb([28, 32, 35]));
        for line in 0..2 {
            let chars: Vec<_> = remaining.chars().collect();
            let mut take = chars.len();
            while take > 0
                && text_size(19., &font, &chars[..take].iter().collect::<String>()).0
                    > cell_width - 24
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
        imageops::replace(
            &mut canvas,
            &cell,
            (x + 10) as i64,
            (y + panel_height + 7) as i64,
        );
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
            guide: serde_json::Value::Null,
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
        let mut guided = item.clone();
        guided.guide =
            serde_json::json!({"anchor":{"x":10,"y":5},"alignment":"center","family":"test"});
        let guided = image::load_from_memory(&build(&[guided], true).unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(
            guided.view(200, 118, 20, 10).to_image(),
            RgbImage::from_pixel(20, 10, Rgb([230, 40, 70]))
        );
        assert!(guided.pixels().any(|p| p.0 == [30, 220, 240]));
        assert!(build(&[], false).is_err());
        assert!(build(&vec![item; 25], false).is_err());
    }
}

#[cfg(test)]
mod grouped_tests {
    use super::*;
    use image::GenericImageView;
    use serde_json::{json, Value};
    fn items() -> Vec<Item> {
        let rgb = RgbImage::from_fn(922, 576, |x, y| Rgb([(x % 251) as u8, (y % 251) as u8, 71]));
        let crop = crate::media::png(&DynamicImage::ImageRgb8(rgb)).unwrap();
        (0..10).map(|i|Item {job_id:"fixture".into(),ordinal:i,batch_index:0,queue_id:i,sample_key:format!("pot-{i}"),region_id:format!("pot.{i}"),group_name:"pot.visible[*]".into(),prior_label:String::new(),prior_prediction_id:None,pixel_sha256:"same-pixels".into(),prior_event_id:0,crop:crop.clone(),guide:json!({"policy":"fixture","family":"split_pot_group","ordinal_basis":"rendered_visible_order","target_ordinal":i,"source":"css_slot","alignment":"center","anchor":{"x":461.,"y":288.},"slot_polygon":[],"crop_width":922,"crop_height":576,"visible_pixel_rect":{"x":0,"y":0,"width":922,"height":576}})}).collect()
    }
    #[test]
    fn identical_pot_context_is_one_rgb_panel_with_individual_ids() {
        let items = items();
        let png = build(&items, true).unwrap();
        let sheet = crate::media::decode_image(&png).unwrap().to_rgb8();
        assert_eq!(sheet.dimensions(), (946, 894));
        assert_eq!(
            sheet.view(12, 78, 922, 576).to_image(),
            crate::media::decode_image(&items[0].crop)
                .unwrap()
                .to_rgb8()
        );
        let response = json!({"output_text":json!({"items":items.iter().map(|item|json!({"id":item.ordinal.to_string(),"text":"","clarity":"blank","reason":"visible absent ordinal"})).collect::<Vec<_>>()}).to_string()});
        assert_eq!(
            super::super::protocol::parse(&response, &items)
                .unwrap()
                .len(),
            10
        );
        let mut missing = response.clone();
        let mut rows: Value =
            serde_json::from_str(missing["output_text"].as_str().unwrap()).unwrap();
        rows["items"].as_array_mut().unwrap().pop();
        missing["output_text"] = json!(rows.to_string());
        assert!(super::super::protocol::parse(&missing, &items).is_err());
        for variant in 0..3 {
            let mut changed = items.clone();
            if variant == 0 {
                let mut rgb = crate::media::decode_image(&changed[9].crop)
                    .unwrap()
                    .to_rgb8();
                rgb.put_pixel(20, 20, Rgb([0, 0, 0]));
                changed[9].crop = crate::media::png(&DynamicImage::ImageRgb8(rgb)).unwrap();
            } else if variant == 1 {
                changed[9].guide["anchor"]["x"] = json!(462.);
            } else {
                changed[9].guide["family"] = json!("different_family");
            }
            assert!(
                crate::media::decode_image(&build(&changed, true).unwrap())
                    .unwrap()
                    .height()
                    > 894
            );
        }
    }
    #[test]
    fn gameplay_card_targets_never_share_broad_or_other_card_context() {
        let ids = [
            "board.0.rank",
            "pot.0",
            "board.0.suit",
            "board.1.rank",
            "table.info",
        ];
        let rows=ids.iter().map(|id|json!({"region_id":id,"payload":json!({"guide":{"family":if id.starts_with("board"){"card.rank"}else{*id},"crop_width":20,"crop_height":20}}).to_string()})).collect::<Vec<_>>();
        let batches = plan_batches_mixed(&rows, 12, true).unwrap();
        for batch in batches {
            for pair in batch.windows(2) {
                assert_eq!(
                    ids[pair[0]].rsplit_once('.').unwrap().0,
                    ids[pair[1]].rsplit_once('.').unwrap().0
                );
            }
        }
    }
    #[test]
    fn context_panels_honor_requested_semantic_ceiling_and_co_locate_ordinals() {
        let mut rows = Vec::new();
        for frame in 0..2 {
            for item in items() {
                rows.push(json!({"region_id":item.region_id,"pixel_sha256":format!("frame-{frame}"),"payload":json!({"guide":item.guide}).to_string()}));
            }
        }
        let normal = plan_batches(&rows, 12).unwrap();
        assert_eq!(
            normal.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![10, 10]
        );
        assert_eq!(plan_batches(&rows, 24).unwrap()[0].len(), 20);
        assert!(plan_batches(&rows, 3)
            .unwrap()
            .iter()
            .all(|batch| batch.len() <= 3));
    }
}
