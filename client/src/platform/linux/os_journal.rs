//! Durable evidence of an OS attempt, independent of the replaceable root slot.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Downloading,
    Installing,
    PendingReboot,
    Failed,
    RolledBack,
    Confirmed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Journal {
    pub version: String,
    pub release_id: String,
    pub boot_id: String,
    pub stage: Stage,
    pub error: Option<String>,
}

impl Journal {
    /// Reconcile only after a boot change, never infer rollback from a heartbeat
    /// sent by the old OS while installation is in progress.
    pub fn reconcile(&mut self, boot_id: &str, running: &str, healthy: bool) {
        if self.boot_id == boot_id {
            return;
        }
        if matches!(
            self.stage,
            Stage::Installing | Stage::PendingReboot | Stage::Confirmed
        ) {
            if self.version == running {
                self.stage = if healthy {
                    Stage::Confirmed
                } else {
                    Stage::PendingReboot
                };
                self.error = None;
            } else {
                self.stage = Stage::RolledBack;
                self.error = Some(format!(
                    "Update {} was interrupted or rolled back; running OS {running}. Retry from BetterFrame.",
                    self.version
                ));
            }
        }
    }
    pub fn blocks_apply(&self) -> bool {
        matches!(
            self.stage,
            Stage::Installing | Stage::PendingReboot | Stage::RolledBack
        )
    }
}

pub fn read(path: &Path) -> Result<Option<Journal>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("Invalid OS update record: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Read OS update record: {e}")),
    }
}

pub fn write(path: &Path, journal: &Journal) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing journal directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attempt(stage: Stage) -> Journal {
        Journal {
            version: "1.0.0".into(),
            release_id: "release".into(),
            boot_id: "old".into(),
            stage,
            error: None,
        }
    }
    #[test]
    fn old_heartbeat_is_not_rollback() {
        let mut j = attempt(Stage::PendingReboot);
        j.reconcile("old", "0.318", true);
        assert_eq!(j.stage, Stage::PendingReboot);
        assert!(j.blocks_apply());
    }
    #[test]
    fn reboot_into_old_slot_preserves_failed_target() {
        let mut j = attempt(Stage::PendingReboot);
        j.reconcile("new", "0.318", true);
        assert_eq!(j.stage, Stage::RolledBack);
        assert_eq!(j.version, "1.0.0");
        assert!(j.blocks_apply());
    }
    #[test]
    fn new_slot_requires_health_confirmation() {
        let mut j = attempt(Stage::Installing);
        j.reconcile("new", "1.0.0", false);
        assert_eq!(j.stage, Stage::PendingReboot);
        assert!(j.blocks_apply());
    }
    #[test]
    fn interrupted_download_can_resume() {
        let mut j = attempt(Stage::Downloading);
        j.reconcile("new", "0.318", true);
        assert!(!j.blocks_apply());
    }
    #[test]
    fn unpaired_healthy_boot_unblocks_future_updates() {
        let mut j = attempt(Stage::PendingReboot);
        j.reconcile("new", "1.0.0", true);
        assert_eq!(j.stage, Stage::Confirmed);
        assert!(!j.blocks_apply());
    }
    #[test]
    fn previously_confirmed_version_cannot_hide_later_fallback() {
        let mut j = attempt(Stage::Confirmed);
        j.reconcile("new", "0.318", true);
        assert_eq!(j.stage, Stage::RolledBack);
        assert_eq!(j.version, "1.0.0");
    }
    #[test]
    fn durable_record_roundtrip_and_corruption() {
        let dir = std::env::temp_dir().join(format!("bf-os-journal-{}", std::process::id()));
        let path = dir.join("attempt.json");
        write(&path, &attempt(Stage::Installing)).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().stage, Stage::Installing);
        fs::write(&path, "broken").unwrap();
        assert!(read(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
