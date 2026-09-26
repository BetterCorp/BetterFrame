use std::{
    ffi::OsStr,
    fs,
    io::Write,
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    ptr::{null, null_mut},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Cryptography::*, *},
    System::{
        ApplicationInstallationAndServicing::*, Diagnostics::ToolHelp::*, Environment::*,
        RemoteDesktop::*, Services::*, Threading::*,
    },
};

pub const SERVICE: &str = "BetterFrameUpdater";
pub static STOP: AtomicBool = AtomicBool::new(false);
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
pub fn install_dir() -> PathBuf {
    std::env::current_exe()
        .expect("updater path")
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}
pub fn root() -> PathBuf {
    install_dir().join("updates")
}
pub fn client_exe() -> PathBuf {
    install_dir().join("bin/betterframe-windows-client.exe")
}
pub fn state_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("PROGRAMDATA").unwrap_or_else(|| "C:\\ProgramData".into()))
        .join("BetterFrame/WindowsClient")
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
pub fn log(text: &str) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root().join("updater.log"))
    {
        // Bounded local log; never log identities, credentials or response bodies.
        if file.metadata().is_ok_and(|m| m.len() > 1024 * 1024) {
            let _ = file.set_len(0);
        }
        let _ = writeln!(file, "{} {text}", chrono::Utc::now().to_rfc3339());
    }
}

pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub fn mutex(name: &str) -> Result<Option<Handle>, String> {
    let h = unsafe { CreateMutexW(null(), 0, wide(name).as_ptr()) };
    if h == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(h);
        }
        return Ok(None);
    }
    Ok(Some(Handle(h)))
}

pub fn require_system() -> Result<(), String> {
    unsafe {
        let mut token = 0;
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err("cannot inspect updater token".into());
        }
        let token = Handle(token);
        let mut buffer = vec![0usize; 256];
        let mut needed = 0;
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * size_of::<usize>()) as u32,
            &mut needed,
        ) == 0
        {
            return Err("cannot inspect updater identity".into());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        if IsWellKnownSid(user.User.Sid, WinLocalSystemSid) == 0 {
            return Err("updates must run as the installed SYSTEM service".into());
        }
    }
    Ok(())
}

/// Read machine-DPAPI state without changing the desktop account's directory ACL.
pub fn read_state<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let plain = if bytes.starts_with(b"BFW1") {
        let input = CRYPT_INTEGER_BLOB {
            cbData: (bytes.len() - 4) as u32,
            pbData: bytes[4..].as_ptr() as *mut u8,
        };
        let mut output: CRYPT_INTEGER_BLOB = unsafe { zeroed() };
        if unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output) }
            == 0
        {
            return Err("cannot read protected client state".into());
        }
        let plain =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData.cast());
        }
        plain
    } else {
        bytes
    };
    serde_json::from_slice(&plain).map_err(|_| "invalid client state".into())
}

fn secure_root() -> Result<(), String> {
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, GetFileAttributesW,
    };
    fs::create_dir_all(root()).map_err(|e| e.to_string())?;
    unsafe {
        if GetFileAttributesW(wide(root()).as_ptr()) & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("updater storage cannot be a reparse point".into());
        }
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)").as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err("cannot create updater ACL".into());
        }
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted);
        let result = SetNamedSecurityInfoW(
            wide(root()).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null_mut(),
        );
        LocalFree(descriptor);
        if result != 0 {
            return Err("cannot protect updater storage".into());
        }
    }
    Ok(())
}

pub fn service() -> Result<(), String> {
    require_system()?;
    secure_root()?;
    let mut name = wide(SERVICE);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: null_mut(),
            lpServiceProc: None,
        },
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut core::ffi::c_void,
    _: *mut core::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::SeqCst);
    }
    0
}
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let handle =
        unsafe { RegisterServiceCtrlHandlerExW(wide(SERVICE).as_ptr(), Some(control), null()) };
    if handle == 0 {
        return;
    }
    let mut status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: SERVICE_RUNNING,
        dwControlsAccepted: SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN,
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: 0,
    };
    unsafe {
        SetServiceStatus(handle, &status);
    }
    std::thread::spawn(crate::worker::run);
    while !STOP.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(200));
    }
    // Do not wait for network I/O on service stop. Process exit terminates workers;
    // partial downloads are never executable and are overwritten next attempt.
    status.dwCurrentState = SERVICE_STOPPED;
    status.dwControlsAccepted = 0;
    unsafe {
        SetServiceStatus(handle, &status);
    }
}

pub fn start_service() -> Result<(), String> {
    unsafe {
        let manager = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
        if manager == 0 {
            return Err("cannot open service manager".into());
        }
        let service = OpenServiceW(manager, wide(SERVICE).as_ptr(), SERVICE_START);
        if service == 0 {
            CloseServiceHandle(manager);
            return Err("updater service is missing".into());
        }
        let started = StartServiceW(service, 0, null());
        let error = GetLastError();
        CloseServiceHandle(service);
        CloseServiceHandle(manager);
        if started == 0 && error != ERROR_SERVICE_ALREADY_RUNNING {
            return Err(format!("cannot start updater service: {error}"));
        }
        Ok(())
    }
}

