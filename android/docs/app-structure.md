# The app layer — screens, sessions, service

What sits on top of the four documented layers (`api-parleykit.md`,
`api-cloud.md`, `api-audio.md`): the Compose UI, the two capture *sessions*,
the foreground service that keeps a live meeting alive, and the voice-typing
keyboard.

```
com.pathors.parley
  ParleyApplication.kt   AppContainer — the whole dependency graph, one per process
  MainActivity.kt        the single activity; also the parley:// sign-in hand-off
  meeting/
    MeetingService.kt    foreground service (type=microphone) + its notification
    MeetingSession.kt    live capture: mic → encoder + relay → segments → upload
    ImportSession.kt     imported file: decoder → encoder + relay → … → upload
  ime/                   the voice-typing keyboard — see "The keyboard" below
    ParleyInputMethodService.kt the input method: one microphone key, composing
                         text while listening, commit on Done, switch-back key
    VoiceKeyboard.kt     the Compose pane (status, clock / countdown, mic key,
                         discard), and the state it draws
    DictationService.kt  foreground service (type=microphone) for one dictation
    DictationSession.kt  one dictation: mic → relay → polish → settled text
    DictationTranscript.kt folds relay segments into one dictated string (pure)
    DictationCountdown.kt the ten-minute cap's last-30-seconds countdown (pure)
    InputFieldGuard.kt   refuses password fields and fields that take no text (pure)
    VoiceTypingSettings.kt cleanup on/off and "keyboard used"
                         (DataStore `parley_voice_typing`)
    VoiceTypingSettingsActivity.kt the keyboard's settings screen; the only place
                         on this path that can ask for RECORD_AUDIO
  library/
    LibraryFolders.kt    folder pages, the orphan→Unfiled rule, scope fallback (pure)
    SaveDestination.kt   personal / personal folder / org / org folder, and its tag form
    SaveLocationStore.kt "Default save location" (Preferences DataStore `parley_library`)
  onboarding/
    GettingStartedStore.kt the library checklist's state (DataStore `parley_onboarding`)
    SampleRecordingStore.kt the bundled sample's local-only library entry and audio
    LapCelebrations.kt   which recordings' lap finish has had its burst
                         (SharedPreferences `parley_lap_motion`)
    AnnouncementStore.kt which What's New announcements this phone has seen
                         (DataStore `parley_announcements`)
    WhatsNewPresenter.kt when the What's New sheet may come up
  study/
    StudyPass.kt         the study pipeline (findings, action items, brief,
                         delivery) on the hosted model, one per process
    StudySettings.kt     "Analyze recordings automatically" (DataStore `parley_study`)
  ui/
    ParleyRoot.kt        sign-in wall, NavHost, the SAF picker; the recording
                         route's `guided` argument; OpenFor
    OnboardingScreen.kt  the sign-in page: headline, intro film, sign-in button
    IntroStage.kt        the sign-in page's ~7 s film of the lap (IntroFilm)
    SignInScreen.kt      Custom Tab hand-off
    HomeScreen.kt        library: scope switcher, folder chips, pending queue, row
                         menu (download / folder / share / move to org / delete),
                         the import notice, the "add" actions
    HomeViewModel.kt     library state (scope, folders, moves, shares), account
                         state, save targets, sign-out
    FolderPickerSheet.kt searchable "Move to folder" sheet with create-as-you-type
    GettingStartedList.kt "Do one lap, five minutes" — the checklist rows and header
    GuideBar.kt          the guided lap's bar on the recording page, its done card
                         and confetti
    LapRecording.kt      which recording the guided lap is about (LapRules,
                         LocalLapRecording), the checklist's header action
    HandoffText.kt       the analysis prompt for "Share to AI" / "Copy with analysis
                         prompt", and the chooser callback that ticks the checklist
    LibraryIcons.kt      folder / new folder / tray / group glyphs (not in core icons)
    AccountSheet.kt      identity (initial, name, email, organizations and roles),
                         usage, default save location, sync, storage,
                         appearance, language, about, sign out, delete account
    MeetingScreen.kt     permission gate, live transcript, waveform, mic/storage status, stop
    LiveWaveform.kt      the scrolling level history under the timer (iOS WaveformView)
    WhatsNewSheet.kt     the What's New bottom sheet and its host on the library
    MeetingHaptics.kt    the four recording beats (start, stop, discard, mic lost)
    ImportScreen.kt      progress + phase label + cancel; the failure / partial endings
    RecordingDetail*.kt  player, Report | Transcript pages, transcript search,
                         re-transcribe, move to folder (personal recordings)
    RecordingReportPage.kt the report: analysis chip, brief, action items,
                         timeline analysis, delivery scorecard, speakers
    ReportSections.kt    the generation chip and its menu, the timeline strip,
                         the delivery scorecard
    FilingSuggestionCard.kt the filing suggestion: editable title, folder chips,
                         "Choose another…", Accept / Skip, and its motion
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
the queue drains, and the tail end of stopping a meeting (which finalizes the Ogg
file and uploads it *while the service is stopping itself*).

The queues — pending uploads, then pending re-transcriptions — drain at launch,
after sign-in, at the end of a meeting or an import, and from `upload/AutoSync`,
which `Application.onCreate` starts: a `ConnectivityManager.NetworkCallback` for
networks with *validated* internet, and a `ProcessLifecycleOwner` observer for
the app coming back to the foreground (iOS drains its backfill queue on
`scenePhase == .active` for the same reason — a re-transcription killed by the
screen locking is otherwise only retried at the next cold start). Both go through
`SyncDebouncer`, so a flapping network cannot stack passes. All of this needs a
live process; draining from the background is a WorkManager job nobody has
written yet. The same moments flush the problem-report queue
(`AppContainer.feedback`), signed in or not.

`AppContainer.feedback` (`feedback/FeedbackCenter`) owns problem reports: the
frequency limits every "send us diagnostics?" prompt goes through
(`PromptGate`: two brush-offs → 30 days quiet per trigger, once per recording),
the last process's crash (an uncaught-exception handler installed first thing
in `Application.onCreate`, plus `ApplicationExitInfo` on API 30+, sent
automatically unless the account sheet's switch is off), the screenshot prompt
(`MainActivity` registers a screen-capture callback on API 34+), and the
surfaces `ui/FeedbackHost` draws over every screen — the report sheet, the
crash banner and the five-second notices. Screens raise their own inline
prompts where the fact is known: the recording page (empty / truncated
transcript, the chips after a re-transcription), the library's queued rows
(sync keeps failing), the meeting's end (microphone recovered five or more
times) and the library's delete (a broken recording was deleted).

## Who owns a recording

Both sessions expose the same shape — `StateFlow` for state, segments and
progress — and both fan one PCM stream out to two sinks:

```
MicCapture ──ByteArray──┬──▶ OggOpusEncoder.append ──▶ .ogg
                        └──▶ RelayAudioBridge.send ──▶ SttRelayClient (leg N).enqueuePcm ──▶ segments

