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

| Model id | Size | Min RAM | Heavy | Pitch |
|---|---|---|---|---|
| `whisper-large-v3-turbo-q5_0` | ~574 MB | 8 GB | yes | Recommended default: fast and accurate in 90+ languages |
| `whisper-small-q5_1` | ~190 MB | 4 GB | no | Lightweight, lower accuracy, good for older machines |
| `whisper-large-v3-turbo-q8_0` | ~874 MB | 8 GB | yes | Higher accuracy, larger |
| `breeze-asr-25-q5_0` | ~1.08 GB | 8 GB | yes | Best for Taiwanese Mandarin and Mandarin/English code-switching |

"Min RAM" and "Heavy" are the catalog's `min_ram_bytes` / `heavy` (see
[Hardware fit](#hardware-fit)).

The picker lists the default first, then by size. Sizes use decimal units
(`formatModelSize`).

## UX rules

1. **Choose first, then download.** Selecting a model only writes
   `settings.localSttModel` (default `whisper-large-v3-turbo-q5_0`) and sets
   `settings.localSttModelChosen`. It may name a model that is not on disk yet.
   Until the user has chosen, the setting follows the hardware recommendation
   (see [Hardware fit](#hardware-fit)); an explicit choice, or a model that is
   already downloaded, is never changed for them.
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
5. **Hardware warnings never gate a ready model.** The onboarding gate and the
   start gates depend only on "installed and not downloading"; a "may be slow"
   or "not enough memory" verdict on an installed model is shown, never enforced.

All readiness logic lives in `src/lib/transcription/localModels.ts`
(`isLocalModelReady`, `checkLocalModelReady`, `reduceLocalProgress`); the React
state is `useLocalSttModels` (`src/lib/transcription/useLocalSttModels.ts`); the
shared UI is `src/components/LocalSttModelPicker.tsx`.

## Hardware fit

A user can pick a model their machine cannot run: too little RAM, no GPU
acceleration (so it decodes slower than real time), or not enough free disk to
download it. Two layers catch that.

### Layer 1 — before download (static)

`local_stt_hardware` reads the machine (`src-tauri/src/hardware.rs`, hand-rolled
OS calls rather than `sysinfo`, which would put a second major version of the
`windows` crate on Windows):

| Field | macOS | Windows |
|---|---|---|
| `totalRamBytes` | `sysctl hw.memsize` | `GlobalMemoryStatusEx.ullTotalPhys` |
| `availableRamBytes` | free + inactive + purgeable + speculative pages (`host_statistics64`) | `ullAvailPhys` |
| `freeDiskBytes` | `statfs` on the models volume | `GetDiskFreeSpaceExW` |
| `cpuCores` | `sysctl hw.physicalcpu` | `GetLogicalProcessorInformationEx(RelationProcessorCore)` |
| `accel` | `"metal"` on Apple Silicon, `"cpu"` on Intel | `"cpu"` |

The models directory is created before measuring so its own volume is read
(a missing path falls back to its nearest existing ancestor). `accel` comes from
the same constant (`local_stt::GPU_ACCEL`) that decides `use_gpu` when a model is
loaded and whether live interim tails are decoded, so the report always matches
what whisper.cpp does. Intel Macs decode on the CPU: their integrated GPUs are
no faster under Metal.

Each catalog entry is judged by a pure function, `local_stt::model_fit`, and
`local_stt_models` returns the verdict as `fit`:

| Reason | Rule | Level | UI |
|---|---|---|---|
| `disk_low` | not installed and free disk < size + 512 MiB | `unsupported` | Download disabled, with "needs X free, Y available". `local_stt_download` re-checks and refuses, because the UI's numbers can be stale. |
| `ram_low` | total RAM < `min_ram_bytes` (with a 1/16 allowance: an "8 GB" PC that reports 7.7 GiB after an iGPU carve-out counts as 8) | `unsupported` | Strong warning; Download becomes a two-step **Download anyway**. The backend does not refuse. |
| `ram_tight` | available RAM < 2 × size (skipped while the model is already loaded) | `slow` | Amber note, nothing blocked |
| `cpu_only` | `heavy` model, `accel` = cpu, and not (≥ 8 physical cores and ≥ 16 GB) | `slow` | Amber note, nothing blocked |

Reasons are listed most severe first; the card shows the first one with its
numbers ("Needs 8 GB of RAM; this Mac has 4 GB"). Everything else is `good`
("Runs well").

`min_ram_bytes` budget: a meeting runs two sessions (mic and system audio) on
one shared set of weights, each with its own decoding state (KV caches and
compute buffers, ~0.3 GB for small, 0.5–1 GB for the large-v3 class). Resident
use is ≈ 0.8 GB for small, ≈ 2–2.5 GB for turbo and ≈ 3–3.5 GB for Breeze (a
large-v2 fine-tune with the full 32-layer decoder), next to the webview and an
OS that wants several GB of its own. Breeze on CPU passes the "strong CPU" rule
but is the slowest model there; the runtime check below is the backstop.

**Recommendation.** `local_stt_hardware` also returns `recommendedId`: the
default when it is a `good` fit, else the largest `good` whisper-family model,
else `null`. The frontend tags it "Recommended for this computer"
(`autoLocalModelChoice` in `localModels.ts`) and, for a user who has never
chosen, moves `localSttModel` to it — or to Breeze when the UI language is
zh-TW and Breeze is a `good` fit.

**Unknown hardware.** If the probe fails, `fit` is `null` and `local_stt_hardware`
rejects: the picker shows no badges, no recommendation tag beyond the catalog
default, and blocks nothing.

The picker reads the hardware with the catalog: when it opens and whenever a
download settles (free disk moved). The last report is cached for the next
picker to open.

### Layer 2 — at runtime (measured)

Every session times its **final** decodes (`transcription::local::RtfTracker`;
interim decodes re-decode a growing utterance and are not counted). The real-time
factor is decode wall time ÷ audio duration. Once at least 3 decodes of ≥ 2 s
of audio have been timed, a rolling median over the last 5 above 0.9 means the
decoder cannot keep up: the session logs it and emits `local-stt://slow`
`{ model, rtf }` — once per session. The batch (upload) arm uses the same
tracker per file.

The main window (host of both meetings and voice typing) listens
(`listenForLocalSttSlow`, `src/lib/transcription/localAlerts.ts`) and shows ONE
toast per app run, only while the provider is still `local`: "Your computer is
struggling to keep up with this model. Switch to a smaller model in Settings ›
Transcription", with **Open settings**.

### Load failures

whisper.cpp reports an allocation failure as a bare init error. When creating
the model context or a decoding state fails and the machine is short on memory
(`ram_low`, or available < 2 × size), the error becomes "Local transcription:
not enough memory to load model …" instead of the raw failure.

## IPC contract

Commands (`invoke`):

| Command | Args | Result |
|---|---|---|
| `local_stt_models` | — | `LocalSttModel[]`: `{ id, family: "whisper" \| "breeze", sizeBytes, installed, downloading, minRamBytes, diskNeededBytes, heavy, fit: { level: "good" \| "slow" \| "unsupported", reasons: ("disk_low" \| "ram_low" \| "ram_tight" \| "cpu_only")[] } \| null }` |
| `local_stt_hardware` | — | `{ totalRamBytes, availableRamBytes, freeDiskBytes, accel: "metal" \| "cpu", cpuCores, os, arch, recommendedId: string \| null }`; rejects when the hardware cannot be read |
| `local_stt_download` | `{ modelId }` | resolves once downloaded and SHA-256 verified; rejects with a string error (including when cancelled, and up front when free disk < size + 512 MiB) |
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

Event `local-stt://slow`, at most once per session: `{ model: string; rtf: number }`.

Session failures (`meeting://error`, `voicetyping://error`) of the local
provider carry one of three codes (`local_stt::failure_code`), all final (never
redialled), each with its own localized toast / overlay message pointing at
Settings › Transcription:

| Code | When |
|---|---|
| `local-missing` | the model is not downloaded |
| `local-memory` | the model could not be loaded for lack of memory |
| `local` | any other on-device failure |

Uploads get the same split from the rejected `transcribe_file` message
(`localFailureCode`).

Sessions: with `transcriptionProvider === "local"` the existing commands
(`start_meeting`, `start_voice_typing`, `transcribe_file`) receive
`provider: "local"`, `apiKey: "local"` (a sentinel so the shared non-empty-key
gates pass; the backend ignores it) and `model: <settings.localSttModel>`. Other
providers send `model: null`. No relay or batch URL is sent.
