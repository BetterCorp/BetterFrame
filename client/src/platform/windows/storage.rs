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

pub(super) fn load_state() -> ClientState {
    read_protected_or_plain(&state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| ClientState {
            server_url: DEFAULT_SERVER_URL.to_string(),
            ..ClientState::default()
        })
}

pub(super) fn save_state(state: &ClientState) -> Result<(), String> {
    fs::create_dir_all(state_dir()).map_err(|e| format!("create state dir: {e}"))?;
    write_protected(&state_path(), &serde_json::to_vec(state).unwrap())
}

pub(super) fn load_bundle() -> Option<KioskBundle> {
    read_protected_or_plain(&bundle_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
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

pub(super) fn write_protected(path: &std::path::Path, plaintext: &[u8]) -> Result<(), String> {
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
        return Err(format!(
            "commit protected state: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(super) fn wide_path(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

pub(super) fn ensure_default_policy() -> Result<(), String> {
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
    fs::read_to_string(policy_path())
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