AudioFileDecoder ──ByteArray──┬──▶ OggOpusEncoder.append ──▶ .ogg
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
shows a `TranscriptionIssue` line. iOS's split applies (`TranscriptionHealth`):
a dropped socket is `RECONNECTING` — "Transcription dropped — reconnecting…",
an amber spinner — until a leg is back up or a segment arrives, and only when no
leg is coming (out of quota, budget spent, signed out) does the line say the
live transcript stopped, in ink with a bolt rather than the error red, because
the recording itself is fine. `MeetingState.Failed` is kept for a
recording that could not be started or saved at all — not signed in, no
microphone, no encoder, no storage headroom, or the hand-off to the upload queue
throwing. A capture that is *interrupted* but left audio behind (the mic taken
away mid-meeting, say) still ends `Finished`, with `interruptedBy` saying why;
see `terminalStateFor` in `meeting/CaptureEnding.kt`.

On an error or unexpected close `MeetingSession` holds the `RelayAudioBridge`,
retires the dead client and redials on `ReconnectPolicy`'s ladder. The new leg is
created through `bridge.attach`, so it gets its own id prefix (`mix@N`), a
`timeOffsetMs` equal to where the first held chunk was captured, and the held
audio before any live audio — the words spoken during the gap reach the relay
instead of being dropped. When no leg is coming (budget spent, out of quota,
signed out, stop, discard) the bridge drops what it holds. See
`api-parleykit.md`.

An import splits the same failures differently (`meeting/ImportRelayOutcome.kt`),
because the user still holds the source file:

