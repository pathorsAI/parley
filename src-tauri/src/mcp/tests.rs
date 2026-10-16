//! Behavior pins for the MCP surface as a client sees it.

use std::{path::PathBuf, sync::Arc};

use serde_json::{json, Value};

use super::activity::{McpActivity, ACTIVITY_CAP};
use super::bridge::find_result;
use super::context::{now_ms, McpContext};
use super::path_or_fallback;
use super::registry::{call_tool, tools};
use super::server::handle_method;

/// A phone batch transcription synced before #576: every line 0 → 0.
pub(super) fn untimed_meta(texts: &[&str], duration_ms: f64) -> Value {
    let segments: Vec<Value> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            json!({ "id": format!("mix-{i}"), "source": "mix", "speaker": (i % 2) as i64,
                    "text": t, "isFinal": true, "startMs": 0, "endMs": 0 })
        })
        .collect();
    json!({ "id": "r1", "durationMs": duration_ms, "segments": segments, "speakerNames": {} })
}

// ── Behavior pins: the MCP surface as an MCP client sees it ─────────────
//
// Golden files under src/mcp/snapshots/ hold the tools/list catalog and a
// run of every tool over fixed fixtures. They pin the visible contract —
// tool names, schemas, outputs, error strings, the command-queue lines and
// the events emitted — so restructuring this module provably changes none
// of it. Regenerate with PARLEY_UPDATE_SNAPSHOTS=1 only for an intended
// contract change.

fn snapshot_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/mcp/snapshots")
        .join(name)
}

/// Compare `actual` with the golden file `name` (or rewrite it when
/// PARLEY_UPDATE_SNAPSHOTS is set).
fn assert_snapshot(name: &str, actual: &Value) {
    let path = snapshot_path(name);
    let text = format!("{}\n", serde_json::to_string_pretty(actual).unwrap());
    if std::env::var_os("PARLEY_UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let golden = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing snapshot {}: {e}", path.display()));
    if golden == text {
        return;
    }
    let expected: Value = serde_json::from_str(&golden).unwrap();
    if let (Some(a), Some(b)) = (actual.as_array(), expected.as_array()) {
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            assert_eq!(x, y, "snapshot {name}: entry {i} differs");
        }
        assert_eq!(a.len(), b.len(), "snapshot {name}: entry count differs");
    }
    assert_eq!(text, golden, "snapshot {name} differs");
}

#[test]
fn tools_list_matches_the_snapshot() {
    // The exact text an MCP client receives for tools/list.
    assert_snapshot("tools_list.json", &json!({ "tools": tools() }));
}

#[test]
fn a_failed_path_resolver_falls_back_inside_the_fallback_dir() {
    let ok: Result<PathBuf, String> = Ok(PathBuf::from("/cfg/templates.json"));
    assert_eq!(
        path_or_fallback(ok, || Some(PathBuf::from("/other")), "x.json"),
        PathBuf::from("/cfg/templates.json")
    );
    let failed: Result<PathBuf, String> = Err("no config dir".into());
    assert_eq!(
        path_or_fallback(failed.clone(), || Some(PathBuf::from("/data")), "history"),
        PathBuf::from("/data/history")
    );
    assert_eq!(
        path_or_fallback(failed, || None, "session.json"),
        PathBuf::from("./session.json")
    );
}

type Events = Arc<std::sync::Mutex<Vec<Value>>>;

