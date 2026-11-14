//! Browser identity and navigation-safe progress for smart URL automation.
use crate::bundle::BundleCell;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use url::{Position, Url};

/// A browser belongs to one block on one display/layout. Its playback settings
/// are part of the identity, so editing/removing automation replaces the page.
/// Callers normalize encrypted values before computing this key.
pub fn web_cell_key(display_id: &str, layout_id: &str, cell: &BundleCell) -> String {
    let settings = serde_json::json!({
        "type": cell.content_type,
        "url": cell.web_url.as_deref().map(str::trim),
        "html": cell.html_content,
        "smart_url": cell.smart_url,
        "local_storage": cell.local_storage,
        "input_options": cell.input_options,
    });
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    settings.to_string().hash(&mut hash);
    // JSON encodes the scope without delimiter collisions. Geometry is only a
    // fallback for old bundles without view IDs; resizing a named block reuses it.
    let block = cell
        .view_id
        .clone()
        .unwrap_or_else(|| format!("{},{}", cell.row, cell.col));
    format!(
        "web:{}:{:x}",
        serde_json::json!([display_id, layout_id, block]),
        hash.finish()
    )
}

/// Match an absolute URL prefix, or a path prefix such as /auth. In particular,
/// an auth URL embedded in an unrelated page's query is not a login redirect.
pub fn login_url_matches(current_url: &str, prefix: &str) -> bool {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return false;
    }
    if prefix.starts_with('/') {
        return Url::parse(current_url)
            .is_ok_and(|url| url[Position::BeforePath..].starts_with(prefix));
    }
    current_url.starts_with(prefix)
}

/// Limit repeated attempts while an expired/failed page remains on login.
pub const AUTH_RETRY_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
pub struct SmartUrlProgress {
    next: usize,
    generation: u64,
    busy: bool,
    complete: bool,
    triggered: bool,
    failed: bool,
    retry_armed: bool,
    retry_after: Option<Duration>,
    cancelled: bool,
}

impl SmartUrlProgress {
    /// Invalidate the old document's callbacks while preserving the step cursor.
    pub fn load_started(&mut self) {
        // Progress lives outside the document. A redirect invalidates callbacks
        // from the old document, but never starts the sequence over.
        self.generation += 1;
        self.busy = false;
    }

    /// Start an eligible auth attempt only on a matching login URL.
    /// `now` is monotonic elapsed time from the same origin used for completion
    /// and failure. Active attempts stay intact; terminal attempts wait for the
    /// cooldown unless a settled authenticated page has armed a new login.
    pub fn observe_url(&mut self, current_url: &str, prefix: Option<&str>, now: Duration) {
        let at_login = prefix.is_some_and(|prefix| login_url_matches(current_url, prefix));
        let running = self.triggered && !self.complete && !self.failed;
        let retry_due = self.retry_after.is_some_and(|deadline| now >= deadline);
        if self.cancelled || running || !at_login {
            return;
        }
        if !self.triggered || self.retry_armed || retry_due {
            // Invalidate callbacks and confirmation timers from earlier attempts.
            self.generation += 1;
            self.triggered = true;
            self.retry_armed = false;
            self.retry_after = None;
            self.next = 0;
            self.complete = false;
            self.failed = false;
            self.busy = false;
        }
    }

    /// Only a settled page outside the login prefix can arm a later retry.
    /// A transient destination in the redirect chain cannot count as a login.
    pub fn confirm_authenticated(&mut self) {
        if self.is_complete() {
            self.retry_armed = true;
        }
    }

    /// Report successful completion only while the controller remains active.
    pub fn is_complete(&self) -> bool {
        self.complete && !self.failed && !self.cancelled
    }

    /// Identify the attempt/document generation used to reject stale callbacks.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Claim one step and its generation, preventing concurrent execution.
    /// Reaching the end marks completion and starts the cooldown at `now`.
    pub fn take_step(&mut self, count: usize, now: Duration) -> Option<(usize, u64)> {
        if self.cancelled || !self.triggered || self.busy || self.complete || self.failed {
            return None;
        }
        if self.next >= count {
            self.complete = true;
            self.retry_after = Some(now.saturating_add(AUTH_RETRY_DELAY));
            return None;
        }
        let index = self.next;
        self.next += 1;
        self.busy = true;
        Some((index, self.generation))
    }

    /// Accept a result only for the currently claimed generation.
    /// Failure ends the attempt and starts its cooldown at monotonic `now`.
    pub fn finish_step(&mut self, generation: u64, success: bool, now: Duration) -> bool {
        if generation != self.generation || !self.busy {
            return false;
        }
        self.busy = false;
        if !success {
            self.fail(now);
        }
        success
    }

    /// End a failed attempt and set its earliest retry time after the cooldown.
    pub fn fail(&mut self, now: Duration) {
        self.failed = true;
        self.busy = false;
        self.retry_after = Some(now.saturating_add(AUTH_RETRY_DELAY));
    }

