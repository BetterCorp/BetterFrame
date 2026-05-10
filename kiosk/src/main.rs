mod server;
mod bundle;
mod pipeline;
mod ui;

use gtk4::prelude::{ApplicationExt, ApplicationExtManual};
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("betterframe_kiosk=info".parse().unwrap()))
        .init();

    gstreamer::init().expect("Failed to init GStreamer");
    let app = ui::build_app();
    // Pass empty args to GTK — server URL handled via env or argv directly
    app.set_flags(gtk4::gio::ApplicationFlags::NON_UNIQUE | gtk4::gio::ApplicationFlags::HANDLES_COMMAND_LINE);
    std::process::exit(app.run_with_args::<&str>(&[]).into());
}