/// A tool context over a scratch dir, recording every event it emits.
fn harness(tag: &str) -> (McpContext, PathBuf, Events) {
    let dir = std::env::temp_dir().join(format!("parley-mcp-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("history")).unwrap();
    let events: Events = Arc::default();
    let sink = events.clone();
    let state = McpContext {
        templates_path: dir.join("templates.json"),
        dictionary_path: dir.join("dictionary.json"),
        session_path: dir.join("session.json"),
        commands_path: dir.join("session_commands.jsonl"),
        results_path: dir.join("session_command_results.jsonl"),
        history_dir: dir.join("history"),
        activity: McpActivity::default(),
        endpoint: "http://127.0.0.1:3011/mcp".into(),
        emit: Arc::new(move |event: &str, payload: Value| {
            sink.lock()
                .unwrap()
                .push(json!({ "event": event, "payload": payload }));
        }),
    };
    (state, dir, events)
}

fn write_json(path: &std::path::Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn write_fixtures(state: &McpContext) {
    write_json(
        &state.templates_path,
        &json!({
            "evalTemplates": [
                { "id": "eval-1", "name": "Sales basics", "builtin": true, "evals": [
                    { "id": "d1", "name": "Budget", "description": "Asks about budget", "prompt": "Did ME ask?" }
                ] },
                { "id": "eval-2", "name": "Mine", "evals": [] }
            ],
            "todoTemplates": [
                { "id": "todo-1", "name": "Discovery", "builtin": true, "items": ["Budget", "Timeline"] }
            ]
        }),
    );
    write_json(
        &state.dictionary_path,
        &json!({
            "entries": [
                { "id": "e1", "phrase": "Parley", "variants": ["派勒"], "createdAt": 1756000000000u64,
                  "updatedAt": 1756000000000u64, "source": "settings", "futureField": 1 }
            ],
            "ignored": [ { "variant": "趴", "phrase": "Parley", "count": 1 } ]
        }),
    );
    let history = &state.history_dir;
    write_json(
        &history.join("rec-1/summary.json"),
        &json!({ "id": "rec-1", "title": "Pricing call", "snippet": "Hello there",
                 "createdAt": 1756000000000u64, "folderId": "f1" }),
    );
    write_json(
        &history.join("rec-1/meta.json"),
        &json!({
            "id": "rec-1", "title": "Pricing call", "source": "live", "createdAt": 1756000000000u64,
            "durationMs": 120000, "folderId": "f1", "analyzed": true,
            "speakerNames": { "them-1": "Alice" },
            "brief": "They want a lower price for 東森.",
            "meetingContext": "Renewal negotiation",
            "deliveryAssessment": { "pace": "ok" },
            "findings": [ { "id": "x1", "atMs": 61000, "title": "Price push", "detail": "They pushed on price", "severity": "warn" } ],
            "actionItems": [ { "text": "Send the price sheet" } ],
            "segments": [
                { "id": "s1", "source": "me", "speaker": 0, "text": "Hello there", "isFinal": true, "startMs": 0, "endMs": 1000 },
                { "id": "s2", "source": "them", "speaker": 1, "text": "The price is too high", "isFinal": true, "startMs": 61000, "endMs": 63000 },
                { "id": "s3", "source": "them", "speaker": 2, "text": "not final", "isFinal": false, "startMs": 64000, "endMs": 65000 },
                { "id": "s4", "source": "mix", "speaker": 3, "text": "  ", "isFinal": true, "startMs": 66000, "endMs": 67000 }
            ]
        }),
    );
    write_json(
        &history.join("rec-2/summary.json"),
        &json!({ "id": "rec-2", "title": "Phone sync", "snippet": "你好", "createdAt": 1757000000000u64 }),
    );
    let mut untimed = untimed_meta(
        &[
            "你好，今天我們討論報價。",
            "OK, let's go over the price.",
            "好",
            "Sounds good 那就這樣",
        ],
        95_000.0,
    );
    untimed["id"] = json!("rec-2");
    untimed["title"] = json!("Phone sync");
    untimed["createdAt"] = json!(1757000000000u64);
    write_json(&history.join("rec-2/meta.json"), &untimed);
    // A half-written entry must be skipped, not fail the listing.
    std::fs::create_dir_all(history.join("broken")).unwrap();
    std::fs::write(history.join("broken/summary.json"), "{ not json").unwrap();
}

/// Replace values that differ per run — fresh ids and "now" timestamps —
/// with stable placeholders.
fn normalize(value: &mut Value, now: u64) {
    match value {
        Value::String(s) if uuid::Uuid::parse_str(s).is_ok() && s.len() == 36 => {
            *s = "<uuid>".into();
        }
        Value::Number(n) => {
            if n.as_u64().is_some_and(|v| v.abs_diff(now) < 86_400_000) {
                *value = json!("<now>");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| normalize(v, now)),
        Value::Object(map) => map.values_mut().for_each(|v| normalize(v, now)),
        _ => {}
    }
}

/// One line of a written file with fresh ids and "now" stamps masked, the
/// same way [`normalize`] masks them in parsed JSON.
fn mask_ids_and_now(line: &str) -> String {
    let now = now_ms();
    line.split_inclusive(['"', ' ', ','])
        .map(|token| {
            let core = token.trim_end_matches(['"', ' ', ',']);
            let tail = &token[core.len()..];
            let is_uuid = core.len() == 36 && uuid::Uuid::parse_str(core).is_ok();
            let is_now = core
                .parse::<u64>()
                .is_ok_and(|v| v.abs_diff(now) < 86_400_000);
            match (is_uuid, is_now) {
                (true, _) => format!("<uuid>{tail}"),
                (_, true) => format!("<now>{tail}"),
                _ => token.to_string(),
            }
        })
        .collect()
}

/// The parsed text payload of a tools/call result, or the error string.
async fn call(state: &McpContext, name: &str, args: &Value) -> Value {
    match call_tool(state, json!({ "name": name, "arguments": args })).await {
        Ok(out) => {
            assert_eq!(out["content"][0]["type"], json!("text"));
            let text = out["content"][0]["text"].as_str().unwrap();
            assert_eq!(out["content"].as_array().unwrap().len(), 1);
            json!({ "result": serde_json::from_str::<Value>(text).unwrap() })
        }
        Err(err) => json!({ "error": err.to_string() }),
    }
}

fn read_lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The steps the dispatch snapshot runs, in order: `[tool, args]`, or
/// `["@session", snapshot]` to replace the session file first.
fn local_cases() -> Value {
    serde_json::from_str(
        r#"[
        ["list_eval_templates", {}],
        ["get_eval_template", { "id": "eval-1" }],
        ["get_eval_template", { "id": "missing" }],
        ["get_eval_template", {}],
        ["upsert_eval_template", { "id": "eval-1", "name": "Sales v2", "evals": [
            { "id": "d1", "name": "Budget", "description": "Budget asked", "prompt": "p" },
            { "name": "Timeline", "description": "When", "prompt": "q" }
        ] }],
        ["upsert_eval_template", { "name": "Brand new", "evals": [] }],
        ["upsert_eval_template", { "name": "No evals" }],
        ["delete_eval_template", { "id": "eval-2" }],
        ["delete_eval_template", { "id": "eval-2" }],
        ["list_eval_templates", {}],
        ["list_todo_templates", {}],
        ["get_todo_template", { "id": "todo-1" }],
        ["get_todo_template", { "id": "nope" }],
        ["upsert_todo_template", { "id": "todo-1", "name": "Discovery v2", "items": ["Budget"] }],
        ["upsert_todo_template", { "name": "Fresh", "items": ["a", "b"] }],
        ["delete_todo_template", { "id": "todo-1" }],
        ["delete_todo_template", {}],
        ["list_todo_templates", {}],
        ["list_dictionary_phrases", {}],
        ["add_dictionary_phrase", { "phrase": " Cerana ", "variants": ["色瑞納", " ", "色瑞納"] }],
        ["add_dictionary_phrase", { "phrase": "  " }],
        ["add_dictionary_phrase", { "variants": [] }],
        ["update_dictionary_phrase", { "id": "e1", "variants": ["派樂", "派樂 "] }],
        ["update_dictionary_phrase", { "id": "missing", "phrase": "x" }],
        ["update_dictionary_phrase", { "id": "e1", "phrase": " " }],
        ["delete_dictionary_phrase", { "id": "e1" }],
        ["delete_dictionary_phrase", { "id": "e1" }],
        ["list_dictionary_phrases", {}],
        ["get_app_context", {}],
        ["get_session_status", {}],
        ["get_transcript", {}],
        ["list_todos", {}],
        ["list_evaluations", {}],
        ["list_findings", {}],
        ["get_focused_content", {}],
        ["@session", {
            "meetingStatus": "recording", "updatedAt": 1756000001000,
            "context": { "appMode": "live" },
            "transcript": { "text": "[You] hi", "segmentCount": 1 },
            "todos": [ { "id": "t1", "text": "Ask budget", "done": false } ],
            "evaluations": [ { "id": "v1", "name": "Budget", "status": "idle" } ],
            "findings": [ { "id": "x1", "atMs": 1000, "title": "Opening" } ],
            "brief": "Live brief", "actionItems": null
        }],
        ["get_app_context", {}],
        ["get_session_status", {}],
        ["get_transcript", {}],
        ["list_todos", {}],
        ["list_evaluations", {}],
        ["list_findings", {}],
        ["get_focused_content", {}],
        ["@session", { "meetingStatus": "paused", "context": { "appMode": "live" } }],
        ["get_app_context", {}],
        ["get_focused_content", {}],
        ["@session", { "meetingStatus": "stopped", "context": { "appMode": "live" }, "todos": [] }],
        ["get_app_context", {}],
        ["get_focused_content", {}],
        ["@session", {
            "meetingStatus": "stopped",
            "context": { "appMode": "replay", "studyTab": "findings",
                         "replay": { "name": "Pricing call", "savedHistoryId": "rec-1" } },
            "transcript": { "text": "x", "segmentCount": 2 },
            "findings": []
        }],
        ["get_app_context", {}],
        ["get_focused_content", {}],
        ["@session", { "context": { "appMode": "replay", "replay": { "name": "Upload" } } }],
        ["get_app_context", {}],
        ["get_focused_content", {}],
        ["@session", { "context": { "appMode": "replay", "replay": { "savedHistoryId": "gone" } } }],
        ["get_focused_content", {}],
        ["@session", { "meetingStatus": "recording", "context": { "appMode": "library" } }],
        ["get_app_context", {}],
        ["get_focused_content", {}],
        ["@session", { "context": { "appMode": "settings" } }],
        ["get_app_context", {}],
        ["@session", "not json"],
        ["get_session_status", {}],
        ["add_todo", { "text": "Follow up" }],
        ["add_todo", {}],
        ["check_todo", { "id": "t1" }],
        ["check_todo", { "id": "t1", "done": false }],
        ["check_todo", { "done": true }],
        ["remove_todo", { "id": "t1" }],
        ["add_evaluation", { "name": "Tone", "prompt": "Was ME calm?" }],
        ["add_evaluation", { "name": "Tone", "description": "Calm", "prompt": "Was ME calm?" }],
        ["add_evaluation", { "name": "Tone" }],
        ["remove_evaluation", { "id": "v1" }],
        ["add_finding", { "atMs": 5, "severity": "info", "title": "t", "detail": "d" }],
        ["set_findings", {}],
        ["set_findings", { "events": [ { "atMs": 1, "severity": "warn", "title": "a", "detail": "b" } ] }],
        ["update_finding", { "title": "no id" }],
        ["update_finding", { "id": "x1", "resolved": true }],
        ["remove_finding", { "id": "x1" }],
        ["remove_finding", {}],
        ["list_recordings", {}],
        ["list_recordings", { "query": "PRICING" }],
        ["list_recordings", { "query": "你好" }],
        ["list_recordings", { "folderId": "f1" }],
        ["list_recordings", { "since": 1756500000000 }],
        ["list_recordings", { "limit": 1 }],
        ["search_meetings", { "query": "price" }],
        ["search_meetings", { "query": "東森" }],
        ["search_meetings", { "query": "price", "hitsPerRecording": 1, "limit": 1 }],
        ["search_meetings", { "query": "price", "folderId": "f1" }],
        ["search_meetings", { "query": "renewal" }],
        ["search_meetings", { "query": "absent" }],
        ["search_meetings", { "query": " " }],
        ["get_recording", { "id": "rec-1" }],
        ["get_recording", { "id": "rec-2" }],
        ["get_recording", { "id": "../rec-1" }],
        ["get_recording", { "id": "missing" }],
        ["get_recording", {}],
        ["no_such_tool", {}],
        ["rename_recording", { "id": "r1" }],
        ["create_folder", {}],
        ["import_transcript", { "paths": [] }],
        ["import_transcript", { "folder": "f1" }],
        ["list_org_recordings", {}],
        ["rename_org_folder", { "orgId": "o1", "name": "x" }],
        ["share_recording_to_org", { "id": "r1" }],
        ["delete_org_recording", { "id": "r1" }]
    ]"#,
    )
    .unwrap()
}

/// Tools answered by the frontend (`call_frontend`), with valid arguments.
fn rpc_cases() -> Value {
    json!([
        ["rename_recording", { "id": "r1", "title": "New title", "extra": 1 }],
        ["update_recording_meta", { "id": "r1", "meetingKind": "internal", "speakerNames": {} }],
        ["set_recording_analysis", { "id": "r1", "findings": [], "brief": "b" }],
        ["list_folders", { "ignored": true }],
        ["create_folder", { "name": "Clients" }],
        ["rename_folder", { "id": "f1", "name": "Renamed" }],
        ["delete_folder", { "id": "f1" }],
        ["delete_folder", { "id": "fail-me" }],
        ["delete_recording", { "id": "r1" }],
        ["import_transcript", { "paths": ["/tmp/a.txt"] }],
        ["import_transcript", { "paths": ["/tmp/a.txt", "/tmp/b.srt"], "folder": "f1" }],
        ["move_recording_to_folder", { "id": "r1" }],
        ["move_recording_to_folder", { "id": "r1", "folderId": "f2" }],
        ["list_cloud_recordings", {}],
        ["list_cloud_recordings", { "query": "q", "since": 5, "limit": 3, "pending": true }],
        ["download_cloud_recording", { "id": "c1" }],
        ["list_orgs", {}],
        ["list_org_recordings", { "orgId": "o1" }],
        ["list_org_folders", { "orgId": "o1" }],
        ["create_org_folder", { "orgId": "o1", "name": "Team" }],
        ["rename_org_folder", { "orgId": "o1", "id": "of1", "name": "Team 2" }],
        ["delete_org_folder", { "orgId": "o1", "id": "of1" }],
        ["move_org_recording_to_folder", { "orgId": "o1", "id": "or1" }],
        ["move_org_recording_to_folder", { "orgId": "o1", "id": "or1", "folderId": "of2" }],
        ["share_recording_to_org", { "id": "r1", "orgId": "o1" }],
        ["share_recording_to_org", { "id": "r1", "orgId": "o1", "folderId": "of1" }],
        ["move_recording_to_org", { "id": "r1", "orgId": "o1" }],
        ["copy_org_recording_to_personal", { "orgId": "o1", "id": "or1" }],
        ["delete_org_recording", { "orgId": "o1", "id": "or1" }]
    ])
}

/// Stands in for the webview's command poller: answers every RPC command
/// it finds with the command it received (minus its id), or an error for
/// a `fail-me` id.
fn spawn_fake_frontend(commands: PathBuf, results: PathBuf) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use std::io::Write;
        let mut answered = std::collections::HashSet::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            let raw = std::fs::read_to_string(&commands).unwrap_or_default();
            for cmd in raw
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            {
                let Some(id) = cmd.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if !answered.insert(id.to_string()) {
                    continue;
                }
                let answer = if cmd.pointer("/args/id") == Some(&json!("fail-me")) {
                    json!({ "id": id, "ok": false, "error": "refused by the app" })
                } else {
                    let mut received = cmd.clone();
                    received.as_object_mut().unwrap().remove("id");
                    json!({ "id": id, "ok": true, "data": { "received": received } })
                };
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&results)
                    .unwrap();
                writeln!(file, "{answer}").unwrap();
            }
        }
    })
}

