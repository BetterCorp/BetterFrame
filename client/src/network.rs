use reqwest::redirect::Policy;
use std::time::Duration;

/// BF API clients must never replay polling-secret bodies or credentials after a redirect.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .expect("build BF API client")
}

pub fn blocking_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .redirect(Policy::none())
        .build()
        .expect("build BF API client")
}

fn discovery_policy() -> Policy {
    Policy::custom(|attempt| {
        let previous = attempt.previous();
        let Some(last) = previous.last() else {
            return attempt.error("missing discovery origin");
        };
        match crate::core::protocol::validate_discovery_redirect(
            last,
            attempt.url(),
            previous.len() - 1,
        ) {
            Ok(()) => attempt.follow(),
            Err(error) => attempt.error(error),
        }
    })
}

#[cfg(target_os = "linux")]
pub fn discover(origin: &str, explicit: bool) -> Result<String, String> {
    let probe = crate::core::protocol::discovery_probe(origin)?;
    let response = reqwest::blocking::Client::builder()
        .redirect(discovery_policy())
        .referer(false)
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?
        .get(probe)
        .send()
        .map_err(|error| format!("server discovery failed: {error}"))?;
    // Direct API-port deployments predate /healthz. Only an explicitly selected
    // server may use that compatibility path; automatic discovery still needs 2xx.
    if response.status().is_success()
        || (explicit && response.status() == reqwest::StatusCode::NOT_FOUND)
    {
        Ok(crate::core::protocol::server_origin(response.url()))
    } else {
        Err(format!(
            "server discovery returned HTTP {}",
            response.status()
        ))
    }
}

#[cfg(target_os = "windows")]
pub async fn discover(origin: &str, explicit: bool) -> Result<String, String> {
    let probe = crate::core::protocol::discovery_probe(origin)?;
    let response = reqwest::Client::builder()
        .redirect(discovery_policy())
        .referer(false)
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?
        .get(probe)
        .send()
        .await
        .map_err(|error| format!("server discovery failed: {error}"))?;
    if response.status().is_success()
        || (explicit && response.status() == reqwest::StatusCode::NOT_FOUND)
    {
        Ok(crate::core::protocol::server_origin(response.url()))
    } else {
        Err(format!(
            "server discovery returned HTTP {}",
            response.status()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn read_request(socket: &mut std::net::TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let read = socket.read(&mut chunk).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    return String::from_utf8(request).unwrap();
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn discovery_is_anonymous_and_rejects_cleartext_origin_changes_before_contact() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let target = format!("http://{}/healthz", destination.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket).to_lowercase();
            assert!(request.starts_with("get /healthz "));
            assert!(!request.contains("authorization:") && !request.contains("cookie:"));
            write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert!(discover(&origin, true).is_err());
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn authenticated_posts_never_replay_body_or_bearer_to_a_redirect_destination() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let target = format!(
            "http://{}/api/pair/claim",
            destination.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            assert!(
                request
                    .to_lowercase()
                    .contains("authorization: bearer test-device-key")
            );
            assert!(request.contains("polling_secret=test-secret"));
            write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = blocking_client()
            .post(format!("{origin}/api/pair/claim"))
            .bearer_auth("test-device-key")
            .body("polling_secret=test-secret")
            .timeout(Duration::from_secs(5))
            .send()
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn async_credential_client_also_refuses_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_request(&mut socket);
            write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: https://untrusted.invalid/claim\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = client()
            .post(format!("{origin}/api/pair/claim"))
            .bearer_auth("test-device-key")
            .body("polling_secret=test-secret")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        server.join().unwrap();
    }
}
