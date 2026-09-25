//! Preserve the normal authenticated fleet route; public downloads are recovery.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

const DEFERRED: &str = "update download deferred by server rate limit";
static RETRY_AT: Mutex<Option<Instant>> = Mutex::new(None);

pub fn deferred() -> bool {
    RETRY_AT
        .lock()
        .unwrap()
        .is_some_and(|until| Instant::now() < until)
}

pub fn is_deferred(error: &str) -> bool {
    error == DEFERRED
}

pub fn get(
    server: &str,
    key: Option<&str>,
    path: &str,
    offset: u64,
) -> Result<reqwest::blocking::Response, String> {
    if deferred() {
        return Err(DEFERRED.into());
    }
    let client = crate::network::blocking_client();
    let public_path = path
        .replacen(
            "/api/kiosk/firmware/download/",
            "/api/firmware/public/download/",
            1,
        )
        .replacen("/api/kiosk/os/download/", "/api/os/public/download/", 1);
    let key = key.filter(|key| !key.is_empty() && public_path != path);
    let request = |path: &str, key: Option<&str>| {
        let mut request = client.get(format!("{server}{path}"));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        if offset > 0 {
            request = request.header("Range", format!("bytes={offset}-"));
        }
        request.timeout(Duration::from_secs(300)).send()
    };
    let response = if key.is_some() {
        match request(path, key) {
            Ok(response) if !matches!(response.status().as_u16(), 401 | 403 | 404 | 500..=599) => {
                Ok(response)
            }
            // Rejected authentication or a failed control endpoint cannot prevent
            // fetching the same signed artifact through the recovery route.
            _ => request(&public_path, None),
        }
    } else {
        request(&public_path, None)
    }
    .map_err(|error| format!("download request: {error}"))?;
    if response.status().as_u16() == 429 {
        let delay = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(1, 3600);
        // Spread a shared-egress fleet across subsequent admission windows.
        *RETRY_AT.lock().unwrap() =
            Some(Instant::now() + Duration::from_secs(delay + rand::random::<u64>() % 61));
        return Err(DEFERRED.into());
    }
    Ok(response)
}

#[cfg(test)]
pub static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn healthy_fleet_stays_authenticated_and_recovery_defers_on_throttling() {
        let _lock = TEST_LOCK.lock().unwrap();
        *RETRY_AT.lock().unwrap() = None;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let handler = std::thread::spawn(move || {
            let mut cases = vec![("/api/kiosk/firmware/download/app", true, false, "200 OK"); 7];
            cases.extend([
                ("/api/kiosk/os/download/os", true, true, "401 Unauthorized"),
                (
                    "/api/os/public/download/os",
                    false,
                    true,
                    "206 Partial Content",
                ),
                (
                    "/api/firmware/public/download/app",
                    false,
                    false,
                    "429 Too Many Requests",
                ),
            ]);
            for (path, auth, range, status) in cases {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|value| value == b"\r\n\r\n") {
                    let size = stream.read(&mut buffer).unwrap();
                    assert!(size > 0);
                    request.extend_from_slice(&buffer[..size]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with(&format!("get {path} ")), "{request}");
                assert_eq!(request.contains("authorization: bearer device-key"), auth);
                assert_eq!(request.contains("range: bytes=123-"), range);
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 1\r\nRetry-After: 60\r\nConnection: close\r\n\r\nx").unwrap();
            }
        });
        for _ in 0..7 {
            assert_eq!(
                get(
                    &server,
                    Some("device-key"),
                    "/api/kiosk/firmware/download/app",
                    0
                )
                .unwrap()
                .status()
                .as_u16(),
                200
            );
        }
        assert_eq!(
            get(
                &server,
                Some("device-key"),
                "/api/kiosk/os/download/os",
                123
            )
            .unwrap()
            .status()
            .as_u16(),
            206
        );
        let error = get(
            &server,
            Some("device-key"),
            "/api/firmware/public/download/app",
            0,
        )
        .unwrap_err();
        assert!(is_deferred(&error));
        assert!(deferred());
        // A subsequent attempt is locally deferred, making no HTTP request.
        assert!(is_deferred(
            &get(&server, None, "/api/firmware/public/download/app", 0).unwrap_err()
        ));
        handler.join().unwrap();
        *RETRY_AT.lock().unwrap() = None;
    }
}
