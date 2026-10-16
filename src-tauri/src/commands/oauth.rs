//! The desktop sign-in handoff: a one-shot loopback HTTP server that catches
//! the token the cloud redirects the browser to after OAuth.

use tauri::{AppHandle, Emitter};

/// Minimal percent-decoder for the loopback query (the token is encodeURIComponent'd).
fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 3 <= b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(b[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Start a one-shot loopback server for the desktop Google-login handoff. The
/// cloud, after OAuth, redirects the browser to `http://127.0.0.1:<port>/cb?token=…`;
/// we capture that token, emit `auth://callback` to the frontend, show a
/// "you can close this tab" page, and stop. Returns the bound port immediately so
/// the caller can build the callback URL. Works in `tauri dev` (no URL-scheme
/// registration, unlike a custom-scheme deep link). Gives up after 5 minutes.
#[tauri::command]
pub fn start_oauth_loopback(app: AppHandle) -> Result<u16, String> {
    use std::io::Read;
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).ok();

    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let (token, error) =
                        parse_loopback_callback(&String::from_utf8_lossy(&buf[..n]));
                    write_close_tab_page(&mut stream);
                    let _ = app.emit(
                        "auth://callback",
                        serde_json::json!({ "token": token, "error": error }),
                    );
                    break;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        let _ =
                            app.emit("auth://callback", serde_json::json!({ "error": "timeout" }));
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
    });

    Ok(port)
}

/// Pull `token` / `error` out of the loopback request's query string.
fn parse_loopback_callback(req: &str) -> (Option<String>, Option<String>) {
    // Request line: "GET /cb?token=… HTTP/1.1"
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let query = path.split_once('?').map_or("", |(_, q)| q);
    let (mut token, mut error) = (None::<String>, None::<String>);
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("token"), Some(v)) => token = Some(urldecode(v)),
            (Some("error"), Some(v)) => error = Some(urldecode(v)),
            _ => {}
        }
    }
    (token, error)
}

/// Serve the bilingual "you can close this tab" page and flush it.
fn write_close_tab_page(stream: &mut std::net::TcpStream) {
    use std::io::Write;

    let body = "<!doctype html><meta charset=utf-8><title>Parley</title>\
<body style=\"font-family:system-ui;padding:3rem;text-align:center;color:#333\">\
<h2>Parley</h2><p>登入完成，可以關閉這個分頁回到 Parley。</p>\
<p>You're signed in — close this tab and return to Parley.</p></body>";
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::{parse_loopback_callback, urldecode};

    #[test]
    fn urldecode_handles_percent_escapes_plus_and_malformed_input() {
        assert_eq!(urldecode("a%20b+c"), "a b c");
        assert_eq!(urldecode("%E6%9D%B1%E6%A3%AE"), "東森");
        // A `%` without two hex digits after it is kept as-is.
        assert_eq!(urldecode("100%"), "100%");
        assert_eq!(urldecode("%zz1"), "%zz1");
        assert_eq!(urldecode("%4"), "%4");
        // Invalid UTF-8 decodes lossily instead of failing.
        assert_eq!(urldecode("%FF"), "\u{FFFD}");
    }

    #[test]
    fn the_loopback_callback_yields_its_token_and_error() {
        let req = "GET /cb?token=abc%2Fdef&state=x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_loopback_callback(req),
            (Some("abc/def".to_string()), None)
        );
        assert_eq!(
            parse_loopback_callback("GET /cb?error=access+denied HTTP/1.1\r\n"),
            (None, Some("access denied".to_string()))
        );
        // The last of a repeated key wins; a key without `=` is ignored.
        assert_eq!(
            parse_loopback_callback("GET /cb?token=a&token=b&error HTTP/1.1"),
            (Some("b".to_string()), None)
        );
        assert_eq!(parse_loopback_callback("GET /cb HTTP/1.1"), (None, None));
        assert_eq!(parse_loopback_callback(""), (None, None));
    }
}
