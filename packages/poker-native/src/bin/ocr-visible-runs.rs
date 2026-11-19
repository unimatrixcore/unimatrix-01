use base64::{engine::general_purpose::STANDARD, Engine};
use poker_native::lab::gameplay::{crop_mask::MaskDescriptor, visible_runs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead};

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum Request {
    Parent {
        png_base64: String,
        crop_mask: MaskDescriptor,
        #[serde(default)]
        include_pixels: bool,
    },
    Frame {
        frame_png_base64: String,
        profile: Value,
        region_ids: Vec<String>,
        #[serde(default)]
        include_pixels: bool,
    },
}
fn image(data: String) -> anyhow::Result<image::DynamicImage> {
    anyhow::ensure!(
        data.len() <= poker_native::media::MAX_IMAGE_BYTES.div_ceil(3) * 4,
        "Image exceeds limit"
    );
    let bytes = STANDARD.decode(data)?;
    anyhow::ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "Expected PNG");
    poker_native::media::decode_image(&bytes).map_err(anyhow::Error::msg)
}
fn serialize(runs: Vec<visible_runs::Run>, include_pixels: bool) -> anyhow::Result<Value> {
    let mut values = Vec::new();
    for run in runs {
        let mut value = serde_json::to_value(&run)?;
        if include_pixels {
            value["png_base64"] = json!(STANDARD.encode(run.png()?));
        }
        values.push(value);
    }
    Ok(
        json!({"policy":visible_runs::POLICY,"coordinate_space":"parent_local","recognition_task":"visible_run","runs":values}),
    )
}
fn process(line: &str) -> anyhow::Result<Value> {
    match serde_json::from_str::<Request>(line)? {
        Request::Parent {
            png_base64,
            crop_mask,
            include_pixels,
        } => serialize(
            visible_runs::extract(&image(png_base64)?.to_rgb8(), &crop_mask)?,
            include_pixels,
        ),
        Request::Frame {
            frame_png_base64,
            profile,
            region_ids,
            include_pixels,
        } => {
            let frame = image(frame_png_base64)?;
            let profile = visible_runs::resolve_bet_profile(&frame, &profile)?;
            let regions = profile["regions"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Missing profile regions"))?;
            let mut parents = Vec::new();
            for id in region_ids {
                let region = regions
                    .iter()
                    .find(|r| r["id"] == id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown region {id}"))?;
                anyhow::ensure!(
                    region["category"] == "bet"
                        && region["crop_mask_source"] == "chip_columns_value",
                    "Expected bet region {id}"
                );
                let runs = if visible_runs::eligible(region) {
                    visible_runs::extract_region(&frame, region)?
                } else {
                    Vec::new()
                };
                let mut parent = serialize(runs, include_pixels)?;
                if visible_runs::eligible(region) {
                    let evidence = visible_runs::parent_evidence(&frame, region)?;
                    for key in [
                        "parent_raw_pixel_sha256",
                        "parent_rect",
                        "parent_coverage_rle",
                    ] {
                        parent[key] = evidence[key].clone();
                    }
                }
                parent["region_id"] = json!(id);
                for key in [
                    "source_region_id",
                    "bounds",
                    "crop_mask",
                    "presence",
                    "guide",
                    "localization_error",
                    "seat_occupancy",
                ] {
                    parent[key] = region[key].clone();
                }
                parents.push(parent);
            }
            Ok(json!({"policy":visible_runs::POLICY,"parents":parents}))
        }
    }
}

fn main() -> anyhow::Result<()> {
    for line in io::stdin().lock().lines() {
        let response = process(&line?).unwrap_or_else(|err| json!({"error":err.to_string()}));
        println!("{}", response);
    }
    Ok(())
}
