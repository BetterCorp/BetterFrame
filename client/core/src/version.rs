use semver::Version;

fn parse(value: &str) -> Option<Version> {
    Version::parse(value.trim().strip_prefix('v').unwrap_or(value.trim())).ok()
}

/// Unknown installed versions retain legacy behavior; known versions only move forward.
pub fn is_version_upgrade(candidate: &str, installed: &str) -> bool {
    let Some(candidate_version) = parse(candidate) else {
        return false;
    };
    match parse(installed) {
        Some(installed_version) => candidate_version > installed_version,
        None => candidate.trim() != installed.trim(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_version_upgrade;

    #[test]
    fn known_versions_only_move_forward() {
        assert!(!is_version_upgrade("0.0.315", "0.0.316-dev.2ecd44b"));
        assert!(!is_version_upgrade(
            "0.0.316-dev.2ecd44b",
            "0.0.316-dev.2ecd44b"
        ));
        assert!(!is_version_upgrade("0.0.316-dev.2ecd44b", "0.0.316"));
        assert!(is_version_upgrade("0.0.316", "0.0.316-dev.2ecd44b"));
        assert!(is_version_upgrade("0.0.317-dev.1", "0.0.316"));
    }
}
