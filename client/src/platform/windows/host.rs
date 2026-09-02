use super::*;

pub(super) fn set_monitor_power(on: bool) {
    unsafe {
        let state = if on {
            -1isize as LPARAM
        } else {
            2isize as LPARAM
        };
        let mut result = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER as WPARAM,
            state,
            SMTO_ABORTIFHUNG,
            2_000,
            &mut result,
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

pub(super) fn set_mute(muted: bool) -> Result<(), String> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err(format!(
                "initialize Windows audio: {}",
                windows::core::Error::from(initialized)
            ));
        }
        let result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|error| format!("create audio endpoint enumerator: {error}"))?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|error| format!("get default audio endpoint: {error}"))?;
            let volume: IAudioEndpointVolume = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|error| format!("activate endpoint volume: {error}"))?;
            volume
                .SetMute(muted, null())
                .map_err(|error| format!("set endpoint mute: {error}"))
        })();
        if initialized.is_ok() {
            CoUninitialize();
        }
        result
    }
}

pub(super) fn invalidate_app_windows() {
    // The app also polls state once per second; this is intentionally best effort.
}

pub(super) fn install_tasks(args: &[String]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let agent_tr = match arg_value(args, "--server") {
        Some(server) => format!("\"{}\" agent --server {}", exe.display(), server),
        None => format!("\"{}\" agent", exe.display()),
    };
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