#[tokio::test]
async fn every_tool_dispatches_as_the_snapshot_records() {
    let now = now_ms();
    let (state, dir, events) = harness("dispatch");
    write_fixtures(&state);
    let mut records = Vec::new();

    for case in local_cases().as_array().unwrap() {
        let (name, args) = (case[0].as_str().unwrap(), &case[1]);
        if name == "@session" {
            match args.as_str() {
                Some(raw) => std::fs::write(&state.session_path, raw).unwrap(),
                None => write_json(&state.session_path, args),
            }
            records.push(json!({ "session": args }));
            continue;
        }
        let queued_before = read_lines(&state.commands_path).len();
        events.lock().unwrap().clear();
        let mut record = call(&state, name, args).await;
        record["tool"] = json!(name);
        record["args"] = args.clone();
        let queued = read_lines(&state.commands_path).split_off(queued_before);
        if !queued.is_empty() {
            record["queued"] = json!(queued);
        }
        let emitted = std::mem::take(&mut *events.lock().unwrap());
        if !emitted.is_empty() {
            record["events"] = json!(emitted);
        }
        records.push(record);
    }

    // What the file-backed tools left on disk, byte for byte (field order
    // and trailing newline included), fresh ids masked.
    for path in [&state.templates_path, &state.dictionary_path] {
        let raw = std::fs::read_to_string(path).unwrap();
        let lines: Vec<String> = raw.split('\n').map(mask_ids_and_now).collect();
        records
            .push(json!({ "file": path.file_name().unwrap().to_string_lossy(), "lines": lines }));
    }

    // The frontend RPCs, concurrently (each waits out at least one poll).
    events.lock().unwrap().clear();
    let frontend = spawn_fake_frontend(state.commands_path.clone(), state.results_path.clone());
    let cases = rpc_cases();
    let calls = cases.as_array().unwrap().iter().map(|case| {
        let state = &state;
        async move {
            let name = case[0].as_str().unwrap();
            let mut record = call(state, name, &case[1]).await;
            record["tool"] = json!(name);
            record["args"] = case[1].clone();
            record
        }
    });
    records.extend(futures_util::future::join_all(calls).await);
    frontend.abort();
    let woken = std::mem::take(&mut *events.lock().unwrap());
    assert_eq!(woken.len(), cases.as_array().unwrap().len());
    assert!(woken
        .iter()
        .all(|e| *e == json!({ "event": "session://commands", "payload": null })));

    let mut records = Value::Array(records);
    normalize(&mut records, now);
    let _ = std::fs::remove_dir_all(&dir);
    assert_snapshot("dispatch.json", &records);
}

