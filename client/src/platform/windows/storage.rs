use super::*;

pub(super) fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find_map(|pair| {
        if pair[0] == name {
            Some(pair[1].clone())
        } else {
            None
        }
    })
}

pub(super) fn state_dir() -> PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("BetterFrame")
        .join("WindowsClient")
}

pub(super) fn webview_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("BetterFrame")
        .join("WindowsClient")
        .join("WebView2")
}

pub(super) fn state_path() -> PathBuf {
    state_dir().join("state.json")
}

pub(super) fn bundle_path() -> PathBuf {
    state_dir().join("bundle.json")
}

pub(super) fn policy_path() -> PathBuf {
    state_dir().join("windows-policy.json")
}

pub(super) fn display_report_path() -> PathBuf {
    state_dir().join("displays.json")
}

pub(super) fn ensure_secure_state_dir() -> Result<(), String> {
    let path = state_dir();
    fs::create_dir_all(&path).map_err(|error| format!("create state directory: {error}"))?;
    let current_user_sid = current_user_sid()?;
    let sddl = wide(&format!(
        "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{current_user_sid})"
    ));
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(format!(
            "create state directory security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl = null_mut();
    let dacl_result = unsafe {
        GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    };
    if dacl_result == 0 || dacl_present == 0 {
        unsafe { LocalFree(descriptor as _) };
        return Err(format!(
            "read state directory security descriptor: {}",
            std::io::Error::last_os_error()
        ));
    }

    let path = wide_path(path.as_os_str());
    let status = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null_mut(),
        )
    };
    unsafe { LocalFree(descriptor as _) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "secure state directory: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    Ok(())
}

pub(super) fn load_state() -> ClientState {
    ensure_secure_state_dir()
        .and_then(|()| load_state_file(&state_path()))
        .ok()
        .unwrap_or_else(|| ClientState {
            server_url: DEFAULT_SERVER_URL.to_string(),
            ..ClientState::default()
        })
}

fn load_state_file(path: &std::path::Path) -> Result<ClientState, String> {
    let bytes = fs::read(path).map_err(|error| format!("read state: {error}"))?;
    let was_protected = bytes.starts_with(PROTECTED_MAGIC);
    let plaintext = if was_protected {
        unprotect_machine(&bytes[PROTECTED_MAGIC.len()..])?
    } else {
        bytes
    };
    let state = serde_json::from_slice(&plaintext)
        .map_err(|error| format!("deserialize state: {error}"))?;
    if !was_protected {
        write_protected(path, &plaintext)?;
    }
    Ok(state)
}

pub(super) fn save_state(state: &ClientState) -> Result<(), String> {
    write_protected(&state_path(), &serde_json::to_vec(state).unwrap())
}

pub(super) fn load_bundle() -> Option<KioskBundle> {
    ensure_secure_state_dir()
        .and_then(|()| read_protected_or_plain(&bundle_path()))
        .ok()
        .and_then(|bytes| deserialize_cached_bundle(&bytes))
}

pub(super) fn save_bundle(bundle: &KioskBundle) -> Result<(), String> {
    write_protected(&bundle_path(), &serde_json::to_vec(bundle).unwrap())
}

pub(super) fn load_renderer_displays() -> Option<Vec<DisplayReport>> {
    let path = display_report_path();
    let age = fs::metadata(&path).ok()?.modified().ok()?.elapsed().ok()?;
    if age > Duration::from_secs(15) {
        return None;
    }
    read_protected_or_plain(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub(super) fn save_renderer_displays(displays: &[DisplayReport]) -> Result<(), String> {
    write_protected(
        &display_report_path(),
        &serde_json::to_vec(displays).unwrap(),
    )
}

pub(super) fn remove_cached_bundle() -> Result<(), String> {
    match fs::remove_file(bundle_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove cached bundle: {error}")),
    }
}

pub(super) fn protect_machine(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len().try_into().map_err(|_| "state too large")?,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptProtectData failed".to_string());
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    let mut result = Vec::with_capacity(PROTECTED_MAGIC.len() + protected.len());
    result.extend_from_slice(PROTECTED_MAGIC);
    result.extend_from_slice(&protected);
    Ok(result)
}

pub(super) fn unprotect_machine(protected: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len().try_into().map_err(|_| "state too large")?,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok =
        unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("CryptUnprotectData failed".to_string());
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(plaintext)
}

pub(super) fn read_protected_or_plain(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|error| format!("read state: {error}"))?;
    if bytes.starts_with(PROTECTED_MAGIC) {
        unprotect_machine(&bytes[PROTECTED_MAGIC.len()..])
    } else {
        Ok(bytes)
    }
}

pub(super) fn read_protected(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|error| format!("read protected state: {error}"))?;
    if !bytes.starts_with(PROTECTED_MAGIC) {
        return Err("state file is not DPAPI protected".to_string());
    }
    unprotect_machine(&bytes[PROTECTED_MAGIC.len()..])
}

pub(super) fn write_protected(path: &std::path::Path, plaintext: &[u8]) -> Result<(), String> {
    ensure_secure_state_dir()?;
    let bytes = protect_machine(plaintext)?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|error| format!("write protected state: {error}"))?;
    let from = wide_path(temporary.as_os_str());
    let to = wide_path(path.as_os_str());
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "commit protected state: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn current_user_sid() -> Result<String, String> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "open process token: {}",
            std::io::Error::last_os_error()
        ));
    }

    let result = (|| {
        let mut length = 0;
        unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length) };
        if length == 0 {
            return Err(format!(
                "size process token user: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut buffer = vec![0u8; length as usize];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(format!(
                "read process token user: {}",
                std::io::Error::last_os_error()
            ));
        }

        let token_user = unsafe { (buffer.as_ptr() as *const TOKEN_USER).read_unaligned() };
        let mut sid = null_mut();
        if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid) } == 0 {
            return Err(format!(
                "format process token user SID: {}",
                std::io::Error::last_os_error()
            ));
        }
        let sid_length = (0..)
            .take_while(|&index| unsafe { *sid.add(index) } != 0)
            .count();
        let value =
            String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid, sid_length) });
        unsafe { LocalFree(sid as _) };
        Ok(value)
    })();

    unsafe { CloseHandle(token) };
    result
}

