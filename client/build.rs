fn main() {
    #[cfg(target_os = "windows")]
    winresource::WindowsResource::new()
        .set_icon("wix/betterframe.ico")
        .compile()
        .expect("embed BetterFrame Windows icon");
}
