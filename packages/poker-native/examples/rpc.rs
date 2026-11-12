use poker_native::NativeStore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    payload: Value,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Usage: rpc <absolute-managed-dataset-path>")?;
    let mut store = NativeStore::open(root)?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = serde_json::from_str::<Request>(&line)
            .map_err(|e| e.to_string())
            .and_then(|request| store.request(&request.operation, &request.payload));
        let response = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
