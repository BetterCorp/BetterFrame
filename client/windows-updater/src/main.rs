#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
mod platform;
#[cfg(windows)]
mod worker;
#[cfg(windows)]
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let result = match args.get(1).map(String::as_str) {
        Some("service") => platform::service(),
        Some("apply") => worker::apply(),
        Some("probe") => Ok(()),
        _ => Err("Updater is managed by the BetterFrame Windows service".into()),
    };
    if let Err(error) = result {
        platform::log(&error);
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {}
