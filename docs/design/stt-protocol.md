# Parley hosted STT protocol v2

Goal: the hosted ("parley") transcription service speaks a Parley-owned protocol,
so no client can tell which vendor runs behind it and the vendor can be swapped
server-side without a client release. v1 (`/stt/stream`, a transparent pass-through
of the vendor's wire protocol) stays up unchanged for installed clients.

**Public-repo rule:** in pathorsAI/parley (PUBLIC) no code, comment, doc, commit
message or PR text may say or imply which vendor runs the hosted service. The
vendor may still be named where it is a user-selectable BYOK provider (its own
adapter, settings label, BYOK docs). The hosted path must not reuse the BYOK
vendor adapter.

## Streaming — `wss://api.parley.tw/stt/v2/stream`

Same auth, query parameters, quota gating and per-session cap as v1
(`Authorization: Bearer <cloud token>`). Only the frames differ.

### Client → server

1. **Start** (first text frame, required before any audio):
   ```json
   {"type":"start",
    "audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},
    "languages":["zh","en"],
    "diarization":true,
    "endpointing":true,
    "hints":{"terms":["Parley","派斯"]}}
   ```
   `languages`, `diarization` (default false), `endpointing` (default true) and
   `hints` are optional. Unknown fields are ignored. Only `pcm_s16le`/16000/1 is
   supported today; anything else → `error` `bad_request`.
2. **Audio**: binary frames, raw PCM as declared.
3. `{"type":"keepalive"}` — no-op that keeps the session alive while no audio flows.
4. `{"type":"finalize"}` — finalize everything received so far. The server answers
   with any remaining tokens as final, then `{"type":"finalized"}`. Audio may continue.
5. `{"type":"end"}` — no more audio. The server finalizes, flushes the tail,
   sends `{"type":"done"}` and closes 1000. (A client that simply closes its socket
   is treated as `end`, but then cannot receive the tail — clients should send `end`
   and read until `done`/close.)

### Server → client (all text frames, JSON)

- `{"type":"ready","session_id":"<id>"}` — once, after the start frame is accepted
  and the upstream is open. Clients may use it as "connected" for settle timing.
- `{"type":"transcript","tokens":[Token...],"final_audio_ms":1234,"total_audio_ms":1500}`
  - `Token = {"text":"你好","start_ms":0,"end_ms":320,"final":true,"speaker":1,"language":"zh","confidence":0.97}`
  - `speaker` (integer ≥1) present only with diarization; `language`, `confidence` optional.
  - Same semantics as before: final tokens are appended once and never repeated;
    non-final tokens are the current tentative tail and are replaced by the next frame.
  - Never contains marker/control tokens. A frame with zero tokens is not sent
    (unless the audio-ms counters are the only change — then it may be omitted).
  - Text is already in the user's script (the server-side Simplified→Traditional pass
    still applies).
- `{"type":"endpoint"}` — the speaker paused; the final tokens so far close an utterance.
- `{"type":"finalized"}` — answer to `finalize` (or to `end`): every token up to here is final.
- `{"type":"done"}` — the stream is complete; the server then closes with 1000.
- `{"type":"error","code":"<code>","message":"<vendor-free English text>"}` — then the
  server closes. Codes / close codes:

  | code | close | when |
  |---|---|---|
  | `bad_request` | 4400 | malformed/missing start frame, unsupported audio |
  | `quota_exceeded` | 4402 | the per-session cap or the account quota is hit |
  | `idle_timeout` | 4408 | no audio/keepalive for the idle window |
  | `upstream_unavailable` | 1011 | the recognizer failed or could not be reached |
  | `internal` | 1011 | anything else |

  `message` must never contain the vendor's name, model id, URL or raw error text.

Ordering: when one upstream message yields tokens plus markers, the server sends the
`transcript` frame first, then `endpoint`/`finalized` in the order the markers
appeared, then `done` if the upstream finished.

## Batch (file transcription)

Existing upload / poll / transcript routes stay. v2 changes:
- Upload accepts vendor-neutral options: `languages`, `diarization`, `hints.terms`
  (in whatever carrier the route uses today — query or JSON — mirrored with neutral names).
- The transcript route with `?format=parley` returns
  `{"tokens":[{"text","start_ms","end_ms","speaker","language","confidence"}]}`
  — the same token shape as streaming minus `final`, no marker tokens, already
  script-converted. Without `format=parley` the route behaves exactly as today (v1).
- Error bodies are `{ "error": "<code>" }` with vendor-free codes (already true).

