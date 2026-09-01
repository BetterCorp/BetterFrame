use super::*;

pub(super) fn set_monitor_power(on: bool) {
    unsafe {
        let state = if on {
            -1isize as LPARAM
        } else {
            2isize as LPARAM
        };
        SendMessageW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER as WPARAM,
            state,
        );
    }
}

pub(super) fn set_volume_percent(percent: u32) {
    let up_presses = percent.min(100) / 2;
    let script = if up_presses == 0 {
        "$obj = New-Object -ComObject WScript.Shell; 1..50 | % {$obj.SendKeys([char]174)}"
            .to_string()
    } else {
        format!(
            "$obj = New-Object -ComObject WScript.Shell; 1..50 | % {{$obj.SendKeys([char]174)}}; 1..{} | % {{$obj.SendKeys([char]175)}}",
            up_presses
        )
    };
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .spawn();
}

pub(super) fn set_mute(_muted: bool) {
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "(New-Object -ComObject WScript.Shell).SendKeys([char]173)",
        ])
        .spawn();
}

pub(super) fn invalidate_app_windows() {
    // The app also polls state once per second; this is intentionally best effort.
}

pub(super) fn install_tasks(args: &[String]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let server = arg_value(args, "--server").unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
    let agent_tr = format!("\"{}\" agent --server {}", exe.display(), server);
    run_command(
        "schtasks",
        &[
            "/Create",
            "/TN",
            AGENT_TASK_NAME,
            "/SC",
            "ONLOGON",
            "/RL",
            "HIGHEST",
            "/F",
            "/TR",
            &agent_tr,
        ],
    )?;
    let _ = run_command("schtasks", &["/Delete", "/TN", APP_TASK_NAME, "/F"]);
    println!("Installed BetterFrame Windows logon task.");
    Ok(())
}

pub(super) fn uninstall_tasks() -> Result<(), String> {
    let _ = run_command("schtasks", &["/Delete", "/TN", AGENT_TASK_NAME, "/F"]);
    let _ = run_command("schtasks", &["/Delete", "/TN", APP_TASK_NAME, "/F"]);
    println!("Removed BetterFrame Windows logon tasks.");
    Ok(())
}

pub(super) fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("{program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

pub(super) fn acquire_app_instance() -> Result<Option<HANDLE>, String> {
    let name = wide("Local\\BetterFrameWindowsRenderer");
    let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
    if handle == 0 {
        return Err(format!(
            "create renderer mutex: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return Ok(None);
    }
    Ok(Some(handle))
}