| Relay says | Import does | Screen says |
|---|---|---|
| out of quota (`QuotaExceeded`) | stops, deletes its partial Ogg | `Failed(QUOTA_EXHAUSTED)` — iOS's quota copy |
| handshake 401 (`Error.isUnauthorized`) | stops, deletes its partial Ogg | `Failed(SESSION_EXPIRED)` + "Sign in again", which clears the dead token |
| any other error, a close before `finalize`, a tail that never arrives | keeps decoding, uploads the full audio with the partial transcript | `Finished(transcript = COMPLETES_IN_BACKGROUND)` when the transcript's coverage means the uploader queues a backfill; plain "Done" otherwise |

Only a clean `Finished` closes the screen by itself; one still waiting to upload,
or with a transcript being redone, stays up until it is dismissed. An upload the
cloud refuses for good (see `api-cloud.md`) is `Failed(UPLOAD_REFUSED)`, not
"Done". A 402 on upload is not a refusal: the recording stays queued and the
screen says it will sync once the quota resets (`Finished.waitingForQuota`).

### What the meeting screen says about the microphone

`MeetingScreen` shows one microphone line while recording, in priority order:
`micRecovery` **Lost** (taken by something else, or broken with the platform's
reason), **Recovering**, `micSilenced`, and a four-second "Microphone is back —
still recording" after a recovery — never two at once. `storageLow` adds a
warning line. A `Finished` state with `interruptedBy` set says how the meeting
ended ("Stopped early — lost the microphone" / storage / permission / other) and
stays until the user taps Close. A meeting the user stopped stays up too, as it
does on iOS: the transcript, the outcome in iOS's words ("Synced to the cloud",
"Synced, and shared to “Org”", "You're out of quota…", "Sync failed for now…",
"That recording was too short to keep") and the filing suggestion, until Done or
Back. A settled session found on the next visit is cleared before the new
recording starts rather than shown again. Haptics (`ui/MeetingHaptics`) mark recording started, Stop, Discard and
microphone lost.

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

## The keyboard (voice typing)

`ime/` is a **voice-only** input method: one microphone key that types what the
user says into whichever app has focus. No letter layouts — Android users keep
Gboard for typing, and the switch key hands typing straight back
(`switchToNextInputMethod(false)`). Declared in the manifest as a
`BIND_INPUT_METHOD` service with `res/xml/method.xml` (one voice subtype and the
settings activity).

The lifecycle of one dictation:

```
ParleyInputMethodService.onMicClick
  └─▶ DictationService.start            foreground (type=microphone) first …
        └─▶ DictationSession.start      … then the microphone
              MicCapture ──PCM──▶ SttRelayClient (?feature=voice_typing)
                                    └─▶ segments ─▶ DictationTranscript.live
                                                     └─▶ setComposingText (live, underlined)
            stop (key / cap / keyboard hidden / notification)
              └─▶ relay finish + drain ─▶ fold the tail
                    └─▶ TranscriptPolisher via CloudClient.chatCompletion
                          (if on, ≥ 8 chars, 6 s budget; any failure keeps the raw text)
                          └─▶ DictationState.Done ─▶ commitText ─▶ DictationService.clear
```

- **Why a foreground service.** An input method is never the top app, and
  since Android 11 a process that is not the top app and holds no
  microphone-typed foreground service is fed silence by `AudioRecord`.
  `DictationService` starts under the platform's "current input method"
  exemption from the background-start ban, posts its notification, and only
  then constructs the session. It follows `MeetingService`'s `startForeground`
  contract. `activeSession` is process-scoped so a dictation survives the input
  view being recreated as focus moves.
- **Endings.** `Done` commits the text (the polished text replaces the raw
  composing text in one edit); `Failed` commits what was heard rather than
  snatching it back; `Cancelled` (the discard key, or focus moving to a field
  that refuses dictation) drops the composing text. Hiding the keyboard is a
  stop, not a cancel.
- **The cap.** Ten minutes (`DictationSession.MAX_DURATION_MS`), the same as
  iOS and the desktop. The strip shows elapsed time, then "Stops in N s" for
  the last 30 seconds (`DictationCountdown`); reaching it is an ordinary stop
  with a "limit reached" note afterwards.
- **No reconnect, no file.** A dropped relay ends the dictation with what was
  heard. Nothing is encoded, uploaded or added to the library.
- **Password fields.** `InputFieldGuard` decides; the key is drawn dark *and*
  `onMicClick` refuses, because the drawn state is a frame old.
