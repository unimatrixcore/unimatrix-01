use crate::lab::{bad, unavailable, uuid, LabResult};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const MAX_BYTES: u64 = 16_384;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub model: String,
}

pub(super) struct CredentialStore {
    directory: PathBuf,
}

impl CredentialStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn parent(&self, create: bool) -> LabResult<()> {
        if !self.directory.is_absolute()
            || self
                .directory
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(bad(
                "AI review settings require an absolute configuration directory",
            ));
        }
        for parent in self.directory.ancestors() {
            match fs::symlink_metadata(parent) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(unavailable(
                        "AI review configuration directories must not be symbolic links",
                    ))
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(unavailable(
                        "Cannot access the AI review configuration directory",
                    ))
                }
            }
        }
        if create {
            crate::storage_paths::ensure_directory(&self.directory).map_err(|_| {
                unavailable("Cannot create the private AI review configuration directory")
            })?;
        }
        #[cfg(unix)]
        if let Ok(metadata) = fs::symlink_metadata(&self.directory) {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(unavailable(
                    "AI review configuration directory must belong to the current user",
                ));
            }
        }
        Ok(())
    }

    fn file(path: &Path) -> LabResult<()> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| unavailable("Cannot access saved AI review settings"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(unavailable(
                "Saved AI review settings must be a regular private file",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o777 != 0o600
            {
                return Err(unavailable("Saved AI review settings must belong to the current user with permissions 0600"));
            }
        }
        Ok(())
    }

    pub fn load(&self) -> LabResult<Option<SavedSettings>> {
        self.parent(false)?;
        let path = self.directory.join("ai-review.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable("Cannot access saved AI review settings")),
            Ok(_) => Self::file(&path)?,
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(&path)
            .map_err(|_| unavailable("Cannot open saved AI review settings"))?;
        let mut raw = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| unavailable("Cannot read saved AI review settings"))?;
        if raw.len() as u64 > MAX_BYTES {
            return Err(unavailable(
                "Saved AI review settings exceed their size limit; save the settings again",
            ));
        }
        serde_json::from_slice(&raw).map(Some).map_err(|_| {
            unavailable(
                "Saved AI review settings are invalid; enter the API key and save settings again",
            )
        })
    }

    pub fn save(&self, settings: &SavedSettings) -> LabResult<()> {
        self.parent(true)?;
        let path = self.directory.join("ai-review.json");
        if fs::symlink_metadata(&path).is_ok() {
            Self::file(&path)?;
        }
        let temporary = self.directory.join(format!(".ai-review-{}.tmp", uuid()));
        let result = (|| -> LabResult<()> {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|_| unavailable("Cannot create a private AI review settings file"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|_| unavailable("Cannot protect the AI review settings file"))?;
            }
            let raw = serde_json::to_vec(settings)
                .map_err(|_| unavailable("Cannot encode AI review settings"))?;
            file.write_all(&raw)
                .and_then(|_| file.sync_all())
                .map_err(|_| unavailable("Cannot save AI review settings"))?;
            self.parent(false)?;
            fs::rename(&temporary, &path)
                .map_err(|_| unavailable("Cannot replace saved AI review settings"))?;
            if let Ok(directory) = File::open(&self.directory) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