## Implementation clarifications (binding for clients)

Decided while implementing the server (parley-internal `apps/cloud/src/sttV2.ts`,
`stt.ts`). Where the text above was silent or ambiguous, this is what the server does.

**Connecting**
- Rejections before the WebSocket upgrade are plain HTTP, exactly as in v1, because
  there is no socket yet to carry a frame: `426` (not an upgrade), `401`
  `{"error":"unauthorized"}`, `402` `{"error":"quota_exhausted"}` (account quota already
  used up), `429` `{"error":"too_many_sessions"}`. Clients must handle a failed
  handshake with these statuses. The `quota_exceeded`/4402 frame is for quota hit
  *during* a session (the per-session cap, or the absolute session watchdog).
- If the recognizer cannot be reached, the upgrade still succeeds and the client gets
  `error` `upstream_unavailable` + close 1011 immediately (v1 answered a bare 502).
  Nothing is billed.
- `ready.session_id` is Parley's own session id (useful in bug reports), not a vendor id.

**Client frames**
- Before `start`: `keepalive` is accepted (resets the idle timer); `end` gets `done` +
  close 1000; anything else (audio, `finalize`, an unknown type, non-JSON) is
  `bad_request`. A second `start` is `bad_request`.
- After `start`: unknown `type`s are ignored (forward compatibility); text that is not a
  JSON object is `bad_request`.
- Optional start fields that are present with the wrong type (e.g. `"diarization":"yes"`,
  `"languages":"zh"`) are `bad_request`, not silently dropped. `null` counts as absent.
  Empty strings in `languages` / `hints.terms` are dropped.
- Idle window: 90 s. Audio and `keepalive` reset it; `finalize` does not. While no audio
  flows, send `keepalive` every few seconds (the recognizer has its own, shorter
  no-traffic timeout, which also surfaces as `idle_timeout`).
- After `end`, further client frames (including audio) are ignored.
- Closing the socket without `end` is treated as `end`; the server keeps the recognizer
  open ~3 s to finish, then closes. Billing is the audio actually received either way.

**Server frames**
- **Clearing the tentative tail.** "A frame with zero tokens is not sent" has one
  exception: when the previous `transcript` carried non-final tokens and the recognizer
  now has none (it finalized or retracted its guess), the server sends
  `{"type":"transcript","tokens":[]}` so the client drops the stale tentative text.
  Clients must treat `tokens: []` as "the tentative tail is now empty".
- `final_audio_ms` / `total_audio_ms` are optional; they are present when the
  recognizer reported them for that frame.
- Token `start_ms`/`end_ms` are always present (0 if unknown). `speaker` is present only
  when it is a valid integer ≥ 1; `language` and `confidence` only when known.
- **`end` always yields `finalized` then `done`.** If the client sent `finalize` shortly
  before `end`, it may receive two `finalized` frames (one per request); both are
  harmless. `finalized` answers `finalize` in request order.
- If the recognizer has not finished within 10 s of `end`, the client gets `error`
  `upstream_unavailable` (1011) instead of `done`; tokens already marked final are good.
- Close reasons are the code names: `done` for 1000, otherwise the `error` code
  (`bad_request`, `quota_exceeded`, `idle_timeout`, `upstream_unavailable`, `internal`).
- A recognizer rejection of the start settings (e.g. a language code it does not
  support) is reported as `bad_request` (4400) with a generic message, after `ready`.

**Batch**
- Upload carrier is the query string, as in v1: `languages=zh,en` (comma-separated
  and/or repeated), `diarization=1` or `diarization=true`, `terms=Parley&terms=派斯`
  (repeated and/or comma-separated; a term cannot contain a comma). The v1 names
  (`language_hints`, `diarization=1`) keep working; `languages` and `language_hints`
  are merged if both are given.
- `?format=parley` applies to `GET /stt/batch/:id/transcript` only. Any other `format`
  value, or none, is the unchanged v1 body. The parley body carries no `startMs`/`endMs`
  camelCase mirror and no `final` field; `speaker` is an integer.

## Rollout

1. parley-internal: ship v2 alongside v1, deploy.
2. Clients (desktop macOS/Windows, iOS ParleyKit, Android parleykit): hosted mode
   switches to v2 through a dedicated `parley` protocol adapter; BYOK vendor adapters
   stay as they are. Remove every code comment/doc in the public repo that says
   hosted mode speaks/proxies a specific vendor.
3. v1 stays until telemetry shows no v1 sessions for 30 days.