pub(super) fn wide_path(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

pub(super) fn ensure_default_policy() -> Result<(), String> {
    ensure_secure_state_dir()?;
    if policy_path().exists() {
        return Ok(());
    }
    fs::write(
        policy_path(),
        serde_json::to_vec_pretty(&WindowsPolicy::default()).unwrap(),
    )
    .map_err(|e| format!("write default policy: {e}"))
}

pub(super) fn load_policy() -> WindowsPolicy {
    ensure_secure_state_dir()
        .and_then(|()| fs::read_to_string(policy_path()).map_err(|error| error.to_string()))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(super) fn apply_pending_config(pending: &PendingConfig) -> Result<(), String> {
    let Some(policy_value) = pending.config.get("windows_policy") else {
        return Ok(());
    };
    let policy: WindowsPolicy = serde_json::from_value(policy_value.clone())
        .map_err(|e| format!("parse windows_policy: {e}"))?;
    ensure_secure_state_dir()?;
    fs::write(policy_path(), serde_json::to_vec_pretty(&policy).unwrap())
        .map_err(|e| format!("write windows policy: {e}"))?;
    Ok(())
}

pub(super) fn flexible_id(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

pub(super) fn flexible_id_ref(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

pub(super) fn loword(value: usize) -> u16 {
    (value & 0xffff) as u16
}

pub(super) fn hiword(value: usize) -> u16 {
    ((value >> 16) & 0xffff) as u16
}

pub(super) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(super) fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub(super) fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

#[derive(Deserialize)]
struct LegacyWindowsBundle {
    kiosk_id: String,
    kiosk_name: String,
    displays: Vec<LegacyWindowsDisplay>,
    #[serde(default)]
    cameras: Vec<LegacyWindowsCamera>,
    version: String,
}

#[derive(Deserialize)]
struct LegacyWindowsDisplay {
    id: String,
    name: String,
    default_layout_id: Option<String>,
    layouts: Vec<LegacyWindowsLayout>,
}

#[derive(Deserialize)]
struct LegacyWindowsLayout {
    id: String,
    name: String,
    grid_cols: u32,
    grid_rows: u32,
    cells: Vec<LegacyWindowsCell>,
}

#[derive(Deserialize)]
struct LegacyWindowsCell {
    view_id: Option<String>,
    entity_id: Option<String>,
    row: u32,
    col: u32,
    row_span: u32,
    col_span: u32,
    content_type: String,
    camera_id: Option<String>,
    stream_selector: Option<String>,
    web_url: Option<String>,
    html_content: Option<String>,
    #[serde(default)]
    local_storage: Option<HashMap<String, String>>,
    #[serde(default)]
    input_options: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct LegacyWindowsCamera {
    id: String,
    name: String,
    #[serde(default)]
    playback_username: Option<String>,
    #[serde(default)]
    playback_password_encrypted: Option<String>,
    #[serde(default)]
    streams: Vec<LegacyWindowsStream>,
}

#[derive(Deserialize)]
struct LegacyWindowsStream {
    role: String,
    rtsp_uri: String,
}

fn deserialize_cached_bundle(bytes: &[u8]) -> Option<KioskBundle> {
    serde_json::from_slice(bytes).ok().or_else(|| {
        serde_json::from_slice::<LegacyWindowsBundle>(bytes)
            .ok()
            .map(migrate_legacy_bundle)
    })
}

fn migrate_legacy_bundle(legacy: LegacyWindowsBundle) -> KioskBundle {
    let displays = legacy
        .displays
        .into_iter()
        .map(|display| {
            let default_layout_id = display.default_layout_id;
            let layouts = display
                .layouts
                .into_iter()
                .map(|layout| crate::bundle::BundleLayout {
                    is_default: default_layout_id.as_deref() == Some(layout.id.as_str()),
                    id: layout.id,
                    name: layout.name,
                    grid_cols: layout.grid_cols,
                    grid_rows: layout.grid_rows,
                    priority: "normal".to_string(),
                    cooling_timeout_seconds: None,
                    idle_timeout_seconds: None,
                    preload_camera_ids: Vec::new(),
                    resets_idle_timer: true,
                    input_options: None,
                    cells: layout
                        .cells
                        .into_iter()
                        .map(|cell| crate::bundle::BundleCell {
                            view_id: cell.view_id,
                            entity_id: cell.entity_id,
                            row: cell.row,
                            col: cell.col,
                            row_span: cell.row_span,
                            col_span: cell.col_span,
                            content_type: cell.content_type,
                            camera_id: cell.camera_id,
                            stream_selector: cell.stream_selector,
                            web_url: cell.web_url,
                            html_content: cell.html_content,
                            cooling_timeout_seconds: None,
                            fit: "cover".to_string(),
                            smart_url: None,
                            local_storage: cell.local_storage,
                            input_options: cell.input_options,
                        })
                        .collect(),
                })
                .collect();
            crate::bundle::BundleDisplayWithLayouts {
                id: display.id,
                name: display.name,
                width_px: 0,
                height_px: 0,
                idle_timeout_seconds: 0,
                sleep_timeout_seconds: 0,
                default_layout_id,
                layouts,
            }
        })
        .collect();
    let cameras = legacy
        .cameras
        .into_iter()
        .map(|camera| {
            let streams: Vec<_> = camera
                .streams
                .into_iter()
                .enumerate()
                .map(|(index, stream)| crate::bundle::BundleStream {
                    id: format!("legacy-{}-{index}", camera.id),
                    name: stream.role.clone(),
                    role: stream.role,
                    profile_token: None,
                    rtsp_uri: stream.rtsp_uri,
                    width: None,
                    height: None,
                    encoding: None,
                    framerate: None,
                })
                .collect();
            crate::bundle::BundleCamera {
                id: camera.id,
                device_id: None,
                device_name: None,
                name: camera.name,
                camera_number: None,
                labels: Vec::new(),
                capabilities: Vec::new(),
                enabled: true,
                last_seen_at: None,
                simple_vms_managed: false,
                recording_config: serde_json::Value::Null,
                cam_type: "rtsp".to_string(),
                rtsp_url: streams.first().map(|stream| stream.rtsp_uri.clone()),
                stream_policy: "auto".to_string(),
                streams,
                playback_username: camera.playback_username,
                playback_password_encrypted: camera.playback_password_encrypted,
                onvif_host: None,
                onvif_port: None,
                onvif_username: None,
                onvif_password_encrypted: None,
                event_source: None,
                event_sink: None,
                event_callback_token: None,
            }
        })
        .collect();
    KioskBundle {
        kiosk_id: legacy.kiosk_id,
        kiosk_name: legacy.kiosk_name,
        tenant_slug: "default".to_string(),
        display: None,
        layouts: Vec::new(),
        displays,
        cameras,
        gpio_bindings: Vec::new(),
        operator_console: crate::bundle::OperatorConsoleConfig::default(),
        version: legacy.version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_previous_windows_bundle_cache() {
        let bundle = deserialize_cached_bundle(
            br#"{
                "kiosk_id":"1","kiosk_name":"Lobby","version":"7",
                "displays":[{"id":"2","name":"Primary","default_layout_id":"3","layouts":[{
                    "id":"3","name":"Default","grid_cols":1,"grid_rows":1,
                    "cells":[{"view_id":"4","entity_id":null,"row":0,"col":0,
                        "row_span":1,"col_span":1,"content_type":"camera","camera_id":"5",
                        "stream_selector":"main","web_url":null,"html_content":null}]
                }]}],
                "cameras":[{"id":"5","name":"Front","streams":[{"role":"main","rtsp_uri":"rtsp://camera"}]}]
            }"#,
        )
        .unwrap();

        assert_eq!(bundle.displays[0].layouts[0].id, "3");
        assert!(bundle.displays[0].layouts[0].is_default);
        assert_eq!(bundle.cameras[0].streams[0].rtsp_uri, "rtsp://camera");
    }

    #[test]
    fn migrates_plaintext_state_to_dpapi() {
        let path = state_dir().join(format!("state-migration-{}.json", std::process::id()));
        let plaintext = serde_json::to_vec(&ClientState {
            server_url: "https://frame.example".to_string(),
            kiosk_key: Some("secret".to_string()),
            ..ClientState::default()
        })
        .unwrap();
        ensure_secure_state_dir().unwrap();
        fs::write(&path, plaintext).unwrap();

        let state = load_state_file(&path).unwrap();
        let stored = fs::read(&path).unwrap();
        let _ = fs::remove_file(path);

        assert_eq!(state.server_url, "https://frame.example");
        assert_eq!(state.kiosk_key.as_deref(), Some("secret"));
        assert!(stored.starts_with(PROTECTED_MAGIC));
    }
}
