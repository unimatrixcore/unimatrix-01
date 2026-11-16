use poker_native::lab::pixel_assets;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn semantic_snapshot(conn: &Connection) -> Result<Value, Box<dyn std::error::Error>> {
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='pixel_assets' ORDER BY name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut output = BTreeMap::new();
    for table in tables {
        if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err("Unexpected table identifier".into());
        }
        let columns = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|column| !["crop", "pixel_asset_sha"].contains(&column.as_str()))
            .collect::<Vec<_>>();
        if columns.iter().any(|column| {
            !column
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        }) {
            return Err("Unexpected column identifier".into());
        }
        let mut statement = conn.prepare(&format!(
            "SELECT {} FROM {table} ORDER BY rowid",
            columns.join(",")
        ))?;
        let mut rows = statement.query([])?;
        let mut digest = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next()? {
            count += 1;
            for index in 0..columns.len() {
                match row.get_ref(index)? {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(value) => {
                        digest.update([1]);
                        digest.update(value.to_be_bytes());
                    }
                    ValueRef::Real(value) => {
                        digest.update([2]);
                        digest.update(value.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(value) | ValueRef::Blob(value) => {
                        digest.update([if matches!(row.get_ref(index)?, ValueRef::Text(_)) {
                            3
                        } else {
                            4
                        }]);
                        digest.update((value.len() as u64).to_be_bytes());
                        digest.update(value);
                    }
                }
            }
        }
        output.insert(
            table,
            json!({"rows":count,"sha256":format!("{:x}",digest.finalize())}),
        );
    }
    Ok(json!(output))
}

fn metrics(conn: &Connection, path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let enabled = pixel_assets::enabled(conn).map_err(|error| error.message)?;
    let mut tables = BTreeMap::new();
    for table in ["queue_items", "review_samples"] {
        let (rows, bytes): (i64, i64) = conn.query_row(
            &format!("SELECT count(*),coalesce(sum(length(crop)),0) FROM {table}"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let attached: i64 = if enabled {
            conn.query_row(
                &format!("SELECT count(*) FROM {table} WHERE pixel_asset_sha IS NOT NULL"),
                [],
                |row| row.get(0),
            )?
        } else {
            0
        };
        tables.insert(
            table,
            json!({"rows":rows,"inline_png_bytes":bytes,"asset_references":attached}),
        );
    }
    let (assets, bytes): (i64, i64) = if enabled {
        conn.query_row(
            "SELECT count(*),coalesce(sum(length(png)),0) FROM pixel_assets",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    } else {
        (0, 0)
    };
    let disk = ["", "-wal", "-shm"]
        .into_iter()
        .map(|suffix| {
            let filename = format!("{}{suffix}", path.display());
            let bytes = std::fs::metadata(filename)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            (
                if suffix.is_empty() {
                    "database"
                } else {
                    suffix
                },
                bytes,
            )
        })
        .collect::<BTreeMap<_, _>>();
    Ok(
        json!({"semantic_tables":tables,"pixel_assets":assets,"asset_png_bytes":bytes,"disk_bytes":disk,"page_count":conn.query_row("PRAGMA page_count",[],|row|row.get::<_,i64>(0))?,"free_pages":conn.query_row("PRAGMA freelist_count",[],|row|row.get::<_,i64>(0))?}),
    )
}

fn verify(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Err("Database integrity check failed".into());
    }
    let enabled = pixel_assets::enabled(conn).map_err(|error| error.message)?;
    if enabled {
        let mut statement=conn.prepare("SELECT length(poker_verified_crop(png,pixel_sha256,width,height,png_sha256)) FROM pixel_assets")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let _: i64 = row.get(0)?;
        }
    }
    for table in ["queue_items", "review_samples"] {
        let expression = if enabled {
            pixel_assets::expression(conn, table).map_err(|error| error.message)?
        } else {
            format!("poker_verified_crop({table}.crop,{table}.pixel_sha256,NULL,NULL,NULL)")
        };
        let mut statement = conn.prepare(&format!("SELECT length({expression}) FROM {table}"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let _: i64 = row.get(0)?;
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let operation = arguments
        .first()
        .map(String::as_str)
        .ok_or("Usage: pixel-assets inspect|verify|migrate --db PATH [--compact]")?;
    if !["inspect", "verify", "migrate"].contains(&operation) {
        return Err("Unknown operation".into());
    }
    let path = Path::new(
        arguments
            .windows(2)
            .find(|pair| pair[0] == "--db")
            .map(|pair| pair[1].as_str())
            .ok_or("--db is required")?,
    );
    if path.file_name().and_then(|name| name.to_str()) != Some("ocr-evidence.sqlite3")
        || !path.is_file()
        || std::fs::symlink_metadata(path)?.file_type().is_symlink()
    {
        return Err("Select an existing global ocr-evidence.sqlite3 ledger".into());
    }
    let writable = operation == "migrate";
    let conn = Connection::open_with_flags(
        path,
        if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        },
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    for table in ["gameplay_ai_occurrences", "gameplay_ai_runs"] {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=? AND type='table')",
            [table],
            |row| row.get::<_, bool>(0),
        )? {
            return Err("This is not the global Gameplay OCR ledger".into());
        }
    }
    let active: i64 = conn.query_row(
        "SELECT count(*) FROM ai_review_jobs WHERE state IN ('queued','running')",
        [],
        |row| row.get(0),
    )?;
    if writable && active != 0 {
        return Err("Stop active review jobs before migration".into());
    }
    pixel_assets::install(&conn).map_err(|error| error.message)?;
    let before = metrics(&conn, path)?;
    let original = semantic_snapshot(&conn)?;
    if writable {
        conn.execute_batch("PRAGMA foreign_keys=ON")?;
        pixel_assets::migrate(&conn).map_err(|error| error.message)?;
    }
    if operation != "inspect" {
        verify(&conn)?;
    }
    let current = semantic_snapshot(&conn)?;
    if original != current {
        return Err("Semantic ledger rows changed during asset operation".into());
    }
    if writable && arguments.iter().any(|argument| argument == "--compact") {
        conn.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);VACUUM;PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        verify(&conn)?;
        if original != semantic_snapshot(&conn)? {
            return Err("Semantic ledger rows changed during compaction".into());
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"operation":operation,"path":path,"before":before,"after":metrics(&conn,path)?,"semantic_snapshot":current,"semantic_rows_unchanged":true,"provider_calls":0,"jobs_created":0,"active_jobs":active})
        )?
    );
    Ok(())
}
