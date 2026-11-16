use super::{bad, conflict, sha256, LabResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub fn enabled(conn: &Connection) -> LabResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='pixel_assets' AND type='table')",
        [],
        |r| r.get(0),
    )?)
}

fn identity(png: &[u8]) -> LabResult<(String, u32, u32)> {
    if image::guess_format(png).ok() != Some(image::ImageFormat::Png) {
        return Err(bad("Pixel asset must be PNG"));
    }
    let decoded = crate::media::decode_image(png).map_err(bad)?;
    if u64::from(decoded.width()) * u64::from(decoded.height()) > 16_000_000 {
        return Err(bad("Pixel asset exceeds crop limit"));
    }
    // RGB identity accepts opaque PNGs only; alpha masks need their own identity policy.
    let opaque = match &decoded {
        image::DynamicImage::ImageRgba8(image) => image.pixels().all(|pixel| pixel.0[3] == u8::MAX),
        image::DynamicImage::ImageLumaA8(image) => {
            image.pixels().all(|pixel| pixel.0[1] == u8::MAX)
        }
        image::DynamicImage::ImageRgba16(image) => {
            image.pixels().all(|pixel| pixel.0[3] == u16::MAX)
        }
        image::DynamicImage::ImageLumaA16(image) => {
            image.pixels().all(|pixel| pixel.0[1] == u16::MAX)
        }
        _ => !decoded.color().has_alpha(),
    };
    if !opaque {
        return Err(bad(
            "Pixel assets require fully opaque PNGs; alpha masks are unsupported",
        ));
    }
    let image = decoded.to_rgb8();
    let mut input = format!("{}x{}:RGB:", image.width(), image.height()).into_bytes();
    input.extend_from_slice(image.as_raw());
    Ok((sha256(&input), image.width(), image.height()))
}

pub fn install(conn: &Connection) -> LabResult<()> {
    let verified = Arc::new(Mutex::new(HashMap::<String, (String, u32, u32)>::new()));
    conn.create_scalar_function(
        "poker_verified_crop",
        5,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8,
        move |args| {
            let png = args.get::<Vec<u8>>(0)?;
            let expected = args.get::<String>(1)?;
            let width = args.get::<Option<u32>>(2)?;
            let height = args.get::<Option<u32>>(3)?;
            let encoded = args.get::<Option<String>>(4)?;
            let digest = sha256(&png);
            let fail =
                || rusqlite::Error::UserFunctionError("Missing or corrupt pixel asset".into());
            if encoded.as_ref().is_some_and(|value| value != &digest) {
                return Err(fail());
            }
            let mut cache = verified.lock().map_err(|_| fail())?;
            let actual = if let Some(value) = cache.get(&digest) {
                value.clone()
            } else {
                let value = identity(&png).map_err(|_| fail())?;
                if cache.len() >= 4096 {
                    cache.clear();
                }
                cache.insert(digest, value.clone());
                value
            };
            if actual.0 != expected
                || width.is_some_and(|w| w != actual.1)
                || height.is_some_and(|h| h != actual.2)
            {
                return Err(fail());
            }
            Ok(png)
        },
    )?;
    Ok(())
}

