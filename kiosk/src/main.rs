mod at_rest;
mod audio;
mod axiom;
mod bundle;
mod cec;
mod firmware;
mod gpio;
mod hwmon;
mod local_server;
mod onvif_actions;
mod onvif_events;
mod os_update;
mod pipeline;
mod remote_debug;
mod server;
#[cfg(target_os = "linux")]
mod tailscale;
mod ui;
mod update_guard;
mod ws_client;

pub use ui::WorkerMsg;

pub enum ServerMsg {
    ReloadBundle,
    Standby(Option<String>),
    Wake(Option<String>),
    /// Switch to a specific layout by ID, optionally scoped to one display.
    SwitchLayout {
        display_id: Option<String>,
        layout_id: String,
    },
    /// Audio controls from admin.
    VolumeSet(u32),
    VolumeMute(bool),
    AudioOutputSet(String),
    Reboot,
    TailscaleAuth(String),
    /// Server-pushed "go check for a firmware update now".
    FirmwareCheck {
        force: bool,
    },
    /// Server-pushed "go check for an OS update now".
    OsCheck {
        force: bool,
    },
    /// Server-pushed update preference change; cancel any in-flight updater.
    CancelUpdates,
    /// Show terminal auth code on screen (overlay).
    ShowTerminalCode(String),
    /// Dismiss the terminal code overlay.
    DismissTerminalCode,
}

use gstreamer::prelude::PluginFeatureExtManual;
use gtk4::prelude::{ApplicationExt, ApplicationExtManual};
use tracing::info;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    let env_filter =
        EnvFilter::from_default_env().add_directive("betterframe_kiosk=info".parse().unwrap());

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer());

    if let Some(axiom_layer) = axiom::AxiomLayer::new() {
        info!("axiom logging enabled");
        registry.with(axiom_layer).init();
    } else {
        registry.init();
    }

    gstreamer::init().expect("Failed to init GStreamer");
    gstgtk4::plugin_register_static().expect("Failed to register gtk4paintablesink");

    // Demote Pi5 hw H265 decoder — rejects non-standard resolutions like 960x1080
    if let Some(factory) = gstreamer::ElementFactory::find("v4l2slh265dec") {
        factory.set_rank(gstreamer::Rank::NONE);
        info!("demoted v4l2slh265dec to NONE (sw fallback)");
    }
    let app = ui::build_app();
    // Pass empty args to GTK — server URL handled via env or argv directly
    app.set_flags(gtk4::gio::ApplicationFlags::NON_UNIQUE);
    std::process::exit(app.run_with_args::<&str>(&[]).into());
}
