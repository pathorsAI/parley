# The app layer — screens, sessions, service

What sits on top of the four documented layers (`api-parleykit.md`,
`api-cloud.md`, `api-audio.md`): the Compose UI, the two capture *sessions*, and
the foreground service that keeps a live meeting alive.

```
com.pathors.parley
  ParleyApplication.kt   AppContainer — the whole dependency graph, one per process
  MainActivity.kt        the single activity; also the parley:// sign-in hand-off
  meeting/
    MeetingService.kt    foreground service (type=microphone) + its notification
    MeetingSession.kt    live capture: mic → encoder + relay → segments → upload
    ImportSession.kt     imported file: decoder → encoder + relay → … → upload
  ui/
    ParleyRoot.kt        sign-in wall, NavHost, the SAF picker
    SignInScreen.kt      Custom Tab hand-off
    HomeScreen.kt        library + pending queue + the two "add" actions
    HomeViewModel.kt     library state, account state, sign-out
    AccountSheet.kt      email, plan usage (GET /me/usage), sign out
    MeetingScreen.kt     permission gate, live transcript, level meter, stop
    ImportScreen.kt      progress + phase label + cancel
    RecordingDetail*.kt  read-only transcript, findings, action items
    Format.kt            duration/clock/date/speaker-label formatting
    theme/Theme.kt       Material 3, dynamic color on API 31+
```

## Dependency wiring

`AppContainer` is a hand-written service locator built in
`ParleyApplication.onCreate`. There is no DI framework: the graph is
`AuthManager` → `CloudClient` → `PendingUploadQueue` → `MeetingUploader`, plus an
application-scoped `CoroutineScope` and the "currently running import" holder.
Composables reach it through `rememberContainer()`; the service through
`context.parleyContainer`.

`AppContainer.appScope` exists for work that must outlive whoever asked for it:
the pending-upload drain on launch, and the tail end of stopping a meeting (which
finalizes the Ogg file and uploads it *while the service is stopping itself*).

## Who owns a recording

Both sessions expose the same shape — `StateFlow` for state, segments and
progress — and both fan one PCM stream out to two sinks:

```
MicCapture / AudioFileDecoder ──ByteArray──┬──▶ OggOpusEncoder.append  ──▶ .ogg
                                           └──▶ SttRelayClient.sendPcm ──▶ segments
```

Segments are **upserted by id**, never appended: the relay re-emits a growing
committed run under the same `mix-N` id, and the tentative `mix-tail` row is
cleared by an empty-text emission. Only finals (tail excluded) are handed to
`MeetingUploader.enqueue`.

Differences that matter:

| | `MeetingSession` | `ImportSession` |
|---|---|---|
| Lives in | `MeetingService` (`activeSession`) | `AppContainer.activeImport` |
| Source | `MicCapture`, realtime | `AudioFileDecoder`, faster than realtime |
| `source` field | `live` | `upload` |
| Under 2 s | dropped by the uploader (iOS parity) | **never dropped** — the user picked it |
| Backpressure | none needed | `sendPcm` suspends past 1 MB queued, which throttles the decoder |

A relay failure mid-session (quota, error, unexpected close) does **not** stop a
meeting: the mic keeps running, the audio is still saved and uploaded, and the UI
shows a `TranscriptionIssue` banner. Only microphone and encoder failures produce
a `MeetingState.Failed`.

## The service

`MeetingService` is a `foregroundServiceType="microphone"` service, which is what
buys the app the right to hold the mic in the background — without it Android
feeds a backgrounded app silence. It owns nothing: the session is published on
`MeetingService.activeSession` (process-scoped) so a screen can rebind to a
recording that started before it existed, and so the state flow keeps reporting
`Uploading → Finished` after `stopSelf()`.

Lifecycle: `MeetingService.start(context)` (only once RECORD_AUDIO is granted) →
`requestStop(context)` from the stop button or the notification action →
`clear()` once the UI has read the final state. The ongoing notification uses the
platform chronometer (`setUsesChronometer`), so nothing wakes up to redraw a
clock.

An import runs without a service: it is a foreground task the user is watching,
and its temporary files live in `cacheDir`, so a killed process leaves nothing
behind.

## Navigation and state

Single activity, `androidx.navigation-compose`, four routes: `home`, `meeting`,
`import`, `recording/{id}`. The sign-in wall sits *in front of* the graph and is
driven by whether a token is stored (`AuthManager.isSignedIn`) — being offline
must never look like being signed out; a dead session arrives as a 401, which
clears the token from one place and swaps the wall back in. The one thing that
bypasses the wall is the debug-only screenshot demo mode, below.

ViewModels (`lifecycle-viewmodel-compose`, built through
`viewModelFactory { initializer { … } }`) are used where a screen has state worth
surviving recomposition and rotation: the library and the recording detail. The
meeting and import screens have no ViewModel of their own — their state belongs
to a session that outlives the screen entirely.

## Strings

Every user-visible string is in `res/values/strings.xml` **and**
`res/values-zh-rTW/strings.xml`. A string in only one of them is a bug. Failure
enums (`MeetingFailure`, `ImportFailure`, `HomeError`, `TranscriptionIssue`)
exist precisely so the session layer never holds display copy — the screen maps
the enum to a resource.

## Screenshot demo mode

`screenshot/DemoMode.kt` is the Android half of iOS `ScreenshotDemo.swift`: a
debug-only, in-memory flag that stands the sign-in wall down without a token and
answers every cloud call from fixed fictional fixtures. It exists because the
store listing needs populated screens, and the alternative — signing a device
into a live account — puts real customer data one mis-tap away from a public
listing and cannot be reproduced exactly next release.

It is driven entirely by deep links, because input automation on an emulator is
unreliable and `am start` is not:

```bash
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/library'"
#                                                    ^ the inner quotes matter
```

| URL | Screen |
| --- | --- |
| `parley://demo/library` | The recordings list, populated |
| `parley://demo/transcript` | The featured recording: transcript, findings, action items |
| `parley://demo/record` | The live meeting, mid-transcript (alias: `meeting`) |
| `parley://demo/account` | The library with the account sheet open (alias: `settings`) |
| `parley://demo/off` | Leave demo mode |

Three invariants, all worth keeping: **no network** (every call site is guarded,
so an offline machine captures the same frames), **no writes** (nothing reaches
the auth DataStore or the pending-upload queue, and the live screen runs a
scripted `DemoMeetingSession` rather than the microphone and the foreground
service), and **no residue** (the flag is in memory, so `off` or a restart is
the whole clean-up). `BuildConfig.DEBUG` gates activation, so a release build
cannot be talked into serving fixtures.

Fixture copy is written separately in English and Traditional Chinese and picked
by the device locale, because the screenshot sets are captured per-locale —
switch with `adb shell cmd locale set-app-locales com.pathors.parley --locales
zh-TW`.

## Known gaps

- **No audio playback.** `RecordingDetailScreen` renders the transcript only;
  `CloudClient.downloadAudio` is one call away but a player, a scrubber and
  transcript-follow are their own piece of work.
- **No raw-PCM fallback** when a device has no Opus encoder
  (`OpusEncodeException.EncoderUnavailable`): the recording fails instead. See
  `api-audio.md`.
- **Folders and organizations** are not surfaced, matching the cloud client's
  current scope.