pub fn expression(conn: &Connection, alias: &str) -> LabResult<String> {
    assert!(alias.is_empty() || alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    let prefix = if alias.is_empty() {
        String::new()
    } else {
        format!("{alias}.")
    };
    Ok(if enabled(conn)? {
        format!("CASE WHEN {prefix}pixel_asset_sha IS NULL THEN poker_verified_crop({prefix}crop,{prefix}pixel_sha256,NULL,NULL,NULL) ELSE poker_verified_crop((SELECT a.png FROM pixel_assets a WHERE a.pixel_sha256={prefix}pixel_asset_sha AND a.pixel_sha256={prefix}pixel_sha256),{prefix}pixel_sha256,(SELECT a.width FROM pixel_assets a WHERE a.pixel_sha256={prefix}pixel_asset_sha),(SELECT a.height FROM pixel_assets a WHERE a.pixel_sha256={prefix}pixel_asset_sha),(SELECT a.png_sha256 FROM pixel_assets a WHERE a.pixel_sha256={prefix}pixel_asset_sha)) END")
    } else {
        format!("{prefix}crop")
    })
}

pub fn put(conn: &Connection, png: &[u8], expected: &str) -> LabResult<Option<String>> {
    if !enabled(conn)? {
        return Ok(None);
    }
    let (pixels, width, height) = identity(png)?;
    if pixels != expected {
        return Err(conflict("Crop identity does not match pixel asset"));
    }
    let old:Option<Vec<u8>>=conn.query_row("SELECT poker_verified_crop(png,pixel_sha256,width,height,png_sha256) FROM pixel_assets WHERE pixel_sha256=?",[&pixels],|r|r.get(0)).optional()?;
    if old.is_none() {
        conn.execute(
            "INSERT INTO pixel_assets(pixel_sha256,width,height,png_sha256,png) VALUES(?,?,?,?,?)",
            params![pixels, width, height, sha256(png), png],
        )?;
    }
    Ok(Some(pixels))
}

pub fn attach(
    conn: &Connection,
    table: &str,
    key: &str,
    png: &[u8],
    pixels: &str,
) -> LabResult<()> {
    assert!(["queue_items", "review_samples"].contains(&table));
    if !enabled(conn)? {
        return Ok(());
    }
    let stored: Option<String> = conn
        .query_row(
            &format!("SELECT pixel_sha256 FROM {table} WHERE sample_key=?"),
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if stored.as_deref() != Some(pixels) {
        return Err(conflict("Sample identity does not match pixel asset"));
    }
    if let Some(asset) = put(conn, png, pixels)? {
        conn.execute(
            &format!("UPDATE {table} SET pixel_asset_sha=?,crop=zeroblob(0) WHERE sample_key=?"),
            params![asset, key],
        )?;
    }
    Ok(())
}

pub fn migrate(conn: &Connection) -> LabResult<()> {
    install(conn)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS pixel_assets(pixel_sha256 TEXT PRIMARY KEY,width INTEGER NOT NULL CHECK(width>0),height INTEGER NOT NULL CHECK(height>0),png_sha256 TEXT NOT NULL,png BLOB NOT NULL);
CREATE TRIGGER IF NOT EXISTS pixel_assets_no_update BEFORE UPDATE ON pixel_assets BEGIN SELECT RAISE(ABORT,'Pixel assets are immutable'); END;
CREATE TRIGGER IF NOT EXISTS pixel_assets_no_delete BEFORE DELETE ON pixel_assets BEGIN SELECT RAISE(ABORT,'Pixel assets are immutable'); END;
CREATE TRIGGER IF NOT EXISTS pixel_assets_no_replace BEFORE INSERT ON pixel_assets WHEN EXISTS(SELECT 1 FROM pixel_assets WHERE pixel_sha256=NEW.pixel_sha256) BEGIN SELECT RAISE(ABORT,'Pixel assets are immutable'); END;")?;
    for table in ["queue_items", "review_samples"] {
        let columns = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns.iter().any(|c| c == "pixel_asset_sha") {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN pixel_asset_sha TEXT REFERENCES pixel_assets(pixel_sha256)"))?;
        }
        conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS {table}_unmigrated_pixels ON {table}(sample_key) WHERE pixel_asset_sha IS NULL"))?;
    }
    for table in ["queue_items", "review_samples"] {
        loop {
            let tx = conn.unchecked_transaction()?;
            let mut count = 0;
            for _ in 0..64 {
                let row:Option<(String,Vec<u8>,String)>=tx.query_row(&format!("SELECT sample_key,crop,pixel_sha256 FROM {table} WHERE pixel_asset_sha IS NULL LIMIT 1"),[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                let Some((key, png, pixels)) = row else { break };
                attach(&tx, table, &key, &png, &pixels)?;
                count += 1;
            }
            tx.commit()?;
            if count == 0 {
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, Vec<u8>, String) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE queue_items(sample_key TEXT PRIMARY KEY,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL);CREATE TABLE review_samples(sample_key TEXT PRIMARY KEY,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL);").unwrap();
        let png = crate::media::png(&image::DynamicImage::new_rgb8(5, 7)).unwrap();
        let pixels = identity(&png).unwrap().0;
        for key in ["a", "b"] {
            conn.execute(
                "INSERT INTO queue_items VALUES(?,?,?)",
                params![key, png, pixels],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO review_samples VALUES('human',?,?)",
            params![png, pixels],
        )
        .unwrap();
        (conn, png, pixels)
    }
    #[test]
    fn migration_stores_one_blob_preserves_semantic_rows_and_restarts_idempotently() {
        let (conn, png, _) = fixture();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT sum(length(crop)) FROM queue_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM queue_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        install(&conn).unwrap();
        let sql = format!(
            "SELECT {} FROM queue_items WHERE sample_key='b'",
            expression(&conn, "queue_items").unwrap()
        );
        assert_eq!(
            conn.query_row(&sql, [], |r| r.get::<_, Vec<u8>>(0))
                .unwrap(),
            png
        );
    }
    #[test]
    fn corrupt_missing_and_wrong_dimension_assets_fail_closed() {
        for change in [
            "UPDATE pixel_assets SET png=x'00'",
            "DELETE FROM pixel_assets",
            "UPDATE pixel_assets SET width=99",
        ] {
            let (conn, _, _) = fixture();
            migrate(&conn).unwrap();
            conn.execute_batch(
                "DROP TRIGGER pixel_assets_no_update;DROP TRIGGER pixel_assets_no_delete",
            )
            .unwrap();
            if change == "DELETE FROM pixel_assets" {
                assert!(conn.execute_batch(change).is_err());
                conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
            }
            conn.execute_batch(change).unwrap();
            let sql = format!(
                "SELECT {} FROM queue_items LIMIT 1",
                expression(&conn, "queue_items").unwrap()
            );
            assert!(conn
                .query_row(&sql, [], |r| r.get::<_, Vec<u8>>(0))
                .is_err());
        }
    }
    #[test]
    fn corrupt_inline_migration_rolls_back_current_batch_with_original_blob_intact() {
        let (conn, _, _) = fixture();
        conn.execute("UPDATE queue_items SET crop=x'00' WHERE sample_key='b'", [])
            .unwrap();
        assert!(migrate(&conn).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT length(crop) FROM queue_items WHERE sample_key='a'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                > 0,
            true
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn legacy_storage_is_unchanged_without_explicit_global_migration() {
        let (conn, png, pixels) = fixture();
        assert_eq!(
            expression(&conn, "queue_items").unwrap(),
            "queue_items.crop"
        );
        attach(&conn, "queue_items", "a", &png, &pixels).unwrap();
        assert!(!enabled(&conn).unwrap());
        assert_eq!(
            conn.query_row(
                "SELECT crop FROM queue_items WHERE sample_key='a'",
                [],
                |r| r.get::<_, Vec<u8>>(0)
            )
            .unwrap(),
            png
        );
    }

    #[test]
    fn same_decoded_pixels_share_asset_across_encodings_and_semantic_contexts() {
        use image::ImageEncoder;
        let (conn, png, pixels) = fixture();
        let mut alternative = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut alternative,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(&vec![0; 5 * 7 * 3], 5, 7, image::ExtendedColorType::Rgb8)
        .unwrap();
        assert_ne!(png, alternative);
        assert_eq!(identity(&alternative).unwrap().0, pixels);
        conn.execute("UPDATE review_samples SET crop=?", [&alternative])
            .unwrap();
        conn.execute_batch("ALTER TABLE review_samples ADD COLUMN image_sha256 TEXT;ALTER TABLE review_samples ADD COLUMN label TEXT;UPDATE review_samples SET label='Q';CREATE TABLE label_review_events(id INTEGER PRIMARY KEY,sample_key TEXT,label TEXT);INSERT INTO label_review_events VALUES(71,'human','Q');CREATE TABLE original_predictions(id TEXT PRIMARY KEY,payload TEXT);INSERT INTO original_predictions VALUES('original','{\"text\":\"K\"}');").unwrap();
        conn.execute(
            "UPDATE review_samples SET image_sha256=?",
            [sha256(&alternative)],
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT label,image_sha256 FROM review_samples", [], |r| Ok(
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?)
            ))
            .unwrap(),
            ("Q".into(), sha256(&alternative))
        );
        assert_eq!(
            conn.query_row(
                "SELECT id,sample_key,label FROM label_review_events",
                [],
                |r| Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?
                ))
            )
            .unwrap(),
            (71, "human".into(), "Q".into())
        );
        assert_eq!(
            conn.query_row(
                "SELECT payload FROM original_predictions WHERE id='original'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "{\"text\":\"K\"}"
        );
        assert!(conn
            .execute("UPDATE pixel_assets SET width=width", [])
            .is_err());
        assert!(conn.execute("DELETE FROM pixel_assets", []).is_err());
        assert!(conn.execute("INSERT OR REPLACE INTO pixel_assets SELECT pixel_sha256,width,height,png_sha256,png FROM pixel_assets", []).is_err());
        let resized = crate::media::png(&image::DynamicImage::new_rgb8(7, 5)).unwrap();
        assert_ne!(identity(&resized).unwrap().0, pixels);
        put(&conn, &resized, &identity(&resized).unwrap().0).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn migration_resumes_after_committed_batch_without_changing_prior_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ledger.sqlite3");
        let (fixture, png, pixels) = fixture();
        drop(fixture);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE queue_items(sample_key TEXT PRIMARY KEY,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL);CREATE TABLE review_samples(sample_key TEXT PRIMARY KEY,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL);").unwrap();
        for index in 0..65 {
            conn.execute(
                "INSERT INTO queue_items VALUES(?,?,?)",
                params![
                    format!("{index:03}"),
                    if index == 64 { &[0][..] } else { &png },
                    pixels
                ],
            )
            .unwrap();
        }
        assert!(migrate(&conn).is_err());
        assert_eq!(conn.query_row("SELECT count(*) FROM queue_items WHERE pixel_asset_sha IS NOT NULL AND length(crop)=0",[],|r|r.get::<_,i64>(0)).unwrap(),64);
        assert_eq!(
            conn.query_row(
                "SELECT crop FROM queue_items WHERE sample_key='064'",
                [],
                |r| r.get::<_, Vec<u8>>(0)
            )
            .unwrap(),
            vec![0]
        );
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE queue_items SET crop=? WHERE sample_key='064'",
            [&png],
        )
        .unwrap();
        migrate(&conn).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        install(&conn).unwrap();
        let sql = format!(
            "SELECT {} FROM queue_items WHERE sample_key='064'",
            expression(&conn, "queue_items").unwrap()
        );
        assert_eq!(
            conn.query_row(&sql, [], |r| r.get::<_, Vec<u8>>(0))
                .unwrap(),
            png
        );
        migrate(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM queue_items WHERE pixel_asset_sha IS NOT NULL AND length(crop)=0",[],|r|r.get::<_,i64>(0)).unwrap(),65);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn write_boundary_rejects_wrong_semantic_identity_without_changing_sample() {
        let (conn, png, pixels) = fixture();
        migrate(&conn).unwrap();
        let other = crate::media::png(&image::DynamicImage::new_rgb8(7, 5)).unwrap();
        let other_pixels = identity(&other).unwrap().0;
        assert!(attach(&conn, "queue_items", "a", &other, &other_pixels).is_err());
        assert!(attach(&conn, "queue_items", "missing", &png, &pixels).is_err());
        assert!(put(&conn, &other, &pixels).is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let sql = format!(
            "SELECT {} FROM queue_items WHERE sample_key='a'",
            expression(&conn, "queue_items").unwrap()
        );
        assert_eq!(
            conn.query_row(&sql, [], |r| r.get::<_, Vec<u8>>(0))
                .unwrap(),
            png
        );
        conn.execute(
            "UPDATE queue_items SET pixel_sha256=? WHERE sample_key='a'",
            [other_pixels],
        )
        .unwrap();
        assert!(conn
            .query_row(&sql, [], |r| r.get::<_, Option<Vec<u8>>>(0))
            .is_err());
    }

    #[test]
    fn transparent_and_near_opaque_alpha_cannot_alias_opaque_rgb_assets() {
        let (conn, png, pixels) = fixture();
        migrate(&conn).unwrap();
        for alpha in [0, 1, 254] {
            let rgba = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                5,
                7,
                image::Rgba([0, 0, 0, alpha]),
            ));
            let encoded = crate::media::png(&rgba).unwrap();
            assert!(identity(&encoded).is_err());
            assert!(put(&conn, &encoded, &pixels).is_err());
        }
        let opaque = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            5,
            7,
            image::Rgba([0, 0, 0, 255]),
        ));
        assert_eq!(
            identity(&crate::media::png(&opaque).unwrap()).unwrap().0,
            pixels
        );
        let near_opaque = image::DynamicImage::ImageLumaA16(image::ImageBuffer::from_pixel(
            5,
            7,
            image::LumaA([0, u16::MAX - 1]),
        ));
        assert!(identity(&crate::media::png(&near_opaque).unwrap()).is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(identity(&png).unwrap().0, pixels);
    }

    #[test]
    fn legacy_file_stays_byte_identical_across_shared_read_write_helpers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite3");
        let (fixture, png, pixels) = fixture();
        drop(fixture);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE queue_items(sample_key TEXT PRIMARY KEY,crop BLOB NOT NULL,pixel_sha256 TEXT NOT NULL);").unwrap();
        conn.execute(
            "INSERT INTO queue_items VALUES('a',?,?)",
            params![png, pixels],
        )
        .unwrap();
        drop(conn);
        let before = std::fs::read(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        install(&conn).unwrap();
        assert_eq!(
            expression(&conn, "queue_items").unwrap(),
            "queue_items.crop"
        );
        assert!(put(&conn, &png, &pixels).unwrap().is_none());
        attach(&conn, "queue_items", "a", &png, &pixels).unwrap();
        drop(conn);
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn global_bootstrap_recovers_partial_backfill_and_does_not_rewrite_migrated_ledger() {
        use crate::lab::gameplay::ai::GameplayAi;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("data");
        let config = directory.path().join("config");
        let global = GameplayAi::open(&root, config.clone()).unwrap();
        let png = crate::media::png(&image::DynamicImage::new_rgb8(5, 7)).unwrap();
        let pixels = identity(&png).unwrap().0;
        {
            let conn = global.context.connection().unwrap();
            assert!(enabled(&conn).unwrap());
            for index in 0..65 {
                conn.execute("INSERT INTO queue_items(sample_key,region_id,payload,crop,pixel_sha256,created_at) VALUES(?,'board.0.rank','{}',?,?,0)",params![format!("{index:03}"),if index==64{&[0][..]}else{&png},pixels]).unwrap();
            }
            assert!(migrate(&conn).is_err());
        }
        drop(global);
        assert!(GameplayAi::open(&root, config.clone()).is_err());
        let path = root.join("ocr-evidence.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM queue_items WHERE pixel_asset_sha IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                64
            );
            conn.execute(
                "UPDATE queue_items SET crop=? WHERE sample_key='064'",
                [&png],
            )
            .unwrap();
        }
        let global = GameplayAi::open(&root, config.clone()).unwrap();
        {
            let conn = global.context.connection().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM queue_items WHERE pixel_asset_sha IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                65
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM pixel_assets", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('ai_review_jobs','ai_review_attempts')",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        }
        drop(global);
        let before = std::fs::read(&path).unwrap();
        let global = GameplayAi::open(&root, config).unwrap();
        drop(global);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn global_consumers_reopen_and_preserve_conflicting_manual_events_without_provider_calls() {
        use crate::lab::{LabRequest, LabService};
        use serde_json::{json, Value};
        use std::{collections::BTreeMap, fs};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("data");
        let config = directory.path().join("config");
        let tools = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/poker");
        let service = LabService::open_with_paths(
            root.clone(),
            config.clone(),
            tools.clone(),
            Default::default(),
        )
        .unwrap();
        fs::write(config.join("gameplay-regions.json"),json!({"viewport":{"width":20,"height":20},"regions":[{"id":"board.0.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}},"bounds":{"x":2,"y":2,"width":6,"height":6}},{"id":"board.1.rank","presence":{"state":"present","target_support":"supported","card_evidence":{"target_support":"supported","policy":"source_card_plane_component_support_v1","boundary_contact":[false,false,false,false]}},"bounds":{"x":2,"y":2,"width":6,"height":6}}]}).to_string()).unwrap();
        let record = |service: &LabService| {
            let store = service.gameplay.evidence_store().unwrap();
            let settings = json!({"regions":{}});
            let session = store
                .create("fixture", 1000, "Fixture", &settings, "fixture")
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let mut image = image::RgbImage::from_pixel(20, 20, image::Rgb([20, 20, 20]));
            image.put_pixel(5, 5, image::Rgb([255, 255, 255]));
            let png = crate::media::png(&image::DynamicImage::ImageRgb8(image)).unwrap();
            for _ in 0..3 {
                store.admit(&session,&png,20,20,"2026-11-14T00:00:00Z",&settings,"fixture",&json!({"community_cards[0]":{"prediction":{"text":"K"}},"community_cards[1]":{"prediction":{"text":"K"}}}),"12345678",&json!({})).unwrap();
            }
            session
        };
        let route = |service: &LabService, method: &str, part: &str, body: Value| {
            let response = service.request(LabRequest {
                method: method.into(),
                path: format!("/api/gameplay/ai/{part}"),
                body,
                query: BTreeMap::new(),
                headers: BTreeMap::new(),
            });
            assert_eq!(response.status, 200, "{}", response.body);
            response
        };
        let first = record(&service);
        let prepared = route(&service, "POST", "prepare", json!({"session_id":first})).body;
        assert_eq!(prepared["scope"]["occurrences"], 6);
        let items:Vec<String>=service.gameplay_ai.context.connection().unwrap().prepare("SELECT id FROM gameplay_ai_occurrences WHERE region_id='board.0.rank' ORDER BY frame_id").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        route(
            &service,
            "POST",
            "review",
            json!({"occurrence_id":items[0],"expected_revision":0,"action":"manual","label":"Q"}),
        );
        route(
            &service,
            "POST",
            "review",
            json!({"occurrence_id":items[1],"expected_revision":1,"action":"manual","label":"J"}),
        );
        let (variant_key, variant_region, canonical_png): (String, String, Vec<u8>) = {
            let conn = service.gameplay_ai.context.connection().unwrap();
            assert!(enabled(&conn).unwrap());
            conn.query_row(
                &format!(
                    "SELECT sample_key,region_id,{} FROM review_samples LIMIT 1",
                    expression(&conn, "review_samples").unwrap()
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        };
        let rgb = crate::media::decode_image(&canonical_png)
            .unwrap()
            .to_rgb8();
        let mut alternative = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new_with_quality(
            &mut alternative,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
        assert_ne!(canonical_png, alternative);
        let historical = crate::lab::review::prediction(
            &service.gameplay_ai.context,
            &crate::lab::review::SampleInput {
                key: variant_key.clone(),
                region_id: variant_region,
                png: alternative.clone(),
                filename: None,
            },
            json!({"text":"J","raw_text":"J"}),
        )
        .unwrap();
        assert_eq!(historical["image_sha256"], sha256(&alternative));
        let snapshot = |conn: &Connection| {
            [
                "queue_items",
                "review_samples",
                "gameplay_ai_occurrences",
                "gameplay_ai_manual",
                "gameplay_ai_decisions",
                "label_review_events",
                "model_predictions",
                "gameplay_ai_runs",
                "gameplay_ai_run_items",
                "ai_review_jobs",
                "ai_review_attempts",
            ]
            .iter()
            .map(|table| {
                let columns: Vec<String> = conn
                    .prepare(&format!("PRAGMA table_info({table})"))
                    .unwrap()
                    .query_map([], |r| r.get::<_, String>(1))
                    .unwrap()
                    .collect::<Result<Vec<String>, _>>()
                    .unwrap()
                    .into_iter()
                    .filter(|c| c != "crop" && c != "pixel_asset_sha")
                    .collect();
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT {} FROM {table} ORDER BY rowid",
                        columns.join(",")
                    ))
                    .unwrap();
                statement
                    .query_map([], |row| {
                        Ok((0..columns.len())
                            .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                            .collect::<Vec<_>>())
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
            })
            .collect::<Vec<_>>()
        };
        let conn = service.gameplay_ai.context.connection().unwrap();
        let before = snapshot(&conn);
        migrate(&conn).unwrap();
        assert_eq!(snapshot(&conn), before);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT sum(length(crop)) FROM queue_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(conn);
        route(&service, "GET", &format!("crop/{}", items[0]), Value::Null);
        let keys = service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .prepare("SELECT sample_key FROM queue_items")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        service
            .ai_review
            .preview_grid(&service.gameplay_ai.context, &keys, true)
            .unwrap();
        {
            let conn = service.gameplay_ai.context.connection().unwrap();
            let key = keys.first().unwrap();
            assert!(crate::lab::queue::get_conn(&conn, Some(key), None, true)
                .unwrap()
                .is_none());
            conn.execute_batch("SAVEPOINT fixture_crop_readback")
                .unwrap();
            conn.execute("UPDATE queue_items SET active=1 WHERE sample_key=?", [key])
                .unwrap();
            let value = crate::lab::queue::get_conn(&conn, Some(&key), None, true)
                .unwrap()
                .unwrap();
            use base64::Engine;
            let png = base64::engine::general_purpose::STANDARD
                .decode(value["crop"].as_str().unwrap())
                .unwrap();
            assert_eq!(identity(&png).unwrap().0, value["pixel_sha256"]);
            conn.execute_batch("ROLLBACK TO fixture_crop_readback; RELEASE fixture_crop_readback")
                .unwrap();
            assert!(crate::lab::queue::get_conn(&conn, Some(key), None, true)
                .unwrap()
                .is_none());
        }
        drop(service);
        let service = LabService::open_with_paths(root, config, tools, Default::default()).unwrap();
        route(&service, "GET", &format!("crop/{}", items[0]), Value::Null);
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(snapshot(&conn), before);
        let states = conn
            .prepare("SELECT label,state FROM gameplay_ai_decisions ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(states.contains(&("Q".into(), "manual".into())));
        assert!(states.contains(&("J".into(), "manual".into())));
        drop(conn);
        let effective = crate::lab::review::sample_input(
            &service.gameplay_ai.context,
            &json!({"sample_key":variant_key}),
        )
        .unwrap();
        assert_eq!(effective.png, canonical_png);
        let current = crate::lab::review::prediction(
            &service.gameplay_ai.context,
            &effective,
            json!({"text":"J","raw_text":"J"}),
        )
        .unwrap();
        assert_eq!(current["image_sha256"], sha256(&canonical_png));
        let original_payload: String = service
            .gameplay_ai
            .context
            .connection()
            .unwrap()
            .query_row(
                "SELECT payload FROM model_predictions WHERE id=?",
                [historical["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&original_payload).unwrap()["image_sha256"],
            sha256(&alternative)
        );
        let second = record(&service);
        route(&service, "POST", "prepare", json!({"session_id":second}));
        let conn = service.gameplay_ai.context.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pixel_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ai_review_attempts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ai_review_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
