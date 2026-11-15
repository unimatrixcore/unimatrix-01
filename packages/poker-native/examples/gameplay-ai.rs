use poker_native::lab::{LabRequest, LabService};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let operation=args.first().map(String::as_str).ok_or("Usage: gameplay-ai prepare|status|start|items --session ID [--run ID --budget N --root PATH --config PATH]")?;
    let option = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
    };
    if operation == "export" {
        let selection: Value = serde_json::from_slice(&std::fs::read(
            option("--selection").ok_or("--selection is required")?,
        )?)?;
        let pairs = selection
            .as_array()
            .filter(|pairs| !pairs.is_empty() && pairs.len() <= 24)
            .ok_or("Select1to24frame/region pairs")?;
        let profile_path = option("--profile").ok_or("--profile source JSON is required")?;
        let profile = std::fs::read(&profile_path)?;
        use sha2::{Digest, Sha256};
        let profile_sha = format!("{:x}", Sha256::digest(&profile));
        let frames = PathBuf::from(
            option("--frames").ok_or("--frames protected PNG directory is required")?,
        );
        let output =
            PathBuf::from(option("--output").ok_or("--output private directory is required")?);
        std::fs::create_dir_all(&output)?;
        let mut receipt = Vec::new();
        let mut by_frame = BTreeMap::<String, Vec<String>>::new();
        for pair in pairs {
            let frame = pair["frame_id"].as_str().ok_or("Missingframe_id")?;
            if frame.len() != 32 || !frame.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalidframe_id".into());
            }
            by_frame
                .entry(frame.into())
                .or_default()
                .push(pair["region_id"].as_str().ok_or("Missingregion_id")?.into());
        }
        let mut ready = BTreeMap::new();
        for (frame, ids) in by_frame {
            let raw = std::fs::read(frames.join(format!("{frame}.png")))?;
            if let Ok(evidence) = poker_native::lab::gameplay::ai::GameplayAi::export_pixel_evidence(
                &profile, &raw, &ids,
            ) {
                for e in evidence {
                    ready.insert((frame.clone(), e.region_id.clone()), e);
                }
            }
        }
        for (index, pair) in pairs.iter().enumerate() {
            let frame = pair["frame_id"].as_str().ok_or("Missingframe_id")?;
            if frame.len() != 32 || !frame.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalidframe_id".into());
            }
            let id = pair["region_id"].as_str().ok_or("Missingregion_id")?;
            let raw = std::fs::read(frames.join(format!("{frame}.png")))?;
            let evidence = if let Some(evidence) =
                ready.remove(&(frame.to_string(), id.to_string()))
            {
                evidence
            } else {
                let mut exported =
                    match poker_native::lab::gameplay::ai::GameplayAi::export_pixel_evidence(
                        &profile,
                        &raw,
                        &[id.into()],
                    ) {
                        Ok(value) => value,
                        Err(error) if option("--allow-unavailable").as_deref() == Some("true") => {
                            receipt.push(json!({"frame_id":frame,"region_id":id,"unavailable_reason":error.message}));
                            continue;
                        }
                        Err(error) => return Err(error.message.into()),
                    };
                exported.remove(0)
            };
            let filename = format!("{index:02}-{frame}-{}.png", id.replace('.', "_"));
            std::fs::write(output.join(&filename), &evidence.png)?;
            let presentation_filename = filename.replace(".png", "-display.png");
            std::fs::write(
                output.join(&presentation_filename),
                &evidence.presentation_png,
            )?;
            let mut metadata = serde_json::to_value(&evidence)?;
            metadata["frame_id"] = json!(frame);
            metadata["filename"] = json!(filename);
            metadata["presentation_filename"] = json!(presentation_filename);
            metadata["frame_image_sha256"] = json!(format!("{:x}", Sha256::digest(&raw)));
            receipt.push(metadata);
        }
        let metadata = json!({"source_profile":profile_path,"profile_sha256":profile_sha,"source_profile_id":serde_json::from_slice::<Value>(&profile)?["id"],"provider_calls":0,"jobs_created":0,"label_source":"unreviewed_native_pixels","pixel_sha_convention":"SHA256(width+'x'+height+':RGB:'+decodedRGBbytes)","items":receipt});
        std::fs::write(
            output.join("receipt.json"),
            serde_json::to_vec_pretty(&metadata)?,
        )?;
        println!(
            "{}",
            json!({"exported":pairs.len(),"provider_calls":0,"output":output})
        );
        return Ok(());
    }
    let session = option("--session").ok_or("--session is required")?;
    let root = option("--root")
        .map(PathBuf::from)
        .unwrap_or_else(poker_native::storage_paths::data_dir);
    let config = option("--config")
        .map(PathBuf::from)
        .unwrap_or_else(poker_native::storage_paths::config_dir);
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
    let mut environment = std::env::vars().collect::<std::collections::HashMap<String, String>>();
    environment.insert(
        "POKER_GAMEPLAY_ROOT".into(),
        root.join("gameplay_recordings")
            .to_string_lossy()
            .into_owned(),
    );
    let service = LabService::open_with_paths(root, config, tools, environment)
        .map_err(|error| error.message)?;
    let request = |method: &str, operation: &str, body: Value| {
        let response = service.request(LabRequest {
            method: method.into(),
            path: format!("/api/gameplay/ai/{operation}"),
            body,
            query: if method == "GET" {
                BTreeMap::from([("session_id".into(), session.clone())])
            } else {
                BTreeMap::new()
            },
            headers: BTreeMap::new(),
        });
        if response.status >= 400 {
            Err(format!("{}:{}", response.status, response.body))
        } else {
            Ok(response.body)
        }
    };
    let body = match operation {
        "prepare" => request("POST", "prepare", json!({"session_id":session}))?,
        "prepare-pilot" => request(
            "POST",
            "prepare",
            json!({"session_id":session,"selection":serde_json::from_slice::<Value>(&std::fs::read(option("--selection").ok_or("--selectionisrequired")?)?)?}),
        )?,
        "status" => request("GET", "status", Value::Null)?,
        "items" => request("GET", "items", Value::Null)?,
        "plan" => {
            let mut plan = request("GET", "plan", Value::Null)?;
            plan["provider"] = service.ai_review.config().map_err(|error| error.message)?;
            plan
        }
        "frame" => {
            let id = option("--frame").ok_or("--frame is required")?;
            let response = service.request(LabRequest {
                method: "GET".into(),
                path: format!("/api/gameplay/frames/{id}"),
                body: Value::Null,
                query: BTreeMap::new(),
                headers: BTreeMap::new(),
            });
            if response.status >= 400 {
                return Err(format!("{}:{}", response.status, response.body).into());
            }
            response.body
        }
        "proof" => {
            let region = option("--region").ok_or("--region is required")?;
            let output = option("--output").ok_or("--output is required")?;
            let response = service.request(LabRequest {
                method: "GET".into(),
                path: "/api/gameplay/ai/proof".into(),
                body: Value::Null,
                query: BTreeMap::from([
                    ("session_id".into(), session.clone()),
                    ("region_id".into(), region),
                    ("profile_id".into(), option("--profile").unwrap_or_default()),
                ]),
                headers: BTreeMap::new(),
            });
            if response.status >= 400 {
                return Err(format!("{}:{}", response.status, response.body).into());
            }
            use base64::Engine;
            std::fs::write(
                &output,
                base64::engine::general_purpose::STANDARD
                    .decode(response.body_base64.ok_or("Evidence PNG missing")?)?,
            )?;
            json!({"read_only":true,"provider_calls":0,"output":output})
        }
        "start" => {
            let run = option("--run").ok_or("--run from a successful prepare is required")?;
            let budget = option("--budget")
                .ok_or("--budget is required for paid review")?
                .parse::<u64>()?;
            request(
                "POST",
                "start",
                json!({"session_id":session,"run_id":run,"max_requests":budget,"auto_correct":true}),
            )?;
            let mut last = Value::Null;
            loop {
                let current = request("GET", "status", Value::Null)?;
                if current != last {
                    eprintln!("{}", current);
                    last = current.clone();
                }
                let state = current["job"]["state"].as_str().unwrap_or("");
                if !["queued", "running"].contains(&state) {
                    break current;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        _ => return Err("Unknown operation".into()),
    };
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}
