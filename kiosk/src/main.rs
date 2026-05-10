mod server;
mod bundle;
mod pipeline;
mod ui;

use gtk4::prelude::ApplicationExtManual;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("betterframe_kiosk=info".parse().unwrap()))
        .init();

    gstreamer::init().expect("Failed to init GStreamer");
    let app = ui::build_app();
    std::process::exit(app.run().into());
}
