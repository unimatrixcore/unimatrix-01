use crate::media::decode_image;
use image::DynamicImage;
use regex::Regex;
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct Monitor {
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip)]
    x: i32,
    #[serde(skip)]
    y: i32,
}
fn output(command: &mut Command) -> Result<Vec<u8>, String> {
    let o = command
        .output()
        .map_err(|e| format!("Capture command unavailable: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "Capture command failed: {}",
            String::from_utf8_lossy(&o.stderr)
        ));
    }
    Ok(o.stdout)
}
fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}
pub fn monitors() -> Result<Vec<Monitor>, String> {
    if wayland() {
        let data = output(Command::new("hyprctl").args(["monitors", "-j"]))?;
        let data: serde_json::Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        data.as_array()
            .ok_or("Invalid hyprctl monitor response")?
            .iter()
            .map(|m| {
                let name = m["name"]
                    .as_str()
                    .filter(|x| !x.is_empty())
                    .ok_or("Invalid monitor name")?
                    .to_owned();
                let width = m["width"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 16384)
                    .ok_or("Invalid monitor width")? as u32;
                let height = m["height"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 16384)
                    .ok_or("Invalid monitor height")? as u32;
                Ok(Monitor {
                    name,
                    width,
                    height,
                    x: 0,
                    y: 0,
                })
            })
            .collect()
    } else {
        let data = output(Command::new("xrandr").arg("--query"))?;
        let regex = Regex::new(r"^(\S+) connected (?:primary )?(\d+)x(\d+)([+-]\d+)([+-]\d+)")
            .map_err(|e| e.to_string())?;
        let mut monitors = Vec::new();
        for line in String::from_utf8_lossy(&data).lines() {
            if let Some(c) = regex.captures(line) {
                let width: u32 = c[2].parse().map_err(|_| "Invalid monitor width")?;
                let height: u32 = c[3].parse().map_err(|_| "Invalid monitor height")?;
                if width == 0 || height == 0 || width > 16384 || height > 16384 {
                    continue;
                }
                monitors.push(Monitor {
                    name: c[1].into(),
                    width,
                    height,
                    x: c[4].parse().map_err(|_| "Invalid x")?,
                    y: c[5].parse().map_err(|_| "Invalid y")?,
                });
            }
        }
        Ok(monitors)
    }
}
pub fn screenshot(name: &str) -> Result<(Vec<u8>, DynamicImage), String> {
    let monitor = monitors()?
        .into_iter()
        .find(|m| m.name == name)
        .ok_or("Selected monitor is not available")?;
    let bytes = if wayland() {
        output(Command::new("grim").args(["-o", &monitor.name, "-"]))?
    } else {
        let geometry = format!(
            "{}x{}{:+}{:+}",
            monitor.width, monitor.height, monitor.x, monitor.y
        );
        output(Command::new("maim").args(["-g", &geometry]))?
    };
    let img = decode_image(&bytes)?;
    Ok((bytes, img))
}
