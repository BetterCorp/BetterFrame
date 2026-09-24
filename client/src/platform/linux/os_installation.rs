use std::path::Path;

// These files are provisioned by both full OS image builders. Neither an
// environment override nor an unrelated RAUC installation makes an app install
// eligible to replace the host OS.
pub fn updates_enabled(root: &Path, setting: Option<&str>) -> bool {
    setting != Some("0")
        && root.join("etc/rauc/system.conf").is_file()
        && [
            "etc/betterframe/os-version",
            "etc/betterframe/os-compatibility",
        ]
        .iter()
        .all(|file| {
            std::fs::read_to_string(root.join(file))
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_image_marker_is_required() {
        let root = std::env::temp_dir().join(format!("bf-os-marker-matrix-{}", std::process::id()));
        let files = [
            "etc/rauc/system.conf",
            "etc/betterframe/os-version",
            "etc/betterframe/os-compatibility",
        ];
        for mask in 0..8 {
            for (index, file) in files.iter().enumerate() {
                let path = root.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                if mask & (1 << index) != 0 {
                    std::fs::write(path, "present").unwrap();
                } else if path.exists() {
                    std::fs::remove_file(path).unwrap();
                }
            }
            for setting in [None, Some("1"), Some("0")] {
                assert_eq!(
                    updates_enabled(&root, setting),
                    mask == 7 && setting != Some("0")
                );
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_full_os_installations_can_update_the_os() {
        let root = std::env::temp_dir().join(format!("bf-os-installation-{}", std::process::id()));
        std::fs::create_dir_all(root.join("etc/rauc")).unwrap();
        std::fs::create_dir_all(root.join("etc/betterframe")).unwrap();
        assert!(!updates_enabled(&root, None));
        assert!(!updates_enabled(&root, Some("1")));
        std::fs::write(root.join("etc/rauc/system.conf"), "[system]\n").unwrap();
        assert!(!updates_enabled(&root, Some("1")));
        std::fs::write(root.join("etc/betterframe/os-version"), "1.0.22\n").unwrap();
        assert!(!updates_enabled(&root, None));
        let compatibility = root.join("etc/betterframe/os-compatibility");
        std::fs::write(&compatibility, " \n").unwrap();
        assert!(!updates_enabled(&root, None));
        for platform in ["betterframe-rpi5-aarch64", "betterframe-x86_64-generic"] {
            std::fs::write(&compatibility, platform).unwrap();
            assert!(updates_enabled(&root, None));
            assert!(updates_enabled(&root, Some("1")));
            assert!(!updates_enabled(&root, Some("0")));
        }
        std::fs::remove_file(root.join("etc/rauc/system.conf")).unwrap();
        assert!(!updates_enabled(&root, Some("1")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
