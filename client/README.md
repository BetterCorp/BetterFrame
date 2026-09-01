# BetterFrame client

One Rust client produces the Linux kiosk and Windows desktop artifacts.

```text
core/src/                platform-free bundle, command, layout, protocol, and state logic
src/platform/linux/      GTK/WebKitGTK, Linux host controls, GPIO, and RAUC
src/platform/windows/    Win32/WebView2 renderer, Windows host policy, and DPAPI storage
src/main.rs              target selection and process bootstrap
```

The Linux release is built from this directory and renamed
`betterframe-kiosk` for the existing systemd/image contract. The Windows MSI
installs the same package as `betterframe-windows-client.exe`.

```bash
cargo test --manifest-path core/Cargo.toml
cargo build --release
```

Windows source builds require the GStreamer MSVC SDK. After installation, run
`betterframe-windows-client.exe self-test` to verify DPAPI, protected state,
GStreamer/D3D11, WebView2, and display enumeration.
