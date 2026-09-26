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
  library/
    LibraryFolders.kt    folder pages, the orphan→Unfiled rule, scope fallback (pure)
    SaveDestination.kt   personal / personal folder / org / org folder, and its tag form
    SaveLocationStore.kt "Default save location" (Preferences DataStore `parley_library`)
  ui/
    ParleyRoot.kt        sign-in wall, NavHost, the SAF picker
    SignInScreen.kt      Custom Tab hand-off
    HomeScreen.kt        library: scope switcher, folder chips, pending queue, row
                         menu (folder / share / move to org / delete), the "add" actions
    HomeViewModel.kt     library state (scope, folders, moves, shares), account
                         state, save targets, sign-out
    FolderPickerSheet.kt searchable "Move to folder" sheet with create-as-you-type
    LibraryIcons.kt      folder / new folder / tray / group glyphs (not in core icons)
    AccountSheet.kt      identity, usage, default save location, sync, storage,
                         appearance, language, about, sign out, delete account
    MeetingScreen.kt     permission gate, live transcript, level meter, stop
    ImportScreen.kt      progress + phase label + cancel
    RecordingDetail*.kt  player, transcript + search, findings, action items,
                         re-transcribe, move to folder (personal recordings)
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
shows a `TranscriptionIssue` banner. `MeetingState.Failed` is kept for a
recording that could not be started or saved at all — not signed in, no
microphone, no encoder, no storage headroom, or the hand-off to the upload queue
throwing. A capture that is *interrupted* but left audio behind (the mic taken
away mid-meeting, say) still ends `Finished`, with `interruptedBy` saying why;
see `terminalStateFor` in `meeting/CaptureEnding.kt`.

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
`import`, `recording/{id}?org={orgId}` — the optional `org` is the organization
whose library the row was opened from, because an org recording is read through
`GET /orgs/{org}/recordings/{id}/meta` under an id of its own. The sign-in wall sits *in front of* the graph and is
driven by whether a token is stored (`AuthManager.isSignedIn`) — being offline
must never look like being signed out; a dead session arrives as a 401, which
clears the token from one place and swaps the wall back in. The one thing that
bypasses the wall is the debug-only screenshot demo mode, below.

ViewModels (`lifecycle-viewmodel-compose`, built through
`viewModelFactory { initializer { … } }`) are used where a screen has state worth
surviving recomposition and rotation: the library and the recording detail. The
meeting and import screens have no ViewModel of their own — their state belongs
to a session that outlives the screen entirely.

## Library: scopes, folders, save location

The library mirrors iOS `LibraryView` (and the desktop History window):

- **Scope.** The top-bar title switches between the personal library and each
  organization from `GET /orgs/mine`, showing the account's role. Only present
  when the account belongs to an organization. A scope whose organization is
  missing from a *successful* membership list falls back to personal; a failed
  list keeps the selection (offline is not "removed").
- **Folders.** Chips (All / Unfiled / folders, server order) filter the list,
  and the search narrows whichever page is showing. A `folderId` that names no
  live folder renders under Unfiled with no folder name on the card — the
  desktop's orphan→root rule (`LibraryFolders`, unit-tested).
- **Row menu.** Move to folder… (personal: re-push of the fresh meta; org:
  `PATCH …/folder`; create only in personal scope), Share to organization
  (copy), Move to organization (share, *then* delete the original — a failure
  half-way leaves the original), Delete (scope-aware endpoint and 403 copy).
  Import is personal-only.
- **Recording screen.** An org recording is read-only here: no download, no
  re-transcription, no move — all three write through personal endpoints, as
  on iOS.
- **Default save location** (account sheet) is honoured by `MeetingUploader`
  for live recordings, imports and rescued recordings alike: captured into the
  queue manifest at enqueue, a personal folder is written into the meta, and an
  organization is a personal upload at the root followed by
  `POST /recordings/{id}/share` into the org (and folder) chosen. See
  `api-cloud.md`.

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
| `parley://demo/movetofolder` | The featured recording with the folder picker open over fifteen folders (a review frame, as on iOS) |
| `parley://demo/off` | Leave demo mode |

The fixtures include two personal folders, one organization ("Sales team",
admin) with two folders and a shared library of its own, and a default save
location — so the scope switcher, chips, row menu and account picker are all
capturable. Moves, shares, created folders and the save location are applied to
in-memory copies only.

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

- **No raw-PCM fallback** when a device has no Opus encoder
  (`OpusEncodeException.EncoderUnavailable`): the recording fails instead. See
  `api-audio.md`.
- **Folder management** (rename, delete, org folder create) and **organization
  management** (create, invite, roles) stay on the desktop; the phone files into
  folders and shares into organizations that already exist.
- **An org copy does not follow a transcript backfill.** The share happens right
  after the upload, so if the upload then goes to the backfill queue, the better
  transcript replaces the *personal* copy only — the same behaviour as iOS.
- **Org audio** cannot be downloaded or played from the phone (no org audio
  endpoint in the client), matching iOS.