    /// Disposal is permanent; periodic/visibility checks must never revive it.
    pub fn cancel(&mut self) {
        self.cancelled = true;
        self.busy = false;
        self.generation += 1;
    }

    /// Report permanent disposal so periodic polling can stop.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web_cell() -> BundleCell {
        serde_json::from_value(serde_json::json!({
            "view_id":"block", "entity_id":"ha", "row":0, "col":0,
            "row_span":1, "col_span":1, "content_type":"web",
            "web_url":"http://192.168.74.4:8123/lovelace/2",
            "smart_url":{"steps":[{"type":"navigate","url":"/lovelace/2"}]}
        }))
        .unwrap()
    }

    #[test]
    fn overlay_refresh_and_random_storage_order_preserve_browser_identity() {
        let mut cell = web_cell();
        cell.local_storage = Some([
            ("screenId".into(), "id".into()), ("screenToken".into(), "token".into()),
        ].into_iter().collect());
        let expected = web_cell_key("display", "layout", &cell);
        for _ in 0..64 {
            let mut refreshed = cell.clone();
            refreshed.overlay_html = Some("new overlay data".into());
            refreshed.local_storage = Some([
                ("screenToken".into(), "token".into()), ("screenId".into(), "id".into()),
            ].into_iter().collect());
            // settings is a serde_json::Value: object keys already serialize in
            // canonical order, independently of the input HashMap's seed.
            assert_eq!(expected, web_cell_key("display", "layout", &refreshed));
            refreshed.local_storage.as_mut().unwrap().insert("screenToken".into(), "changed".into());
            assert_ne!(expected, web_cell_key("display", "layout", &refreshed));
        }
    }

    #[test]
    fn login_detection_matches_prefixes_instead_of_substrings() {
        let root = "http://192.168.74.4:8123";
        assert!(login_url_matches(
            &format!("{root}/auth/authorize?client_id=unknown&state=123"),
            "/auth"
        ));
        assert!(login_url_matches(
            &format!("{root}/auth?state=456"),
            &format!("{root}/auth")
        ));
        assert!(!login_url_matches(
            &format!("{root}/lovelace?next=/auth"),
            "/auth"
        ));
        assert!(!login_url_matches(&format!("{root}/other/auth"), "/auth"));
        assert!(!login_url_matches(&format!("{root}/auth"), ""));
    }

    #[test]
    fn same_entity_has_independent_browsers_per_block_layout_and_display() {
        let cell = web_cell();
        let key = web_cell_key("display", "layout", &cell);
        assert_ne!(key, web_cell_key("second-display", "layout", &cell));
        assert_ne!(key, web_cell_key("display", "second-layout", &cell));
        let mut other = cell.clone();
        other.view_id = Some("second-block".into());
        assert_ne!(key, web_cell_key("display", "layout", &other));
        other = cell.clone();
        other.col_span = 2;
        assert_eq!(key, web_cell_key("display", "layout", &other));
    }

    #[test]
    fn changed_or_removed_block_settings_replace_browser() {
        let cell = web_cell();
        let key = web_cell_key("d", "l", &cell);
        let mut changed = cell.clone();
        changed.smart_url.as_mut().unwrap().steps[0].url = Some("/auth".into());
        assert_ne!(key, web_cell_key("d", "l", &changed));
        changed.smart_url = None;
        assert_ne!(key, web_cell_key("d", "l", &changed));
        changed = cell.clone();
        changed.local_storage = Some(std::collections::HashMap::from([(
            "token".into(),
            "new".into(),
        )]));
        assert_ne!(key, web_cell_key("d", "l", &changed));
    }

    #[test]
    fn authenticated_pages_and_missing_prefix_never_run_steps() {
        let mut run = SmartUrlProgress::default();
        assert_eq!(run.take_step(3, Duration::ZERO), None);
        run.observe_url("http://ha/lovelace/2", Some("/auth"), Duration::ZERO);
        assert_eq!(run.take_step(3, Duration::ZERO), None);
        run.observe_url("http://ha/auth", None, Duration::ZERO);
        assert_eq!(run.take_step(3, Duration::ZERO), None);
        run.observe_url("http://ha/auth?new=1", Some("/auth"), Duration::ZERO);
        assert_eq!(run.take_step(3, Duration::ZERO).unwrap().0, 0);
    }

    #[test]
    fn redirects_resume_and_ignore_callbacks_from_destroyed_documents() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth?initial=1", Some("/auth"), Duration::ZERO);
        let (index, generation) = run.take_step(3, Duration::ZERO).unwrap();
        assert_eq!(index, 0);
        run.load_started(); // navigate -> lovelace -> auth
        run.load_started();
        assert!(!run.finish_step(generation, true, Duration::ZERO));
        run.observe_url("http://ha/auth?state=123", Some("/auth"), Duration::ZERO);
        assert_eq!(run.take_step(3, Duration::ZERO).unwrap().0, 1);
    }

    /// Verify that transient redirect URLs cannot rearm a completed attempt.
    #[test]
    fn completed_sequence_does_not_restart_during_redirects() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth?initial=1", Some("/auth"), Duration::ZERO);
        let (_, generation) = run.take_step(1, Duration::ZERO).unwrap();
        run.load_started(); // final navigation redirects to auth
        run.observe_url("http://ha/auth?state=123", Some("/auth"), Duration::ZERO);
        assert!(!run.finish_step(generation, true, Duration::ZERO));
        assert_eq!(run.take_step(1, Duration::ZERO), None); // completes on redirected document
        for _ in 0..5 {
            run.observe_url("http://ha/auth?state=456", Some("/auth"), Duration::ZERO);
            assert_eq!(run.take_step(1, Duration::ZERO), None);
        }
        run.observe_url("http://ha/lovelace/2", Some("/auth"), Duration::ZERO);
        run.observe_url("http://ha/auth?transient=1", Some("/auth"), Duration::ZERO);
        assert_eq!(
            run.take_step(1, Duration::ZERO),
            None,
            "intermediate redirects cannot rearm authentication"
        );
        run.confirm_authenticated(); // native runner confirms a settled non-login page
        run.observe_url("http://ha/auth?state=789", Some("/auth"), Duration::ZERO);
        assert_eq!(run.take_step(1, Duration::ZERO).unwrap().0, 0);
    }

    #[test]
    fn failed_steps_stop_instead_of_running_later_actions() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth?initial=1", Some("/auth"), Duration::ZERO);
        let (_, generation) = run.take_step(3, Duration::ZERO).unwrap();
        assert!(!run.finish_step(generation, false, Duration::ZERO));
        assert_eq!(run.take_step(3, Duration::ZERO), None);
        run.load_started();
        assert_eq!(run.take_step(3, Duration::ZERO), None);
    }
    #[test]
    fn failed_auth_retries_after_cooldown_without_navigation() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth", Some("/auth"), Duration::ZERO);
        let (_, old_generation) = run.take_step(2, Duration::ZERO).unwrap();
        assert!(!run.finish_step(old_generation, false, Duration::from_secs(100)));
        run.observe_url(
            "http://ha/auth?state=changed",
            Some("/auth"),
            Duration::from_secs(129),
        );
        assert_eq!(run.take_step(2, Duration::from_secs(129)), None);
        // Backoff starts when the attempt fails, rather than when it started.
        run.observe_url("http://ha/auth", Some("/auth"), Duration::from_secs(130));
        let (index, generation) = run.take_step(2, Duration::from_secs(130)).unwrap();
        assert_eq!(index, 0);
        assert_ne!(generation, old_generation);
        assert!(!run.finish_step(old_generation, true, Duration::from_secs(130)));
        // Polls never replace an active sequence, even after a long wait.
        run.observe_url("http://ha/auth", Some("/auth"), Duration::from_secs(1000));
        assert_eq!(run.take_step(2, Duration::from_secs(1000)), None);
        assert!(run.finish_step(generation, true, Duration::from_secs(1000)));
        assert_eq!(run.take_step(2, Duration::from_secs(1000)).unwrap().0, 1);
    }

    #[test]
    fn sticky_auth_retries_after_completion_but_other_urls_do_not() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth", Some("/auth"), Duration::ZERO);
        let (_, generation) = run.take_step(1, Duration::ZERO).unwrap();
        assert!(run.finish_step(generation, true, Duration::ZERO));
        assert_eq!(run.take_step(1, Duration::from_secs(100)), None);
        run.observe_url("http://ha/auth", Some("/auth"), Duration::from_secs(129));
        assert_eq!(run.take_step(1, Duration::from_secs(129)), None);
        run.observe_url(
            "http://ha/lovelace?next=/auth",
            Some("/auth"),
            Duration::from_secs(130),
        );
        assert_eq!(run.take_step(1, Duration::from_secs(130)), None);
        run.observe_url("http://ha/auth", Some("/auth"), Duration::from_secs(130));
        assert_eq!(run.take_step(1, Duration::from_secs(130)).unwrap().0, 0);
    }

    #[test]
    fn disposed_auth_controllers_can_never_be_restarted_by_a_recheck() {
        let mut run = SmartUrlProgress::default();
        run.observe_url("http://ha/auth", Some("/auth"), Duration::ZERO);
        let (_, generation) = run.take_step(1, Duration::ZERO).unwrap();
        run.cancel();
        run.observe_url("http://ha/auth", Some("/auth"), Duration::from_secs(1000));
        run.load_started();
        assert!(!run.finish_step(generation, true, Duration::from_secs(1000)));
        assert_eq!(run.take_step(1, Duration::from_secs(1000)), None);
        assert!(run.is_cancelled());
    }
}