#[test]
fn the_dispatch_cases_cover_every_tool() {
    let covered: std::collections::HashSet<String> = rpc_cases()
        .as_array()
        .unwrap()
        .iter()
        .chain(local_cases().as_array().unwrap())
        .filter_map(|c| c[0].as_str().map(str::to_string))
        .collect();
    for tool in tools() {
        let name = tool["name"].as_str().unwrap();
        assert!(covered.contains(name), "no dispatch case for {name}");
    }
}

#[tokio::test]
async fn json_rpc_methods_answer_and_record_activity() {
    let (state, dir, _) = harness("rpc");
    let init = handle_method(
        &state,
        "initialize",
        json!({ "clientInfo": { "name": "claude", "version": "1" } }),
    )
    .await
    .unwrap();
    assert_eq!(
        init,
        json!({
            "protocolVersion": "2025-06-18",
            "serverInfo": { "name": "parley", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": { "listChanged": false } }
        })
    );
    assert_eq!(
        handle_method(&state, "ping", json!({})).await.unwrap(),
        json!({})
    );
    assert_eq!(
        handle_method(&state, "tools/list", Value::Null)
            .await
            .unwrap(),
        json!({ "tools": tools() })
    );
    assert_eq!(
        handle_method(&state, "notifications/initialized", Value::Null)
            .await
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        handle_method(&state, "resources/list", Value::Null)
            .await
            .unwrap_err()
            .to_string(),
        "unsupported MCP method: resources/list"
    );
    handle_method(&state, "tools/call", json!({ "name": "list_todos" }))
        .await
        .unwrap();
    let err = handle_method(&state, "tools/call", json!({ "name": "add_todo" }))
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "missing string field: text");
    assert_eq!(
        handle_method(&state, "tools/call", json!({}))
            .await
            .unwrap_err()
            .to_string(),
        "missing tool name"
    );

    let a = state.activity.snapshot().await;
    assert_eq!(a["client"], json!({ "name": "claude", "version": "1" }));
    assert!(a["lastRequestAt"].is_u64());
    let recent: Vec<Value> = a["recent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let mut e = e.clone();
            e.as_object_mut().unwrap().remove("at");
            e
        })
        .collect();
    assert_eq!(
        recent,
        vec![
            json!({ "tool": "?", "kind": "read", "ok": false, "error": "missing tool name" }),
            json!({ "tool": "add_todo", "kind": "write", "ok": false, "error": "missing string field: text" }),
            json!({ "tool": "list_todos", "kind": "read", "ok": true }),
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_activity_feed_keeps_the_latest_calls_only() {
    let (state, dir, _) = harness("cap");
    for _ in 0..(ACTIVITY_CAP + 5) {
        handle_method(&state, "tools/call", json!({ "name": "list_todos" }))
            .await
            .unwrap();
    }
    let feed = state.activity.snapshot().await;
    assert_eq!(feed["recent"].as_array().unwrap().len(), ACTIVITY_CAP);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_fresh_results_file_is_scanned_for_the_matching_id_only() {
    let (state, dir, _) = harness("results");
    std::fs::write(
        &state.results_path,
        "{\"id\":\"a\",\"ok\":true,\"data\":1}\nnot json\n{\"id\":\"b\",\"ok\":false,\"error\":\"x\"}\n",
    )
    .unwrap();
    assert_eq!(
        find_result(&state.results_path, "b"),
        Some(json!({ "id": "b", "ok": false, "error": "x" }))
    );
    assert_eq!(find_result(&state.results_path, "c"), None);
    let _ = std::fs::remove_dir_all(&dir);
}
