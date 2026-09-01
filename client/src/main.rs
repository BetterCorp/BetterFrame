pub use betterframe_client_core as core;
pub use core::bundle;

#[cfg(target_os = "linux")]
#[path = "platform/linux/at_rest.rs"]
mod at_rest;
#[cfg(target_os = "linux")]
#[path = "platform/linux/audio.rs"]
mod audio;
#[cfg(target_os = "linux")]
#[path = "platform/linux/axiom.rs"]
mod axiom;
#[cfg(target_os = "linux")]
#[path = "platform/linux/cec.rs"]
mod cec;
#[cfg(target_os = "linux")]
#[path = "platform/linux/firmware.rs"]
mod firmware;
#[cfg(target_os = "linux")]
#[path = "platform/linux/gpio.rs"]
mod gpio;
#[cfg(target_os = "linux")]
#[path = "platform/linux/hwmon.rs"]
mod hwmon;
#[cfg(target_os = "linux")]
#[path = "platform/linux/local_server.rs"]
mod local_server;
#[cfg(target_os = "linux")]
#[path = "platform/linux/onvif_actions.rs"]
mod onvif_actions;
#[cfg(target_os = "linux")]
#[path = "platform/linux/onvif_events.rs"]
mod onvif_events;
#[cfg(target_os = "linux")]
#[path = "platform/linux/operator_console.rs"]
mod operator_console;
#[cfg(target_os = "linux")]
#[path = "platform/linux/os_update.rs"]
mod os_update;
#[cfg(target_os = "linux")]
#[path = "platform/linux/pipeline.rs"]
mod pipeline;
#[cfg(target_os = "linux")]
#[path = "platform/linux/remote_debug.rs"]
mod remote_debug;
#[cfg(target_os = "linux")]
#[path = "platform/linux/server.rs"]
mod server;
#[cfg(target_os = "linux")]
#[path = "platform/linux/tailscale.rs"]
mod tailscale;
#[cfg(target_os = "linux")]
#[path = "platform/linux/ui.rs"]
mod ui;
#[cfg(target_os = "linux")]
#[path = "platform/linux/update_guard.rs"]
mod update_guard;
#[cfg(target_os = "linux")]
#[path = "platform/linux/ws_client.rs"]
mod ws_client;

#[cfg(target_os = "windows")]
#[path = "platform/windows/mod.rs"]
mod windows;

#[cfg(target_os = "linux")]
pub use ui::WorkerMsg;

#[cfg(target_os = "linux")]
pub use core::commands::ServerCommand as ServerMsg;

#[cfg(target_os = "linux")]
fn main() {
    use gstreamer::prelude::PluginFeatureExtManual;
    use gtk4::prelude::{ApplicationExt, ApplicationExtManual};
    use tracing::info;
    use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

    let env_filter =
        EnvFilter::from_default_env().add_directive("betterframe_client=info".parse().unwrap());
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

    // Demote Pi5 hw H265 decoder — rejects non-standard resolutions like 960x1080.
    if let Some(factory) = gstreamer::ElementFactory::find("v4l2slh265dec") {
        factory.set_rank(gstreamer::Rank::NONE);
        info!("demoted v4l2slh265dec to NONE (sw fallback)");
    }
    let app = ui::build_app();
    // Server URL is handled through the environment or parsed directly.
    app.set_flags(gtk4::gio::ApplicationFlags::NON_UNIQUE);
    std::process::exit(app.run_with_args::<&str>(&[]).into());
}

#[cfg(target_os = "windows")]
fn main() {
    windows::run();
}
