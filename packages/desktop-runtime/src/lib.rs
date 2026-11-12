use rusqlite::Connection;
use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct AppDirectories {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub state: PathBuf,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub fn validate_identifier(id: &str) -> io::Result<()> {
    let parts: Vec<_> = id.split('.').collect();
    if parts.len() < 2
        || !parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                && part.as_bytes()[0].is_ascii_alphabetic()
        })
    {
        return Err(invalid(
            "application identifier must contain safe reverse-DNS segments",
        ));
    }
    Ok(())
}

pub fn validate_basename(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(invalid("expected a single safe basename"));
    }
    Ok(())
}

impl AppDirectories {
    pub fn discover(identifier: &str) -> io::Result<Self> {
        Self::from_environment(identifier, |key| std::env::var_os(key))
    }

    pub fn from_environment(
        identifier: &str,
        env: impl Fn(&str) -> Option<OsString>,
    ) -> io::Result<Self> {
        validate_identifier(identifier)?;
        let home = env("HOME").map(PathBuf::from).filter(|p| p.is_absolute());
        let resolve = |name, fallback: &str| {
            let base = env(name).map(PathBuf::from).filter(|p| p.is_absolute());
            let base = match base {
                Some(base) => base,
                None => home
                    .as_ref()
                    .ok_or_else(|| invalid("HOME must be absolute when an XDG fallback is needed"))?
                    .join(fallback),
            };
            Ok::<_, io::Error>(base.join(identifier))
        };
        Ok(Self {
            config: resolve("XDG_CONFIG_HOME", ".config")?,
            data: resolve("XDG_DATA_HOME", ".local/share")?,
            cache: resolve("XDG_CACHE_HOME", ".cache")?,
            state: resolve("XDG_STATE_HOME", ".local/state")?,
        })
    }

    pub fn create(&self) -> io::Result<()> {
        for directory in [&self.config, &self.data, &self.cache, &self.state] {
            std::fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    pub fn database_path(&self, name: &str) -> io::Result<PathBuf> {
        validate_basename(name)?;
        Ok(self.data.join(name))
    }
}

pub fn open_database(path: &Path, migrations: &[&str]) -> rusqlite::Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 0 || version > migrations.len() as i64 {
        return Err(rusqlite::Error::InvalidParameterName(
            "database schema is newer than this application".into(),
        ));
    }
    for (index, migration) in migrations.iter().enumerate().skip(version as usize) {
        transaction.execute_batch(migration)?;
        transaction.pragma_update(None, "user_version", (index + 1) as i64)?;
    }
    transaction.commit()?;
    Ok(connection)
}

/// Call first in main, before Tauri or GTK creates threads. Re-exec avoids mutating a live process environment.
pub fn require_native_wayland() -> io::Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(invalid(
            "desktop applications require Linux with native Wayland",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        if std::env::var_os("WAYLAND_DISPLAY").is_none_or(|v| v.is_empty()) {
            return Err(invalid("a native Wayland session is required"));
        }
        if std::env::var_os("GDK_BACKEND").as_deref() != Some(std::ffi::OsStr::new("wayland")) {
            return Err(std::process::Command::new(std::env::current_exe()?)
                .args(std::env::args_os().skip(1))
                .env("GDK_BACKEND", "wayland")
                .exec());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xdg_paths_and_validation() {
        let dirs = AppDirectories::from_environment("dev.unimatrix.test", |key| match key {
            "HOME" => Some("/home/test".into()),
            "XDG_DATA_HOME" => Some("/data".into()),
            "XDG_CACHE_HOME" => Some("relative".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(dirs.data, PathBuf::from("/data/dev.unimatrix.test"));
        assert_eq!(
            dirs.cache,
            PathBuf::from("/home/test/.cache/dev.unimatrix.test")
        );
        assert_eq!(
            dirs.state,
            PathBuf::from("/home/test/.local/state/dev.unimatrix.test")
        );
        for name in ["../db", "/db", ".", "..", "a/b", "a\\b", ""] {
            assert!(dirs.database_path(name).is_err());
        }
        for id in ["../bad", "dev..bad", "bad", "dev.1bad"] {
            assert!(validate_identifier(id).is_err());
        }
        assert!(AppDirectories::from_environment("dev.test", |_| None).is_err());
        let explicit = AppDirectories::from_environment("dev.test", |key| {
            (key != "HOME").then(|| OsString::from("/explicit"))
        })
        .unwrap();
        assert_eq!(explicit.data, PathBuf::from("/explicit/dev.test"));
    }
    #[test]
    fn creates_separate_directories() {
        let root = tempfile::tempdir().unwrap();
        let dirs = AppDirectories::from_environment("dev.test", |key| {
            (key == "HOME").then(|| root.path().as_os_str().into())
        })
        .unwrap();
        dirs.create().unwrap();
        assert!(dirs.data.is_dir());
        assert!(dirs.config.is_dir());
        assert!(dirs.cache.is_dir());
        assert!(dirs.state.is_dir());
        assert_ne!(dirs.data, dirs.config);
        assert_ne!(dirs.cache, dirs.state);
    }
    #[test]
    fn migrations_persist_rollback_and_reject_newer_schemas() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.sqlite");
        let migration =
            "CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('saved');";
        drop(open_database(&path, &[migration]).unwrap());
        let conn = open_database(&path, &[migration]).unwrap();
        assert_eq!(
            conn.query_row("SELECT value FROM records", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "saved"
        );
        assert_eq!(
            conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);
        assert!(open_database(
            &path,
            &[
                migration,
                "CREATE TABLE rollback_me (id INTEGER); INVALID SQL;"
            ]
        )
        .is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(conn.prepare("SELECT * FROM rollback_me").is_err());
        assert!(open_database(&path, &[]).is_err());
        conn.pragma_update(None, "user_version", -1).unwrap();
        assert!(open_database(&path, &[migration]).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn wayland_startup_child() {
        if std::env::var_os("UNIMATRIX_WAYLAND_PROBE").is_some() {
            require_native_wayland().unwrap();
            assert_eq!(std::env::var("GDK_BACKEND").unwrap(), "wayland");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wayland_startup_policy() {
        let probe = || {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "tests::wayland_startup_child"])
                .env("UNIMATRIX_WAYLAND_PROBE", "1");
            command
        };
        let absent = probe().env_remove("WAYLAND_DISPLAY").output().unwrap();
        assert!(!absent.status.success());
        let reexecuted = probe()
            .env("WAYLAND_DISPLAY", "wayland-test")
            .env("GDK_BACKEND", "x11")
            .output()
            .unwrap();
        assert!(
            reexecuted.status.success(),
            "{}",
            String::from_utf8_lossy(&reexecuted.stdout)
        );
    }
}
