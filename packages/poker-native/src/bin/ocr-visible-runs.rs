use base64::{engine::general_purpose::STANDARD, Engine};
use poker_native::lab::gameplay::{crop_mask::MaskDescriptor, visible_runs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const MAX_REQUEST_BYTES: usize =
    poker_native::media::MAX_IMAGE_BYTES.div_ceil(3) * 4 + 16 * 1024 * 1024;

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

fn read_request_line(
    reader: &mut impl BufRead,
    limit: usize,
) -> io::Result<Option<Result<String, &'static str>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    let mut consumed = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !consumed {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload = newline.unwrap_or(available.len());
        consumed = true;
        if !oversized {
            if payload > limit.saturating_sub(line.len()) {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..payload]);
            }
        }
        reader.consume(payload + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    Ok(Some(if oversized {
        Err("Request exceeds byte limit")
    } else {
        String::from_utf8(line).map_err(|_| "Request is not UTF-8")
    }))
}

fn serve(mut reader: impl BufRead, mut output: impl Write, limit: usize) -> anyhow::Result<()> {
    while let Some(line) = read_request_line(&mut reader, limit)? {
        let response = match line {
            Ok(line) => process(&line).unwrap_or_else(|err| json!({"error":err.to_string()})),
            Err(error) => json!({"error":error}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    serve(io::stdin().lock(), io::stdout().lock(), MAX_REQUEST_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use poker_native::lab::gameplay::crop_mask::{self, Rect, SourcePanel};
    use std::io::{BufReader, Cursor};

    fn valid_request() -> String {
        let image = image::RgbImage::from_pixel(30, 30, image::Rgb(crop_mask::NEUTRAL_RGB));
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let mask = crop_mask::from_resolved_panels(
            SourcePanel::ChipColumnsValue,
            [0.0, 0.0],
            &[Rect {
                x: 0.0,
                y: 0.0,
                width: 30.0,
                height: 30.0,
            }],
        )
        .unwrap();
        json!({"png_base64":STANDARD.encode(encoded.into_inner()),"crop_mask":mask}).to_string()
    }

    #[test]
    fn oversized_line_is_drained_once_and_next_valid_request_is_processed() {
        let valid = valid_request();
        let input = format!("{}\n{valid}\n", "x".repeat(valid.len() + 100));
        let mut output = Vec::new();
        serve(
            BufReader::with_capacity(7, input.as_bytes()),
            &mut output,
            valid.len(),
        )
        .unwrap();
        let responses: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["error"], "Request exceeds byte limit");
        assert!(responses[1].get("error").is_none(), "{}", responses[1]);
        assert_eq!(responses[1]["runs"], json!([]));
    }

    #[test]
    fn oversized_unterminated_request_and_invalid_utf8_are_errors() {
        let mut input = Cursor::new(b"12345".to_vec());
        assert_eq!(
            read_request_line(&mut input, 4).unwrap(),
            Some(Err("Request exceeds byte limit"))
        );
        assert_eq!(read_request_line(&mut input, 4).unwrap(), None);
        let mut input = Cursor::new(vec![255, b'\n', b'1']);
        assert_eq!(
            read_request_line(&mut input, 4).unwrap(),
            Some(Err("Request is not UTF-8"))
        );
        assert_eq!(
            read_request_line(&mut input, 4).unwrap(),
            Some(Ok("1".into()))
        );
    }
}
