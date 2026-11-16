use crate::bundle::WebPermissions;
use gtk4::{glib, prelude::*};
use std::{cell::{Cell, RefCell}, rc::Rc, time::{Duration, Instant}};
use webkit6::prelude::*;

pub(super) fn create(config: &WebPermissions, ephemeral: bool) -> webkit6::WebView {
    let policy = webkit6::WebsitePolicies::builder().autoplay(if config.autoplay {
        webkit6::AutoplayPolicy::Allow
    } else { webkit6::AutoplayPolicy::Deny }).build();
    let builder = webkit6::WebView::builder().website_policies(&policy);
    let view = if ephemeral {
        builder.network_session(&webkit6::NetworkSession::new_ephemeral()).build()
    } else { builder.build() };
    if let Some(settings) = view.settings() {
        settings.set_enable_media(true);
        settings.set_enable_media_stream(true);
        settings.set_media_playback_requires_user_gesture(!config.autoplay);
        settings.set_media_playback_allows_inline(true);
        settings.set_enable_fullscreen(false);
        settings.set_javascript_can_open_windows_automatically(true);
    }
    view
}

fn origin(uri: &str) -> Option<String> {
    url::Url::parse(uri).ok().filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.origin().ascii_serialization())
}

pub(super) fn install(view: &webkit6::WebView, config: WebPermissions, source: Option<&str>, server: &str, key: &str) {
    let expected = source.and_then(|uri| url::Url::parse(uri).or_else(|_| url::Url::parse(server)?.join(uri)).ok())
        .and_then(|uri| origin(uri.as_str()));
    let html = source.is_none();
    view.set_is_muted(true);
    let sound = config.audio;
    view.connect_map(move |view| view.set_is_muted(!sound));
    view.connect_unmap(|view| view.set_is_muted(true));
    view.connect_permission_request(move |view, request| {
        let current = view.uri();
        let trusted = expected.as_ref().is_some_and(|expected| current.as_deref().and_then(origin).as_ref() == Some(expected))
            || (html && current.as_deref() == Some("about:blank"));
        let (kind, allowed) = if let Some(media) = request.downcast_ref::<webkit6::UserMediaPermissionRequest>() {
            let audio = media.is_for_audio_device();
            let video = media.is_for_video_device();
            let display = webkit6::user_media_permission_is_for_display_device(media);
            ("media capture", !display && (audio || video) && (!audio || config.microphone) && (!video || config.camera))
        } else if request.is::<webkit6::GeolocationPermissionRequest>() { ("location", config.location) }
        else if request.is::<webkit6::NotificationPermissionRequest>() { ("notifications", config.notifications) }
        else if request.is::<webkit6::ClipboardPermissionRequest>() { ("clipboard", config.clipboard) }
        else if request.is::<webkit6::DeviceInfoPermissionRequest>() { ("media devices", config.device_info) }
        else if request.is::<webkit6::MediaKeySystemPermissionRequest>() { ("protected media", config.protected_media) }
        else if request.is::<webkit6::WebsiteDataAccessPermissionRequest>() { ("cross-site storage", config.cross_site_storage) }
        else if request.is::<webkit6::PointerLockPermissionRequest>() { ("pointer lock", config.pointer_lock) }
        else { ("unsupported", false) };
        let allowed = trusted && allowed;
        tracing::info!("web permission {kind}: allowed={allowed}, trusted_origin={trusted}");
        if allowed { request.allow(); } else { request.deny(); }
        true
    });
    view.connect_enter_fullscreen(|_| true);
    view.connect_script_dialog(|_, dialog| {
        match dialog.dialog_type() {
            webkit6::ScriptDialogType::Confirm => dialog.confirm_set_confirmed(false),
            webkit6::ScriptDialogType::BeforeUnloadConfirm => dialog.confirm_set_confirmed(true),
            _ => {}
        }
        // Returning handled without retaining the dialog closes it immediately.
        true
    });
    view.connect_authenticate(|_, request| { request.cancel(); true });
    view.connect_context_menu(|_, _, _| true);
    view.connect_print(|_, _| true);
    view.connect_run_color_chooser(|_, request| { request.finish(); true });
    view.connect_run_file_chooser(|_, request| { request.cancel(); true });
    view.connect_show_notification(|_, notification| { notification.close(); true });
    let server = server.to_string();
    let key = key.to_string();
    view.connect_decide_policy(move |view, decision, kind| {
        if kind != webkit6::PolicyDecisionType::NewWindowAction { return false; }
        let uri = decision.downcast_ref::<webkit6::NavigationPolicyDecision>()
            .and_then(|decision| decision.navigation_action()).and_then(|mut action| action.request())
            .and_then(|request| request.uri());
        decision.ignore();
        if let Some(uri) = uri {
            let weak = view.downgrade();
            let server = server.clone();
            let key = key.clone();
            glib::idle_add_local_once(move || {
                if let Some(view) = weak.upgrade() { super::load_webview_url(&view, &uri, &server, &key); }
            });
        }
        true
    });
    install_recovery(view);
}

fn install_recovery(view: &webkit6::WebView) {
    struct Recovery { pending: Cell<bool>, failed: Cell<bool>, attempts: RefCell<Vec<Instant>> }
    let recovery = Rc::new(Recovery { pending: Cell::new(false), failed: Cell::new(false), attempts: RefCell::new(Vec::new()) });
    let state = recovery.clone();
    view.connect_load_changed(move |_, event| match event {
        webkit6::LoadEvent::Started => state.failed.set(false),
        webkit6::LoadEvent::Finished if !state.failed.get() => state.pending.set(false),
        _ => {}
    });
    let state = recovery.clone();
    view.connect_load_failed(move |_, _, _, error| {
        if !error.matches(webkit6::NetworkError::Cancelled) {
            state.failed.set(true); state.pending.set(true);
            tracing::warn!("web page load failed (network {:?}, domain {:?}); recovery pending", error.kind::<webkit6::NetworkError>(), error.domain());
        }
        false
    });
    let state = recovery.clone();
    view.connect_web_process_terminated(move |_, reason| {
        state.failed.set(true); state.pending.set(true);
        tracing::warn!("web process terminated ({reason:?}); recovery pending");
    });
    let weak = view.downgrade();
    // Recover only visible blocks, with at most three reloads in five minutes.
    glib::timeout_add_local(Duration::from_secs(2), move || {
        let Some(view) = weak.upgrade() else { return glib::ControlFlow::Break };
        if recovery.pending.get() && view.is_mapped() && !view.is_loading() {
            let now = Instant::now();
            let mut attempts = recovery.attempts.borrow_mut();
            attempts.retain(|at| now.duration_since(*at) < Duration::from_secs(300));
            if attempts.len() < 3 {
                attempts.push(now); recovery.pending.set(false);
                tracing::info!("reloading visible web page after failure");
                view.reload();
            }
        }
        glib::ControlFlow::Continue
    });
}