- **Permission.** An input method has no Activity, so a tap without
  `RECORD_AUDIO` opens `VoiceTypingSettingsActivity`, which asks.
- **"Keyboard used".** The first `onStartInputView` sets a flag in
  `VoiceTypingSettings`; `AnnouncementStore` reads it so `keyboard`-audience
  What's New announcements can show on Android.

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
- **Folders.** Chips (All / Unfiled / folders, server order; iOS's underlined
  labels, not filled Material chips) filter the list,
  and the search narrows whichever page is showing. A `folderId` that names no
  live folder renders under Unfiled with no folder name on the card — the
  desktop's orphan→root rule (`LibraryFolders`, unit-tested).
- **Audio on this phone.** `playback/AudioDownloads` is iOS `AudioDownloadModel`:
  one per process, shared by the row menu's Download / Remove download
  (personal rows only, not the sample), the detail screen's player and
  re-transcription, so a download started from the library shows its progress
  when the recording is opened and a second request joins the first. The row's
  meta line ends with a phone glyph when the file is here, a progress ring while
  it downloads, and "Download failed · Retry" after a failure (the retry is the
  menu). Account sheet › Remove all asks first, with iOS's copy.
- **Import result.** The import keeps its own progress screen; once it lands in
  the cloud, the library shows iOS's green "Imported “X”" (or "… and shared to
  “Org”") line above the list until the next import or a scope switch.
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

## Getting started: the intro film, the checklist, the sample, the hand-off

A port of iOS onboarding v2 (#450; Android's first cut was the v1 checklist of
#435), including the guide bar that walks the lap on the recording page.

- **Sign-in page.** `OnboardingScreen` leads with the iOS headline and subline,
  then `IntroStage`: a ~7 s film that plays once — a recording pill, the
  sample's first three lines typing at 22 ms/char with their speakers, the
  customer folder sliding in and the suggestion card dropping into it, the share
  glyph lighting — with one caption per beat. The schedule is parleykit's
  `LapMotion.introBeats` (unit-tested); the cast is `IntroFilm.of(manifest)`.
  With "Remove animations" on it shows the final frame; TalkBack reads the three
  points iOS gives VoiceOver. The stage has its final height from the first
  frame, and the caption (`IntroCaption`) floats: under the stage when that is
  on screen, else pinned just above the sign-in button (`stickyCaptionTop`).
- **Checklist.** Above the personal library, not while searching: record, put
  it in a folder, replay, share with your AI. Each item ticks only from the real
  event — a recording saved in the upload queue, a successful filing (or a
  folder or an organization chosen as the default save location), a user
  seek in the player, a share target picked (`HandoffShareReceiver`) or "Copy
  with analysis prompt". The rows are plain (no actions); the header has one:
  "Walk through it with the sample recording" while nothing is recorded, else
  "Continue →" (`LapRules.checklistAction`). The walk-through shows a 1.5 s
  "Transcribing…" beat (`HomeViewModel.walkThroughSample`), loads the sample and
  opens it; Continue reopens the lap recording (`LapRules.lapRecording`: the
  sample, else the newest recording). The rules are parleykit's
  `GettingStartedState`; existing users start dismissed (a stored session at the
  first launch of this build, or a full library on the first load). Account
  sheet › About › "Show the getting-started list again" resets it and takes the
  sample out of the library, so the lap restarts from the walk-through.
- **The lap recording.** The recording route carries `guided=true` when the
  screen is the lap's recording: from the checklist's action, or a row that
  `LapRules.isLapRecording` picks (the sample, or the only personal recording).
  Inside the screen it is `LocalLapRecording.current`.
- **Sample recording.** `public/sample/` is copied into the APK's assets as
  `sample/` at build time (`copySampleAssets` in `app/build.gradle.kts`). Loaded,
  it is a local-only row (`SAMPLE` badge) merged into the personal list: the
  detail screen reads the manifest, plays the bundled audio (unpacked to the
  cache), and files it locally. It is never uploaded, and it offers no download,
  re-transcription or organization share; Delete only takes it out of the list.
  It arrives pre-suggested: the store is the recording page's
  `SampleFilingTarget`, and `pendingFilingSuggestion(folders)` offers the
  manifest's title and customer folder (pointing at a live folder of that
  name, if there is one) plus up to two recently used folders until
  `answerSuggestion()` — Skip, or both halves answered. Accept and the chips
  rename (`setTitle`) and file (`setFolder`) the local entry; a new folder is
  still created in the cloud (in demo mode, in memory — the demo walk-through
  offers the card too). Its files are read through a `SampleBundle` (the
  APK's assets; the repository's `public/` in `SampleFilingTest`).
