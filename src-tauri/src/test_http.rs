//! A scripted local HTTP server for characterization tests of the batch
//! (upload) transcription adapters. Every request is recorded verbatim, and
//! each `METHOD path` answers from its own script of canned responses — served
//! in order, the last one repeating — so a polled job can report "processing"
//! before "completed". Anything unscripted answers 404.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// One request as the server saw it.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// The raw query string, without the `?` (empty when there is none).
    pub query: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn body_json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
}

type Script = Vec<(u16, String)>;

#[derive(Default)]
struct State {
    scripts: HashMap<String, (Script, usize)>,
    requests: Vec<Recorded>,
}

/// A running server. Dropping it leaves the task to die with the test runtime.
pub struct MockServer {
    pub base: String,
    state: Arc<Mutex<State>>,
}

impl MockServer {
    /// Every request received so far, in arrival order.
    pub fn requests(&self) -> Vec<Recorded> {
        self.state.lock().unwrap().requests.clone()
    }

    /// The requests to `method path`, in arrival order.
    pub fn requests_to(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == method && r.path == path)
            .collect()
    }

    /// `"METHOD path"` of every request, in arrival order.
    pub fn trace(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect()
    }
}

/// Start a server answering `routes`: `("POST /v1/files", [(200, body), …])`.
pub async fn serve(routes: Vec<(&str, Vec<(u16, &str)>)>) -> MockServer {
    let mut scripts = HashMap::new();
    for (route, script) in routes {
        let script: Script = script
            .into_iter()
            .map(|(s, b)| (s, b.to_string()))
            .collect();
        scripts.insert(route.to_string(), (script, 0));
    }
    let state = Arc::new(Mutex::new(State {
        scripts,
        requests: Vec::new(),
    }));
    let shared = state.clone();
    let app = axum::Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let state = shared.clone();
            async move { answer(&state, method, uri, headers, body) }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    MockServer {
        base: format!("http://{addr}"),
        state,
    }
}

fn answer(
    state: &Mutex<State>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut state = state.lock().unwrap();
    let path = uri.path().to_string();
    state.requests.push(Recorded {
        method: method.to_string(),
        path: path.clone(),
        query: uri.query().unwrap_or_default().to_string(),
        headers,
        body: body.to_vec(),
    });
    let Some((script, next)) = state.scripts.get_mut(&format!("{method} {path}")) else {
        return (StatusCode::NOT_FOUND, "unscripted").into_response();
    };
    let (status, body) = script[(*next).min(script.len() - 1)].clone();
    *next += 1;
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        body,
    )
        .into_response()
}

/// A fresh scratch directory under the OS temp dir.
pub fn scratch_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "parley-test-{tag}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A fake upload file holding `bytes`, named `name`, in a fresh scratch dir.
pub fn upload_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = scratch_dir("upload").join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}
