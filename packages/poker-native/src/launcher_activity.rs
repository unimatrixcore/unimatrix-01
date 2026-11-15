use crate::lab::{bad, LabResult};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActivityRole {
    Preparation,
    Review,
}
impl ActivityRole {
    fn name(self) -> &'static str {
        match self {
            Self::Preparation => "preparation",
            Self::Review => "review",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Claim {
    node: PathBuf,
    launcher: PathBuf,
    git: PathBuf,
    role: ActivityRole,
}
static CLAIMS: OnceLock<Mutex<BTreeMap<Claim, usize>>> = OnceLock::new();
pub struct ActivityLease {
    claim: Option<Claim>,
}
impl ActivityLease {
    pub fn acquire(role: ActivityRole) -> LabResult<Self> {
        let values = [
            "POKER_LAB_LAUNCHER_NODE",
            "POKER_LAB_LAUNCHER_PATH",
            "POKER_LAB_GIT_DIR",
        ]
        .map(std::env::var_os);
        if values.iter().all(Option::is_none) {
            return Ok(Self { claim: None });
        }
        let [Some(node), Some(launcher), Some(git)] = values else {
            return Err(bad("Launcher activity protection is partially configured"));
        };
        let claim = Claim {
            node: node.into(),
            launcher: launcher.into(),
            git: git.into(),
            role,
        };
        if [&claim.node, &claim.launcher, &claim.git]
            .iter()
            .any(|p| !p.is_absolute())
        {
            return Err(bad("Launcher activity paths must be absolute"));
        }
        Self::claim(claim)
    }
    fn claim(claim: Claim) -> LabResult<Self> {
        let mut claims = CLAIMS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| bad("Launcher activity lock poisoned"))?;
        if claims.get(&claim).copied().unwrap_or(0) == 0 {
            set(&claim, true)?;
        }
        *claims.entry(claim.clone()).or_insert(0) += 1;
        Ok(Self { claim: Some(claim) })
    }
}
fn set(claim: &Claim, active: bool) -> LabResult<()> {
    let mut child = Command::new(&claim.node)
        .arg(&claim.launcher)
        .arg("--git-dir")
        .arg(&claim.git)
        .args([
            "--recording",
            &std::process::id().to_string(),
            claim.role.name(),
            if active { "on" } else { "off" },
        ])
        .env("POKER_LAB_GIT_DIR", &claim.git)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| bad("Cannot update launcher activity protection"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(bad("Cannot observe launcher activity acknowledgement"));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(bad("Launcher activity acknowledgement timed out"));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let result = child
        .wait_with_output()
        .map_err(|_| bad("Cannot read launcher activity acknowledgement"))?;
    if !result.status.success() {
        return Err(bad("Launcher rejected activity protection"));
    }
    let reply: serde_json::Value = serde_json::from_slice(&result.stdout)
        .map_err(|_| bad("Invalid launcher activity acknowledgement"))?;
    if reply["ok"] != true {
        return Err(bad("Launcher did not acknowledge activity protection"));
    }
    Ok(())
}
impl Drop for ActivityLease {
    fn drop(&mut self) {
        let Some(claim) = self.claim.take() else {
            return;
        };
        let Ok(mut claims) = CLAIMS.get_or_init(Default::default).lock() else {
            return;
        };
        let Some(count) = claims.get_mut(&claim) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            if set(&claim, false).is_ok() {
                claims.remove(&claim);
            } else {
                eprintln!("Launcher activity protection could not be released; launcher state is unconfirmed");
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_activity_covers_handoff_and_releases_only_after_last_owner() {
        let root = std::env::temp_dir().join(format!("poker-activity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("launcher.sh");
        let log = root.join("launcher.sh.calls");
        std::fs::write(
            &script,
            r#"printf '%s\n' "$*" >> "$0.calls"
printf '{"ok":true}'
"#,
        )
        .unwrap();
        let claim = Claim {
            node: "/bin/sh".into(),
            launcher: script,
            git: root.clone(),
            role: ActivityRole::Review,
        };
        let a = ActivityLease::claim(claim.clone()).unwrap();
        let b = ActivityLease::claim(claim).unwrap();
        drop(a);
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1);
        drop(b);
        let lines = std::fs::read_to_string(&log).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(lines
            .lines()
            .all(|line| line.starts_with(&format!("--git-dir {} --recording ", root.display()))));
        assert!(lines.lines().next().unwrap().ends_with("review on"));
        assert!(lines.lines().last().unwrap().ends_with("review off"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn acquisition_reasserts_protection_after_a_failed_final_release() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("launcher.sh");
        let fail = script.with_extension("sh.fail");
        let log = script.with_extension("sh.calls");
        std::fs::write(
            &script,
            r#"printf '%s\n' "$*" >> "$0.calls"
case "$*" in *'review off') if test -e "$0.fail"; then printf '{"ok":false}'; exit 0; fi;; esac
printf '{"ok":true}'
"#,
        )
        .unwrap();
        let claim = Claim {
            node: "/bin/sh".into(),
            launcher: script,
            git: root.path().into(),
            role: ActivityRole::Review,
        };
        let lease = ActivityLease::claim(claim.clone()).unwrap();
        std::fs::write(&fail, b"fail").unwrap();
        drop(lease);
        assert_eq!(CLAIMS.get().unwrap().lock().unwrap().get(&claim), Some(&0));
        std::fs::remove_file(fail).unwrap();
        let lease = ActivityLease::claim(claim.clone()).unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(calls.lines().count(), 3);
        assert!(calls.lines().last().unwrap().ends_with("review on"));
        drop(lease);
        assert_eq!(std::fs::read_to_string(log).unwrap().lines().count(), 4);
        assert_eq!(CLAIMS.get().unwrap().lock().unwrap().get(&claim), None);
    }

    #[test]
    fn rejected_acquisition_does_not_leave_a_claim() {
        let claim = Claim {
            node: "/bin/false".into(),
            launcher: "/unused".into(),
            git: "/tmp".into(),
            role: ActivityRole::Preparation,
        };
        assert!(ActivityLease::claim(claim.clone()).is_err());
        assert_eq!(CLAIMS.get().unwrap().lock().unwrap().get(&claim), None);
    }
}
