# Parley for iOS

Native SwiftUI companion app — real-time AI coaching for **in-person** meetings. The Mac app (repo root) owns online calls (it can tap system audio); the phone owns the room.

Lives in the main repo as `ios/` alongside the desktop app, `android/`, and `website/`. The cloud backend stays in the private parley-internal repo; this app talks to it only through the public sync contract.

**Status: 1.1 on the App Store; 1.2 in preparation.** The app records in-person meetings, transcribes them live through the hosted relay, syncs them to the account, and ships a voice-typing keyboard extension. `ParleyKit` holds the transcript core, ported line-for-line from the desktop's Rust with matching unit tests:

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

## Localization

The app ships in **English and Traditional Chinese**, same rule as the desktop
(`CLAUDE.md`): every user-facing string needs both, and the Chinese is a peer of
the English, not a translation afterthought. Source strings are English —
repository English is a repo-wide convention — and the translations live in
String Catalogs:

```
App/Parley/Localizable.xcstrings     App/Parley/InfoPlist.xcstrings
Keyboard/Localizable.xcstrings       Keyboard/InfoPlist.xcstrings
```

Adding a string: write the English inline (`Text("Start recording")`, or
`String(localized:)` where a plain `String` is needed — `Text(String)` does
**not** localize), then add the `zh-Hant` entry to the catalog. A key with no
`zh-Hant` entry silently renders English on a Chinese phone, so it is not
something the compiler will catch for you. `knownRegions` in `project.yml` is
what decides which locales compile at all.

The language a user gets follows iOS. Settings has a Language row that deep-links
to the system per-app picker rather than keeping a competing in-app switch that
could only take effect on next launch.

## App Store screenshots

```bash
AppStore/capture-screenshots.sh      # both locales, six frames each
```

Driven by a `#if DEBUG` demo mode (`App/Parley/ScreenshotDemo.swift`) that serves
fictional fixtures and is navigated by `parley://demo/…` URLs — no review
account, no network, no taps. See [`AppStore/screenshots/README.md`](AppStore/screenshots/README.md).

## License

Apache-2.0, same as the desktop app.
