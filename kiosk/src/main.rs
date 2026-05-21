mod bundle;
mod cec;
mod firmware;
mod gpio;
mod hwmon;
mod local_server;
mod pipeline;
mod server;
mod ui;
mod ws_client;

pub use ui::WorkerMsg;

pub enum ServerMsg {
    ReloadBundle,
    Standby(Option<u32>),
    Wake(Option<u32>),
    /// Some(0..=255) = manual PWM. None = restore auto.
    Fan(Option<u32>),
    /// Switch to a specific layout by ID, optionally scoped to one display.
    SwitchLayout {
        display_id: Option<u32>,
        layout_id: u32,
    },
    /// Server-pushed "go check for a firmware update now".
    FirmwareCheck,
}

use gstreamer::prelude::PluginFeatureExtManual;
use gtk4::prelude::{ApplicationExt, ApplicationExtManual};
use tracing::info;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("betterframe_kiosk=info".parse().unwrap()),
        )
        .init();

    gstreamer::init().expect("Failed to init GStreamer");

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
