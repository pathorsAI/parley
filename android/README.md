# Parley for Android

Native Android companion app, mirroring the iOS app's scope (`../ios/`): sign in
to Parley Cloud, record meetings with live transcription through the hosted STT
relay, **import existing audio recordings for transcription**, and sync finished
recordings to the cloud. Deep analysis (report, action items) runs on the
desktop app when a recording syncs down — same division of labor as iOS.

## Architecture

```
android/
  app/         com.pathors.parley — Compose UI, auth, cloud sync, audio pipeline
  parleykit/   pure-JVM Kotlin port of ios/ParleyKit (SegmentBuilder,
               SonioxProtocol, SttRelayClient) — same semantics, same tests
```

- **Auth**: Custom Tab → `https://api.parley.tw/sign-in?to=parley://auth-callback`
  → deep link back with the session token → `Authorization: Bearer` everywhere.
- **Live meeting**: `AudioRecord` (16 kHz mono s16le) → `SttRelayClient`
  (`wss://api.parley.tw/stt/stream`) → `SegmentBuilder` → live transcript UI.
  Runs in a `microphone` foreground service.
- **Import a recording**: SAF file picker → `AudioFileDecoder`
  (MediaExtractor/MediaCodec + anti-aliased resample to 16 kHz mono) → streamed
  through the same STT relay faster than realtime → segments. Metering is
  byte-based server-side, so quota accounting is identical to live capture.
- **Storage/upload**: finished recordings encode to Ogg/Opus
  (MediaCodec + MediaMuxer, hence minSdk 29) and go through a durable
  pending-upload queue — audio first (`PUT /recordings/:id/audio`), then
  summary+meta (`POST /recordings/:id`), matching iOS `MeetingUploader`.

Module API docs for each layer live in `docs/`.

## Build

Requires JDK 17+ and the Android SDK (API 35).

```bash
cd android
./gradlew :parleykit:test        # core unit tests (pure JVM)
./gradlew assembleDebug          # debug APK
./gradlew installDebug           # onto a connected device/emulator
```

## Release

See [RELEASING.md](RELEASING.md) for signing, Play Console setup, and the
store-listing checklist.
