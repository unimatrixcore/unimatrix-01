mod source;
pub use source::{plan, Plan, SourceSpec};

pub use super::gameplay::store::import::{
    ImportBatch, ImportCollection, ImportEvidence, ImportFrame, ImportLabel, ImportSession,
};

pub fn apply(plan: &Plan, destination: &std::path::Path) -> Result<serde_json::Value, String> {
    if plan.version != 2 || plan.batch.collection.kind != "legacy_benchmark" {
        return Err("Unsupported legacy migration plan version or collection kind".into());
    }
    let destination = std::fs::canonicalize(destination).map_err(|e| e.to_string())?;
    if plan
        .sources
        .iter()
        .any(|s| destination.starts_with(&s.directory) || s.directory.starts_with(&destination))
    {
        return Err("Migration source and destination directories must not overlap".into());
    }
    for source in &plan.sources {
        source.assert_unchanged()?;
    }
    for frame in &plan.batch.frames {
        let path = std::fs::canonicalize(&frame.source_path).map_err(|e| e.to_string())?;
        if !plan
            .sources
            .iter()
            .any(|source| path.starts_with(source.directory.join("full_captures")))
        {
            return Err("Planned frame is outside its read-only source capture directory".into());
        }
    }
    for label in plan.batch.frames.iter().flat_map(|frame| &frame.labels) {
        let path = std::fs::canonicalize(&label.source_path).map_err(|e| e.to_string())?;
        if !plan.sources.iter().any(|source| {
            if label.encoded_png.is_some() {
                path == source.directory.join("data.db")
            } else {
                path.starts_with(source.directory.join("images"))
            }
        }) {
            return Err("Planned annotation is outside its source dataset".into());
        }
        if label.provenance["policy"] != source::LABEL_POLICY {
            return Err("Unsupported legacy annotation trust policy".into());
        }
    }
    let store = super::gameplay::store::Store::for_import(destination)?;
    let result = store.import_legacy_checked(&plan.batch, || {
        for source in &plan.sources {
            source.assert_unchanged()?;
        }
        Ok(())
    })?;
    for source in &plan.sources {
        source.assert_unchanged()?;
    }
    Ok(result)
}
