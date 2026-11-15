use poker_native::lab::legacy_benchmark::{apply, plan, Plan, SourceSpec};
use std::{fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some(mode @ ("plan" | "registry-plan")) => {
            let source_path=PathBuf::from(args.next().ok_or("Missing source specification or registry JSON path")?);
            let specs: Vec<SourceSpec> = if mode=="registry-plan" {
                let entries:serde_json::Value=serde_json::from_slice(&fs::read(&source_path)?)?;
                let parent=source_path.parent().ok_or("Registry has no parent directory")?;
                entries.as_array().ok_or("Dataset registry must be an array")?.iter().map(|entry| {
                    let id=entry["id"].as_str().ok_or("Dataset identity missing")?;
                    if id.is_empty() || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_') {return Err("Invalid dataset identity");}
                    Ok(SourceSpec{id:id.into(),name:entry["name"].as_str().ok_or("Dataset name missing")?.into(),directory:parent.join(id)})
                }).collect::<Result<Vec<_>,_>>()?
            } else {serde_json::from_slice(&fs::read(&source_path)?)?};
            let output = PathBuf::from(args.next().ok_or("Missing output plan path")?);
            let configs = args.map(PathBuf::from).collect::<Vec<_>>();
            let result = plan(&specs, &configs)?;
            use std::io::Write;
            let mut file = fs::OpenOptions::new().create_new(true).write(true).open(output)?;
            file.write_all(&serde_json::to_vec_pretty(&result)?)?;
            file.sync_all()?;
            println!("{}", serde_json::to_string_pretty(&result.summary)?);
        }
        Some("apply") => {
            let plan: Plan = serde_json::from_slice(&fs::read(args.next().ok_or("Missing plan JSON path")?)?)?;
            let destination = PathBuf::from(args.next().ok_or("Missing existing Gameplay directory")?);
            if args.next().as_deref() != Some("--apply") || args.next().is_some() { return Err("Explicit --apply is required; no extra arguments allowed".into()); }
            println!("{}", serde_json::to_string_pretty(&apply(&plan, &destination)?)?);
        }
        _ => return Err("Usage: legacy_benchmark plan <sources.json> <new-plan.json> [recovered-regions.json ...] | registry-plan <datasets.json> <new-plan.json> [recovered-regions.json ...] | apply <plan.json> <existing-gameplay-directory> --apply".into()),
    }
    Ok(())
}
