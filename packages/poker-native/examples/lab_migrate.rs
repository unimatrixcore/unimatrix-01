use poker_native::lab::migration::{migrate, MigrationPaths};
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 4 {
        return Err("Usage: lab_migrate <source Poker data root> <source config root> <fresh destination data root> <fresh destination config root>".into());
    }
    let report = migrate(&MigrationPaths {
        source_data: args[0].clone(),
        source_config: args[1].clone(),
        destination_data: args[2].clone(),
        destination_config: args[3].clone(),
    })?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
