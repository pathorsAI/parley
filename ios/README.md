# Parley for iOS

Native SwiftUI companion app — real-time AI coaching for **in-person** meetings. The Mac app (repo root) owns online calls (it can tap system audio); the phone owns the room.

Lives in the main repo as `ios/` alongside the desktop app, `website/`, `virtual-mic/`, and `mcp/`. The cloud backend stays in the private parley-internal repo; this app talks to it only through the public sync contract.

**Status: walking skeleton.** `ParleyKit` contains the transcript core, ported line-for-line from the desktop's Rust with matching unit tests, plus a minimal `App/` target (mic capture → 16 kHz mono, demo transcript replay):

- `SegmentBuilder` — speaker-run accumulation, stable segment ids, partial/final tail semantics (port of `src-tauri/src/transcription/common.rs`)
- `SonioxProtocol` + `SonioxStreamParser` — the Soniox realtime wire protocol as spoken through Parley's hosted STT relay (`wss://api.parley.tw/stt/stream`): config frame without vendor key, `keepalive`/`finalize` control frames, `<end>`/`<fin>` endpoint markers, error frames
- `SttRelayClient` — `URLSessionWebSocketTask` relay session honoring the drain rule (never close the socket after `finalize`; the relay flushes the tail first)

Design doc: [`../docs/design/ios-app.md`](../docs/design/ios-app.md). Cloud prerequisites are tracked in parley-internal (Phase 0 epic).

## Architecture (v1)

```
AVAudioEngine ──16k mono s16le──▶ SttRelayClient ──▶ hosted STT relay ──▶ Soniox
                                        │
                                  SonioxStreamParser
                                        │
                                  SegmentBuilder ──▶ live transcript (SwiftUI)
                                        │
                              45s live-coach loop ──▶ /v1/chat/completions
```

The phone records, transcribes live, and coaches live. Deep analysis (report, action items, brief, delivery, intelligence board) stays on the desktop — it runs automatically when the recording syncs there, and the results sync back.

No API keys on the phone by default: signed-in users ride the hosted STT/LLM providers. BYOK keys, if entered, live in the Keychain and never sync.

## Development

```bash
cd ios/ParleyKit && swift test     # core logic runs on macOS — no simulator needed

cd ios/App && xcodegen generate    # then build/run the app (simulator or device)
xcodebuild -project Parley.xcodeproj -scheme Parley \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

The `.xcodeproj` is generated from `App/project.yml` (XcodeGen) and not committed.

## License

Apache-2.0, same as the desktop app.
