use poker_native::lab::{LabRequest, LabResponse, LabService};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
};
fn response(service: &LabService, request: Value) -> LabResponse {
    match serde_json::from_value::<LabRequest>(request) {
        Ok(request) => service.request(request),
        Err(error) => LabResponse::json(400, json!({"success":false,"error":error.to_string()})),
    }
}
fn emit(output: &Mutex<io::Stdout>, value: Value) {
    let line = serde_json::to_string(&value).expect("JSON response");
    let mut output = output.lock().expect("stdout lock");
    if writeln!(output, "{line}")
        .and_then(|_| output.flush())
        .is_err()
    {
        return;
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root=args.next().map(PathBuf::from).ok_or("Usage: lab_rpc <absolute isolated data root> <absolute isolated config root> <absolute retained tools root>")?;
    let config = args
        .next()
        .map(PathBuf::from)
        .ok_or("An explicit config root is required")?;
    let tools = args
        .next()
        .map(PathBuf::from)
        .ok_or("An explicit retained tools root is required")?;
    if !root.is_absolute() || !config.is_absolute() || !tools.is_absolute() {
        return Err("All paths must be absolute".into());
    }
    let mut environment: std::collections::HashMap<String, String> = std::env::vars().collect();
    environment.insert(
        "POKER_GAMEPLAY_ROOT".into(),
        root.join("gameplay_recordings")
            .to_string_lossy()
            .into_owned(),
    );
    let service = Arc::new(LabService::open_with_paths(
        root,
        config,
        tools,
        environment,
    )?);
    let output = Arc::new(Mutex::new(io::stdout()));
    let (sender, receiver) = mpsc::sync_channel::<(Value, Value)>(16);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::new();
    for _ in 0..16 {
        let service = service.clone();
        let receiver = receiver.clone();
        let output = output.clone();
        workers.push(thread::spawn(move || loop {
            let item = receiver.lock().expect("request receiver").recv();
            let Ok((id, request)) = item else {
                break;
            };
            emit(
                &output,
                json!({"id":id,"response":response(&service,request)}),
            );
        }));
    }
    for line in io::stdin().lock().lines() {
        let value: Value = match serde_json::from_str(&line?) {
            Ok(value) => value,
            Err(error) => {
                emit(
                    &output,
                    serde_json::to_value(LabResponse::json(
                        400,
                        json!({"success":false,"error":error.to_string()}),
                    ))?,
                );
                continue;
            }
        };
        if let (Some(id), Some(request)) = (value.get("id"), value.get("request")) {
            sender.send((id.clone(), request.clone()))?;
        } else {
            emit(&output, serde_json::to_value(response(&service, value))?);
        }
    }
    drop(sender);
    for worker in workers {
        worker.join().map_err(|_| "Lab request worker panicked")?;
    }
    service.model.shutdown();
    service.gameplay.shutdown();
    Ok(())
}
