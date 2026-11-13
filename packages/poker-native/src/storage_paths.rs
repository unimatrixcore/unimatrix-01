//! Shared storage policy for the assistant and Poker Lab. Source assets remain
//! immutable; user data never depends on the current working directory.
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

/// Resolve one XDG base, ignoring relative variables as required by XDG.
/// Taking an environment map keeps hot-reloaded Lab workers and tests isolated.
pub fn directory(environment: &HashMap<String, String>, kind: &str) -> PathBuf {
    let variable = format!("XDG_{}_HOME", kind.to_uppercase());
    let base = environment
        .get(&variable)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let home = || {
        environment
            .get("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .filter(|p| p.is_absolute())
            .expect("HOME must identify an absolute directory when XDG homes are unset")
    };
    base.unwrap_or_else(|| {
        home().join(match kind {
            "config" => ".config",
            "cache" => ".cache",
            "state" => ".local/state",
            _ => ".local/share",
        })
    })
    .join("poker")
}

/// Read the process environment at use time, rather than baking in build paths.
pub fn data_dir() -> PathBuf {
    directory(&std::env::vars().collect(), "data")
}
pub fn config_dir() -> PathBuf {
    directory(&std::env::vars().collect(), "config")
}

/// Keep transient capture files private and remove them with the runtime session.
#[cfg(unix)]
pub fn runtime_dir(environment: &HashMap<String, String>) -> Result<PathBuf, String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    // getuid has no arguments and returns the current process's real user ID.
    let uid = unsafe { getuid() };
    let path = environment
        .get("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("poker"))
        .unwrap_or_else(|| std::env::temp_dir().join(format!("poker-{uid}")));
    ensure_directory(&path).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != uid {
        return Err(format!(
            "Unsafe Poker runtime directory: {}",
            path.display()
        ));
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Seed a configuration file once; edits then belong to the user's XDG config.
pub fn config_string(name: &str, defaults: &str) -> Result<String, String> {
    let path = config_dir().join(name);
    seed_file(&path, defaults.as_bytes())?;
    fs::read_to_string(path).map_err(|e| format!("Cannot read {name}: {e}"))
}

/// Create private app directories without changing permissions on existing parents.
pub fn ensure_directory(path: &Path) -> Result<(), std::io::Error> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Create a missing file exclusively so another process's existing data wins.
pub fn seed_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    ensure_directory(path.parent().ok_or("Missing storage parent")?).map_err(|e| e.to_string())?;
    if path.exists() {
        return Ok(());
    }
    // Publish a fully written inode atomically, without replacing a concurrent writer.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seeds_publish_complete_files_without_overwriting_existing_data() {
        let directory =
            std::env::temp_dir().join(format!("poker-seed-test-{}", std::process::id()));
        let path = directory.join("model.bin");
        let _ = fs::remove_dir_all(&directory);
        let first = path.clone();
        let second = path.clone();
        let a = std::thread::spawn(move || seed_file(&first, &vec![1; 1024 * 1024]).unwrap());
        let b = std::thread::spawn(move || seed_file(&second, &vec![2; 1024 * 1024]).unwrap());
        a.join().unwrap();
        b.join().unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 1024 * 1024);
        assert!(bytes.iter().all(|b| *b == bytes[0]));
        seed_file(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn xdg_overrides_and_relative_values() {
        let mut env = HashMap::from([("HOME".into(), "/home/test".into())]);
        assert_eq!(
            directory(&env, "data"),
            PathBuf::from("/home/test/.local/share/poker")
        );
        assert_eq!(
            directory(&env, "state"),
            PathBuf::from("/home/test/.local/state/poker")
        );
        env.insert("XDG_DATA_HOME".into(), "relative".into());
        assert_eq!(
            directory(&env, "data"),
            PathBuf::from("/home/test/.local/share/poker")
        );
        env.insert("XDG_DATA_HOME".into(), "/custom".into());
        assert_eq!(directory(&env, "data"), PathBuf::from("/custom/poker"));
        env.remove("HOME");
        assert_eq!(directory(&env, "data"), PathBuf::from("/custom/poker"));
    }
}
