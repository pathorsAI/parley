# Local transcription (whisper.cpp)

Status: in progress (frontend + backend on `feature/local-transcription`).

## What it is

A seventh speech-to-text provider, `local`, that transcribes on the user's own
computer with whisper.cpp. No audio leaves the machine and no API key is needed;
the only network use is the one-time model download. It is offered in every
build (OSS and official), in Settings › Transcription and in onboarding's
account step.

Trade-offs the UI states up front:

- **No speaker separation.** whisper only transcribes, so the registry entry has
  `diarization: false`, which shows the existing "no diarization" tag and warning.
  Live meetings fall back to me/them by audio source only.
- **First load is slow.** Loading a model into memory takes a few seconds the
  first time it is used in a session.
- **Disk.** Models are 190 MB to 1.1 GB.

## Catalog

The catalog (ids, download URLs, sizes, SHA-256 checksums) is owned by Rust and
returned by `local_stt_models`. The frontend owns only display text, keyed by
model id in `src/i18n/messages.ts` (`localStt.model.*`); an id it does not know
is shown by its raw id rather than hidden.

| Model id | Size | Pitch |
|---|---|---|
| `whisper-large-v3-turbo-q5_0` | ~574 MB | Recommended default: fast and accurate in 90+ languages |
| `whisper-small-q5_1` | ~190 MB | Lightweight, lower accuracy, good for older machines |
| `whisper-large-v3-turbo-q8_0` | ~874 MB | Higher accuracy, larger |
| `breeze-asr-25-q5_0` | ~1.08 GB | Best for Taiwanese Mandarin and Mandarin/English code-switching |

The picker lists the default first, then by size. Sizes use decimal units
(`formatModelSize`).

## UX rules

1. **Choose first, then download.** Selecting a model only writes
   `settings.localSttModel` (default `whisper-large-v3-turbo-q5_0`). It may name a
   model that is not on disk yet.
2. **Never download without a click.** When the selected model is missing, an
   inline callout offers **Download (size)**. While downloading it shows a
   progress bar, percent and **Cancel**; then a "verifying" state; on failure the
   error and **Retry**; after a cancel, **Retry**.
3. **Not usable until fully downloaded.** "Ready" means installed (downloaded and
   checksum-verified) and not currently downloading. Every way of starting
   transcription refuses otherwise, pointing at Settings › Transcription:
   - meetings — `beginMeeting` (`src/lib/meeting/start.ts`), toast with an
     **Open settings** action, before the UI enters "recording";
   - voice typing — `src/lib/voiceTyping/host.ts`, overlay error `no-local-model`;
   - uploads — `transcribeRecording` (`src/lib/replay/ingest.ts`), the wizard's
     error state;
   - onboarding — Next and Skip stay disabled until the selected model is ready
     and no download (of any model) is in flight; see `onboarding.md` D2.
4. **Removal** is a secondary action on an installed model, behind a confirm.

All readiness logic lives in `src/lib/transcription/localModels.ts`
(`isLocalModelReady`, `checkLocalModelReady`, `reduceLocalProgress`); the React
state is `useLocalSttModels` (`src/lib/transcription/useLocalSttModels.ts`); the
shared UI is `src/components/LocalSttModelPicker.tsx`.

## IPC contract

Commands (`invoke`):

| Command | Args | Result |
|---|---|---|
| `local_stt_models` | — | `LocalSttModel[]`: `{ id, family: "whisper" \| "breeze", sizeBytes, installed, downloading }` |
| `local_stt_download` | `{ modelId }` | resolves once downloaded and SHA-256 verified; rejects with a string error (including when cancelled) |
| `local_stt_cancel` | `{ modelId }` | cancels an in-flight download |
| `local_stt_delete` | `{ modelId }` | removes the model file |

Event `local-stt://progress`, broadcast to every window:

```ts
{ modelId: string; stage: "downloading" | "verifying" | "done" | "error" | "cancelled";
  received: number; total: number; message?: string }
```

The frontend re-reads `local_stt_models` whenever a download settles (`done`,
`error`, `cancelled`), so `installed` is always the backend's word, never
inferred from events.

Sessions: with `transcriptionProvider === "local"` the existing commands
(`start_meeting`, `start_voice_typing`, `transcribe_file`) receive
`provider: "local"`, `apiKey: "local"` (a sentinel so the shared non-empty-key
gates pass; the backend ignores it) and `model: <settings.localSttModel>`. Other
providers send `model: null`. No relay or batch URL is sent.
