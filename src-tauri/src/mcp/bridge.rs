//! How a tool reaches the app's frontend: a line appended to the session
//! command queue (`session_commands.jsonl`), which the frontend polls, plus a
//! wake event — fire-and-forget for live-session mutations, or an RPC whose
//! result the frontend appends to `session_command_results.jsonl`.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::context::{new_id, McpContext};

/// Emitted after enqueuing a session command so the frontend applies it now
/// instead of on its next (possibly suspended) poll tick.
pub(super) const SESSION_COMMANDS_EVENT: &str = "session://commands";

/// Append one mutation command for the frontend to apply. The frontend polls
/// the file and applies new lines, so we only need to enqueue the intent —
/// stamped with this server's `instance` (same scoping rule as call_frontend)
/// and followed by a wake event so an occluded window applies it promptly.
pub(super) fn append_command(
    state: &McpContext,
    action: &str,
    args: Value,
) -> anyhow::Result<Value> {
    use std::io::Write;
    let path = &state.commands_path;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = json!({ "instance": state.endpoint, "action": action, "args": args }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    (state.emit)(SESSION_COMMANDS_EVENT, Value::Null);
    Ok(json!({ "ok": true, "queued": action }))
}

/// How long to wait for the frontend to answer. Most RPCs are local bookkeeping
/// or a small JSON round trip and land in a couple of poll ticks. The two that
/// pull a whole recording down from the cloud are bounded by the audio blob's
/// size and the user's connection instead — and timing those out is worse than
/// slow, because the download keeps running in the app and the caller is told it
/// failed.
fn rpc_timeout(action: &str) -> std::time::Duration {
    match action {
        "download_cloud_recording" | "copy_org_recording_to_personal" => {
            std::time::Duration::from_secs(180)
        }
        _ => std::time::Duration::from_secs(20),
    }
}

/// Enqueue a command carrying an id and wait for the frontend to execute it and
/// append `{ id, ok, data|error }` to the results file. The frontend polls the
/// queue every ~1.5s, so a round trip is typically 2–3s; cloud operations (org
/// listing/moves) add their own network time. See {@link rpc_timeout}.
pub(super) async fn call_frontend(
    state: &McpContext,
    action: &str,
    args: Value,
) -> anyhow::Result<Value> {
    use std::io::Write;
    let id = new_id();
    if let Some(parent) = state.commands_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `instance` scopes the command to THIS server's own frontend (see McpContext).
    let line =
        json!({ "id": id, "instance": state.endpoint, "action": action, "args": args }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.commands_path)?;
    writeln!(file, "{line}")?;
    // Wake the webview AFTER the line is on disk — occluded windows have their
    // timers suspended, so without this kick the poll loop may never run.
    (state.emit)(SESSION_COMMANDS_EVENT, Value::Null);

    let deadline = std::time::Instant::now() + rpc_timeout(action);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if let Some(result) = find_result(&state.results_path, &id) {
            if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(result.get("data").cloned().unwrap_or(Value::Null));
            }
            let err = result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("the Parley app could not apply '{action}': {err}");
        }
        if std::time::Instant::now() >= deadline {
            anyhow::bail!(
                "timed out waiting for the Parley app to apply '{action}' — make sure the \
                 app is running (and signed in, for cloud/org operations)"
            );
        }
    }
}

/// Scan the results file for the line matching `id` (the file is truncated on
/// every server start, so it stays small).
pub(super) fn find_result(path: &PathBuf, id: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("id").and_then(Value::as_str) == Some(id))
}

#[cfg(test)]
mod tests {
    use super::rpc_timeout;

    #[test]
    fn recording_downloads_get_a_longer_deadline_than_bookkeeping() {
        // A meeting's audio can take far longer than a folder rename; timing the
        // download out would report failure while the app is still downloading.
        let bookkeeping = rpc_timeout("rename_folder");
        assert!(rpc_timeout("download_cloud_recording") > bookkeeping);
        assert!(rpc_timeout("copy_org_recording_to_personal") > bookkeeping);
    }
}