struct Msi(u32);
impl Drop for Msi {
    fn drop(&mut self) {
        unsafe {
            MsiCloseHandle(self.0);
        }
    }
}
pub fn msi_property(path: &Path, property: &str) -> Result<String, String> {
    unsafe {
        let mut db = 0;
        if MsiOpenDatabaseW(wide(path).as_ptr(), null(), &mut db) != 0 {
            return Err("cannot read verified MSI database".into());
        }
        let db = Msi(db);
        let mut view = 0;
        let sql = format!("SELECT `Value` FROM `Property` WHERE `Property`='{property}'");
        if MsiDatabaseOpenViewW(db.0, wide(sql).as_ptr(), &mut view) != 0 {
            return Err("cannot query MSI".into());
        }
        let view = Msi(view);
        if MsiViewExecute(view.0, 0) != 0 {
            return Err("cannot execute MSI query".into());
        }
        let mut record = 0;
        if MsiViewFetch(view.0, &mut record) != 0 {
            return Err(format!("MSI lacks {property}"));
        }
        let record = Msi(record);
        let mut value = vec![0u16; 1024];
        let mut size = value.len() as u32;
        if MsiRecordGetStringW(record.0, 1, value.as_mut_ptr(), &mut size) != 0 {
            return Err("invalid MSI property".into());
        }
        Ok(String::from_utf16_lossy(&value[..size as usize]))
    }
}
pub fn validate_msi(path: &Path, version: &str) -> Result<(), String> {
    if !msi_property(path, "UpgradeCode")?
        .eq_ignore_ascii_case(betterframe_windows_updater::UPGRADE_CODE)
        || msi_property(path, "BF_RELEASE_VERSION")? != version
        || msi_property(path, "BF_UPDATE_TARGET")? != betterframe_windows_updater::TARGET
    {
        return Err("signed MSI does not match this product, platform and release".into());
    }
    Ok(())
}

pub fn run_msi(path: &Path) -> Result<(), String> {
    let code = Command::new(system_exe("msiexec.exe"))
        .args(["/i"])
        .arg(path)
        .args(["/qn", "/norestart", "REBOOT=ReallySuppress"])
        .raw_arg(format!("APPLICATIONFOLDER=\"{}\"", install_dir().display()))
        .args(["/L*v"])
        .arg(root().join("install.log"))
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    match code.code() {
        Some(0 | 3010) => Ok(()),
        _ => Err(format!("MSI installation failed: {code}")),
    }
}
pub fn system_exe(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join(name)
}

/// Stop only processes executing the installed client, not namesakes elsewhere.
/// Capture their sessions before replacement; resume under each user's token.
pub fn stop_clients() -> Result<Vec<u32>, String> {
    let wanted = client_exe()
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let mut sessions = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("cannot enumerate client processes".into());
        }
        let snapshot = Handle(snapshot);
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot.0, &mut entry);
        while more != 0 {
            let process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                entry.th32ProcessID,
            );
            if process != 0 {
                let process = Handle(process);
                let mut path = vec![0u16; 32768];
                let mut len = path.len() as u32;
                if QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut len) != 0
                    && String::from_utf16_lossy(&path[..len as usize]).to_lowercase() == wanted
                {
                    let mut session = 0;
                    if ProcessIdToSessionId(entry.th32ProcessID, &mut session) != 0
                        && session != 0
                        && !sessions.contains(&session)
                    {
                        sessions.push(session);
                    }
                    TerminateProcess(process.0, 0);
                    WaitForSingleObject(process.0, 10000);
                }
            }
            more = Process32NextW(snapshot.0, &mut entry);
        }
    }
    Ok(sessions)
}
pub fn active_sessions() -> Vec<u32> {
    let mut sessions = Vec::new();
    unsafe {
        let mut entries = null_mut();
        let mut count = 0;
        if WTSEnumerateSessionsW(0, 0, 1, &mut entries, &mut count) != 0 {
            for entry in std::slice::from_raw_parts(entries, count as usize) {
                if entry.SessionId != 0 && entry.State == WTSActive {
                    sessions.push(entry.SessionId);
                }
            }
            WTSFreeMemory(entries.cast());
        }
    }
    sessions
}
pub fn launch_client(session: u32) -> Result<(), String> {
    unsafe {
        let mut token = 0;
        if WTSQueryUserToken(session, &mut token) == 0 {
            return Err(format!("no user token for session {session}"));
        }
        let token = Handle(token);
        let mut environment = null_mut();
        if CreateEnvironmentBlock(&mut environment, token.0, 0) == 0 {
            return Err("cannot create user environment".into());
        }
        let mut startup: STARTUPINFOW = zeroed();
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        let mut desktop = wide("winsta0\\default");
        startup.lpDesktop = desktop.as_mut_ptr();
        let exe = client_exe();
        let mut command = wide(format!("\"{}\" desktop", exe.display()));
        let mut process: PROCESS_INFORMATION = zeroed();
        let ok = CreateProcessAsUserW(
            token.0,
            wide(&exe).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_UNICODE_ENVIRONMENT,
            environment,
            wide(exe.parent().unwrap()).as_ptr(),
            &startup,
            &mut process,
        );
        DestroyEnvironmentBlock(environment);
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        CloseHandle(process.hProcess);
        CloseHandle(process.hThread);
    }
    Ok(())
}
pub fn package_probe() -> Result<(), String> {
    executable_probe(&client_exe(), "installation-test")
}
pub fn executable_probe(path: &Path, argument: &str) -> Result<(), String> {
    let mut process = Command::new(path)
        .arg(argument)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    for _ in 0..60 {
        if let Some(status) = process.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err(format!("installed executable probe failed: {status}"))
            };
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let _ = process.kill();
    let _ = process.wait();
    Err("installed executable probe timed out".into())
}