- **The guide bar** (`ui/GuideBar.kt`, iOS `GuideBar.swift`). Pinned to the
  bottom of the recording page — page-coloured, a hairline on top — on the
  lap's recording (the sample, the only personal recording, or a page opened
  `guided`) while the checklist is live. Its step is parleykit's `GuidedLap`,
  derived from the checklist and never stored, so every route to an outcome
  moves it: the first of filed → replayed → shared-to-AI not done yet. A step
  finished while the bar is up is held as a ✓ for 1.5 s ("Renamed and filed
  in “X”…", "Filed in “X”…", "That's it. Search finds…"); one finished out of
  order, or a reset, shows no ✓. The lap lives in `RecordingDetailViewModel`
  (`lap`, one redraw scheduled when a hold ends), so a rotation keeps it.
  - **1 / 3** "Show me" washes the filing card for 1.2 s; with no suggestion
    the button is "Choose a folder" and opens the folder picker.
  - **2 / 3** "Open the transcript" switches to the Transcript page, scrolls to
    the first turn and lights it (#489's jump, without a seek — the step ticks
    when the reader taps a line, which glides the playhead and rings the
    waveform, #484).
  - **3 / 3** lists the three questions the share asks (the sample's own, else
    the generic three) over "Share to AI" and "Copy instead" — the `⋯` menu's
    two hand-offs.
  - Every step has "Not now", which dismisses the checklist.
  - **Done.** The three ✓ lines cascade 260 ms apart, then a success haptic
    and one burst of confetti (26 blue rectangles over 1.5 s, parleykit's
    `LapConfetti`), once per recording ever (`LapCelebrations`, iOS's
    `lapMotion.celebrated.<id>`; "Show the getting-started list again" re-arms
    it with the rest of the lap). "Start your first real meeting" goes to the
    meeting route; "Close" hides the
    bar. With "Remove animations" on, the final state shows at once and nothing
    is thrown.
- **Hand-off.** The recording screen's `⋯` menu leads with "Share to AI (with
  analysis prompt)" and "Copy with analysis prompt": parleykit's `HandoffPrompt`,
  line for line the iOS text (`HandoffStringsParityTest` checks the copy against
  the iOS catalogue). The sample asks the three questions written for its script.

## The player

`playback/PlaybackBar` is iOS `PlaybackBar.swift` behaviour for behaviour
(#366, #381, #450); the arithmetic lives in `playback/ScrubRules.kt` and is
unit-tested.

- **Scrub.** A drag moves the playhead relative to where it was (touching does
  not jump). Moving the finger 40dp / 90dp away from the strip, up or down,
  scales the drag to ¼ ("Fine") and 1/16 ("Finer"), with a tick at each change
  and a floating time pill. The audio seeks live on every move;
  `PlaybackController` conflates the engine seeks to one per 80 ms.
- **Highlights.** `PlaybackBar(markers = …)` takes the findings' `atMs` and
  draws a tappable dot per finding along the strip's top edge.
- **A jump from the text.** A tapped turn calls
  `RecordingDetailViewModel.jumpTo` → `PlaybackController.jumpTo`, which records
  `PlaybackState.jump`. The waveform glides its playhead there over 0.5 s and
  rings the spot for 0.7 s (skipped when the system's animations are removed),
  with a light tick. Scrubs, dots and TalkBack use plain `seekTo`. Both say
  whether the playhead moved, and only a seek that moved it ticks the
  checklist's "replay".
- **Speed.** Tap cycles 1 / 1.25 / 1.5 / 2, long-press offers 0.75–2. The
  choice is kept in SharedPreferences `parley_playback` / `playbackRate` (the
  iOS key) across recordings and launches; in memory in demo mode.
- **Layout.** Full height only when there is a waveform; download offer,
  progress, "Preparing…" and failure (with Retry for a failed download) are one
  44dp row.
- **TalkBack.** The strip is an adjustable control: swipe up/down moves 15 s,
  and the position is spoken as a clock.
## What's New after an update

A port of iOS #478. The copy is the repository's `announcements/` folder,
shared with iOS and the desktop and copied into the APK's assets at build time
(`copyAnnouncementAssets` in `app/build.gradle.kts`); see
`announcements/README.md` for the schema.

- **Which.** parleykit's `AnnouncementGate`: `ships.android` set and at most
  the running `versionName` (numeric by component), audience met (a
  `keyboard` announcement waits until the voice-typing keyboard has been shown
  on this phone — `VoiceTypingSettings.keyboardUsed`, set by
  `ParleyInputMethodService.onStartInputView`), newest only with the older
  ones retired alongside it, and never one already seen.
  `AnnouncementCatalogTest` checks the real folder against the schema.
- **Who never sees one.** A fresh install: `AnnouncementStore` marks everything
  seen on its first launch unless a session was already stored — the same
  first-launch check `GettingStartedStore` makes. It reads only after that
  first write has landed, one-shot, under the same lock as its writes (no
  long-lived collector; see the DataStore race in `GettingStartedStore`).
- **When.** `WhatsNewPresenter`, 600 ms after the signed-in library appears
  or the app comes to the foreground, and not if that foreground was opened by
  a `parley://` link (`MainActivity.handleDeepLink`), a meeting holds the
  microphone, it has already been shown this foreground, or demo mode is on.
  A sheet the app takes down (a link arrived, the library went away) is not
  marked seen; one the user closes in any way is.
- **What.** `ui/WhatsNewSheet.kt`: a Material 3 bottom sheet sized to its
  content — badge, title, body, hairline, "Also" line, one button that follows
  `cta.android` when the announcement has one. The copy's language follows the
  resources the app resolved (`whats_new_copy_language`), so the sheet never
  speaks a different language from the screen under it. No hero registry yet.

## The recording page: Report | Transcript

A port of iOS #450 (`docs/design/ios-recording-page.md`), whose Summary page
became the **Report** when Android started running the study stages itself
(below). Under the pinned player, a segmented control switches two pages;
only the one that is up is composed, but both `LazyListState`s live in
`DetailBody`, so each keeps its scroll position.

- **Which page.** Report when the recording has any analysis (a brief, a
  finding, an action item or a delivery read — `UiState.hasAnalysis`) or the
  study is about to analyse it, Transcript otherwise. Chosen once on the first
  load (`initialFace`), saved across rotation, never flipped by a reload.
  `parley://demo/transcript` stays on the transcript.
- **Report** (`RecordingReportPage.kt`), the desktop's report tab in its
  order: the generation chip (personal recordings), the brief (重點) through
  parleykit's `BriefMarkup` (bold runs, `[m:ss]` links), action items (後續行動;
  ticking only on the sample — `SampleRecordingStore.Entry.doneActionItems`; a
  cloud recording shows its ticks and takes none), the timeline analysis
  (時間軸分析: a strip across the recording with a dot per finding in its
  severity's colour — a tap plays it without leaving the page — then the list
  with severity, side / category and "Resolved by …" where the lens has them),
  the delivery scorecard (評分: pace, talk share, filler sounds, tone tiles
  and the AI read, the desktop's `DeliveryScorecard`), and speakers in order
  of first appearance. Which sections are drawn is `ReportLayout` (tested):
  with the study running here, a section whose artifact is queued, generating
  or failed says so in the desktop's words ("Queued — starts after the action
  items finish"); without it (the sample, an org recording) only sections
  with content show. With no analysis and no way to make one: "No summary
  yet." and "Generate a summary with AI", the Share-to-AI hand-off.
- **Jumps.** Every timestamp on the report switches to the transcript, seeks
  (`jumpTo`), scrolls the turn to the upper third and washes it for 2 s. The
  turn is `TranscriptAnchor`'s — a brief's `[0:08]` names the turn that starts
  at 8.9 s.
- **Transcript.** Turns only (the title is in the top bar); a finding adds a
  lightbulb line under the turn it starts in, which seeks and lights the turn.
  The playing turn's *speaker label* is blue. A seek scrolls to its turn even
  while paused (iOS #381); following during playback stops at a drag and
  resumes on play or seek. Holding a 44dp band at either edge plays at 2×
  (`PlaybackController.holdTwoX`, a "2× ▶" pill) until let go.
- **Speaker names** are parleykit's `SpeakerLabel`, the desktop and iOS rules:
  an assigned name, else "You" / "You N" and "Them" / "Remote N" for a desktop
  recording's `me` / `them` sources, else "Speaker A", "Speaker B" … with `…`
  for an undecided speaker. The screen, the clipboard, the hand-off prompt and
  the filing pass all go through `Format.speakerLabel`.
- **Reloads.** `TranscriptBackfiller.landed` counts finished re-transcriptions
  (iOS `backfillRevision`); an open recording re-reads its meta on every bump,
  so a better transcript that lands while it is on screen replaces the old one
  in place.
- **Couldn't load.** A failed load is an icon, "Couldn't load", and the reason
  (`DetailLoadFailure`: offline, not found, no access, signed out, a server
  error, or the sample gone).
- **Re-transcribe status** (iOS 1.14). `TranscriptBackfiller.status(id)` says
  `Running` (a run is alive in this process — `running`, an in-memory set),
  `Queued(lastAttemptAtMs)` (a manifest nobody is running; the time is stamped
  into the manifest when a run starts, so a run the system killed still leaves
  it), or `None`. The band above the pages shows exactly one of: a spinner and
  "Re-transcribing… this can take a few minutes." (running only); the last
  complaint, "Waiting to re-transcribe. It last tried …" and **Start now**,
  which drains the queue here without queueing (or charging) again; or a
  refusal on its own. A failure line never sits beside the spinner, and only a
  live run disables "Transcribe again" — a queued request can be asked for
  again.

## The study: findings, action items, brief, delivery

`study/StudyPass` is the desktop's study pipeline (`src/lib/analysis/studyPipeline.ts`)
on the phone: when a personal, cloud-synced recording is opened and has not
been analysed, it runs the four report stages on the hosted model and writes
the results into the recording's meta in the desktop's fields
(`api-cloud.md` › "The study fields Android writes"), so the desktop, iOS and
Android read one shape. Never the sample, an organization's recording or a
screenshot run.

- **Order.** `findings ──done──▶ action items ──settled──▶ brief`, and
  `findings ──done──▶ delivery`. The topology, the "queued" display and the
  restore-from-meta rules (`restoredStudyStatuses`: `analyzed` or findings →
  findings done, `analyzed` or action items → action items done,
  `deliveryAssessment` → done, `brief` → done, `briefFailed` → error) are
  parleykit's pure `StudyPipeline`, unit-tested with the desktop's cases.
- **Prompts.** `shared/prompts/study.json` is the single source for every
  study prompt and the built-in evaluation presets; the desktop imports it,
  Android compiles the generated `kit/StudyPrompts.kt`
  (`node scripts/gen-study-prompt.mjs`; `tests/studyPromptCopy.test.ts` fails
  when it is stale). `kit/StudyPromptBuilder` assembles the pieces in the
  desktop's order, and `StudyPromptsGoldenTest` checks it against
  `shared/prompts/study.golden.json` — the prompts the desktop really builds
  for fixed inputs. An unnamed speaker is labelled in a prompt with the
  desktop's English labels ("You" / "Them" / "Remote N" / "Speaker N",
  `SpeakerLabel.prompt`), never the screen's localized ones. The phone sends no `response_format`: it appends the JSON
  shape in words (`phone.schema`) and reads the first JSON object out of the
  reply (`kit/StudyMapping`, the desktop's mapping rules: clock parsing,
  snapping to a transcript line, the `maxMs + 5000` drop, eval ids checked
  against the configured set).
- **Models and limits.** `parley-fast` for the meeting kind and delivery,
  `parley-smart` for findings, action items and the brief — the desktop's
  realtime / deep lanes. 240 s per call for findings and the brief, 120 s for
  the others (`withTimeoutOrNull`), over `CloudClient.studyChat`, whose socket
  read timeout is longer than the shared client's 60 s.
- **Spend once, persist at once, back off.** Each stage re-reads the meta and
  adopts a result already there (unless regenerated by hand), asks the model,
  then writes through `editRecordingIf`, which re-reads again and declines when
  the field changed meanwhile — another device's result is kept. A failure or
  timeout is `ERROR` with a `StudyFailure` code; only a failed brief is
  persisted (`briefFailed`), as on the desktop.
- **The chip** (`ReportSections.kt` › `StudyChip`, the desktop's
  `StudyGenerationChip`): "Analyzing n/4", "Analysis ready", "n failed" or "Not
  analyzed"; its menu lists the four artifacts with their status and a
  regenerate each, and "Regenerate all" behind a confirmation (findings first,
  everything downstream only if that pass succeeded). Locked while a stage runs.
- **The switch.** Account sheet › Analysis › "Analyze recordings
  automatically" (`StudySettings`, default on — the desktop's
  `autoStudyAnalysis`). Off: nothing runs until somebody regenerates by hand.
- **Delivery on a phone recording.** Segments are `mix`, so there is no
  measured `speechRateHz` (pace reads "—" with the model's label), no talk
  share and zero filler sounds — exactly what the desktop shows for the same
  recording; tone and the summary come from the model.

## The filing suggestion card

`ui/FilingSuggestionCard.kt`, iOS `FilingSuggestionCard` (#450). The same card
on two screens, driven by one `filing/FilingSuggestionModel` per screen through
a `FilingCardController`:

- **Meeting screen**, after a live recording: the model runs the pass itself
  (`claim` / `run`) once the upload settles, and the card shows "Suggesting a
  name and a folder…" while it thinks.
- **Recording page**, above Summary | Transcript: the model `present`s a
  suggestion already pending on the recording — the meta's `filingSuggestion`
  (a desktop pass, or the backfill's), or the sample's through
  `AppContainer.sampleFiling` (a `filing/SampleFilingTarget`, which the
  sample's store implements). Personal recordings only.

The card: a "Suggestion" heading with **Skip suggestion** at the top right;
the proposed name, editable in place (Done renames at once, and "Was: …"
becomes "Renamed ✓"); up to three outlined folder chips — a new folder dashed
and captioned "New folder", an existing one "Existing folder", the model's
reason read by TalkBack after the name; "Choose another…", which opens the
folder picker with the suggested folders under "Suggested"; and **Accept**,
which takes the name as the field shows it and the first chip in one push. A
chip files without renaming. Every answer is one read-modify-write that also
sets `filingSuggested` and clears `filingSuggestion`, so the desktop does not
ask again.

Motion lives in parleykit's `FilingMotion`: the card arrives on iOS's spring
(response 0.5, damping 0.8), the proposed name types itself in once per
session at 22 ms a character, and Accept or a chip flies a ghost of the card
into the chip, pops it and plays a success haptic before writing. With
"Remove animations" on, all of it is skipped.

A guide can drive the card through the owning screen: `FilingCardController`
(`RecordingDetailViewModel.filingCard`, `FilingSuggestionViewModel.card`) has
`wash()` — tint the card for 1.2 s — and `openPicker()`; the recording page's
ViewModel also has `washFilingCard()` / `openFilingPicker()`.

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
| `parley://demo/import-partial` | Import saved, transcript completing in the background (alias: `import`) |
| `parley://demo/import-offline` | The same, still waiting for the network |
| `parley://demo/import-quota` | Import stopped: out of transcription quota |
| `parley://demo/import-signed-out` | Import stopped: session expired, with "Sign in again" |
| `parley://demo/movetofolder` | The featured recording with the folder picker open over fifteen folders (a review frame, as on iOS) |
| `parley://demo/checklist` | A new account: the getting-started checklist over an empty library |
| `parley://demo/checklist-partial` | The checklist two of four done, the sample loaded above the fixtures |
| `parley://demo/sample` | The sample recording's detail screen — real bundled audio, it plays |
| `parley://demo/share-menu` | The same with the `⋯` menu open (Share to AI, Copy with analysis prompt) |
| `parley://demo/report` | The featured recording on its report face, every artifact done |
| `parley://demo/report-analyzing` | The same mid-pipeline: action items and delivery generating, the brief queued |
| `parley://demo/report-menu` | The report with the analysis menu open |
| `parley://demo/off` | Leave demo mode |

The fixtures include two personal folders, one organization ("Sales team",
admin) with two folders and a shared library of its own, and a default save
location — so the scope switcher, chips, row menu and account picker are all
capturable. Moves, shares, created folders and the save location are applied to
in-memory copies only.

The meeting route takes `?scenario=` for the states only a real microphone or a
filling disk reaches: `mic-silenced`, `mic-recovering`, `mic-back`, `mic-lost`,
`mic-broken`, `storage-low`, `interrupted` (default `live`), e.g.
`parley://demo/meeting?scenario=mic-lost`.

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

- **The keyboard is behind iOS.** No personal dictionary (the polisher takes
  protected terms, but every call passes none), cleanup is on/off rather than
  iOS's off / tidy / concise, no dictation history, and no relay reconnect
  mid-dictation.

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
