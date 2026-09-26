# iOS voice-typing keyboard

A dictation keyboard for Parley: tap the mic in any text field and speak; the
words land in the field. It is the phone's version of the desktop's
`voice_typing.rs` — the meeting transcription stack (mic → hosted STT relay) with
none of the meeting overhead — reached from the system keyboard instead of a
global hotkey.

## The constraint that shapes everything

**A keyboard extension cannot open the microphone.** iOS has forbidden it since
iOS 8, and Full Access does not change it (an `AVAudioEngine` start fails with a
CoreAudio error even with mic permission granted). So the keyboard cannot record.
Every dictation keyboard on the App Store — Wispr Flow, Typeless, Superwhisper —
works around this the same way: the keyboard bounces to its container app, the
app records, and the transcript is handed back to the keyboard.

Parley reuses its existing pipeline for the recording half: `AudioCapture`
(16 kHz mono) → `SttRelayClient` (hosted relay, billed under `feature:
"dictation"`, no API key on the phone). Only the keyboard, the App Group
hand-off, and the in-app dictation session are new.

## Flow

```
┌ host app (any) ────────────┐        ┌ Parley app (background) ──────┐
│  text field                │        │  DictationCoordinator          │
│  Parley keyboard  ──mic──▶  │  URL   │  parley://dictate?session=…    │
│      │                      │───────▶│      │                         │
│      │                      │        │  AudioCapture → SttRelayClient │
│  insertText ◀── App Group ──┼────────┼──▶ transcript (committed/tail) │
│                             │ Darwin │                                 │
└─────────────────────────────┘  notes └────────────────────────────────┘
```

1. **Keyboard mic tap.** The keyboard mints a session id, captures the host
   app's bundle id (best-effort, for auto-return — see below), writes an
   *uplink* file to the App Group, and opens `parley://dictate?session=…` with
   SwiftUI's `openURL` action (the responder-chain `openURL:` walk was disabled
   for keyboards in iOS 18; `openURL` is the public path that still works, with
   the walk kept only as an older-system fallback). Only when there is
   something to start: a keyboard whose readiness mailbox says the app has no
   account or no microphone permission mints no session and opens the bare
   `parley://` instead — see *Four states* below.
2. **App records.** `onOpenURL` routes to `DictationCoordinator`, which starts
   the mic + relay and mirrors the growing transcript into a *downlink* file,
   posting a Darwin notification on each update.
3. **Return to the host app** — or, far better, never leave it. See the
   microphone window below.
4. **Keyboard watches, and inserts nothing yet.** On the Darwin note (and on
   every `viewWillAppear`, in case it was suspended through the notification)
   the keyboard reads the downlink and shows the settled tail followed by the
   tentative partial above the keys. Nothing reaches the host's document while
   the session is `starting`, `listening`, `reconnecting` or `finishing`.
5. **Stop, then one insertion.** The keyboard's ⏹ writes `stopRequested` and
   posts the uplink note; the app finishes the relay, drains the last utterance,
   folds the final tail into the committed text, and marks the session `done`.
   That state is the keyboard's cue: it inserts the whole committed text in a
   single `insertText`, then writes the character count back to the uplink as
   its high-water mark (`insertedCount`), so a keyboard killed mid-session and
   relaunched after the session ended still pastes exactly once. `error` inserts
   nothing at all.
6. **Or ✕, and nothing at all.** The keyboard's ✕ writes the same
   `stopRequested` with `cancelRequested` beside it. The app cuts the relay
   instead of finishing it — no drain, no cloud polish — clears the transcript,
   and marks the session `cancelled`, a third terminal state the keyboard never
   inserts from. The microphone goes back to the window the user chose, exactly
   as it does after ⏹, because nothing failed.

#### Three ways a session ends

`done` delivers, `error` explains, `cancelled` says nothing and leaves the
field as it was. (There is a fourth, `micTaken`, which is not really an ending —
the app may still resume the same session. See *When the system takes the
microphone*.) They are three states rather than two plus a special case,
because the keyboard's rule for `done` is "insert what is here": an empty
transcript from a session where nobody spoke and a transcript the user threw
away have to be different events, or the rule needs an exception, and the
exception is the bug.

✕ is the only one of the three the user can reach on purpose, and it stays
reachable through `finishing` — the polish round trip is up to six seconds
during which the pane still reads as live. So ⏹ and ✕ can cross in flight. The
app's side is safe because the polish result is dropped unless the session is
still `finishing`; the keyboard's side is safe because it remembers the id it
cancelled and refuses every later downlink for it. Both halves are needed: the
app may answer slowly, or (killed) not at all.

Why ✕ is not "⏹ and then delete": ⏹ *is* the delivery path. It drains the relay
for one more utterance, folds in the partial, and spends a cloud request
polishing text that is about to be thrown away — and then the user is holding
⌫ through a paragraph they never wanted, on a pane whose delete key is a 44pt
disc. The words are already visible above the record button while they are
being spoken, so before this the pane let someone watch a mistake happen and
do nothing about it.

#### Why one insertion rather than a stream

The keyboard used to insert each delta as the relay settled it, which read as
the more live design and was the worse one. Settled is not final: the relay
revises runs it has already emitted, so a document collected the churn, and
`insertText` cannot take anything back. Worse, every way a session can end
badly — a lost socket, quota, the user walking away — left a half sentence in
someone's field, punctuated wherever the relay happened to have got to. One
insertion at `done` makes the transaction the whole utterance: either the
sentence lands, or the field is exactly as it was and the error says so. This is
also what the copy on the failure paths now says (it used to promise that what
was already said "has been typed").

The price is that the keyboard's own text slot stops being a nicety and becomes
the only place the words are visible while they are being spoken — see *The live
transcript* below — and that the transcript now depends on the keyboard coming
back within the downlink's adoption window (150 s) rather than on it having been
alive at the right moments.

#### Where the words go when they don't land: voice-typing history

One insertion has a cost the paragraph above only half states: when the
insertion does not happen, the words exist nowhere. The keyboard's
`drainDownlink` has four ways of ending without typing anything, all silent by
design:

1. **The adoption window runs out.** A relaunched keyboard adopts a foreign
   downlink only within 150 s of its last stamp; come back later and a `done`
   transcript is never inserted.
2. **`looksDead`.** A live state nobody has vouched for is abandoned — the app
   was suspended, jetsammed or swiped away mid-session.
3. **`error`.** Never inserted, whatever had settled before the failure.
4. **The wrong field.** `insertText` goes to whatever is focused when `done`
   arrives; if the user moved, the text lands somewhere else or nowhere.

So since 1.21 the app keeps what was dictated (pathorsAI/parley#290).
`DictationHistoryStore` (ParleyKit, Foundation only, unit-tested) is one JSON
file, `dictation-history.json`, and `DictationCoordinator` writes to it from the
three endings that carry words: `settle` (`done`, after the personal
dictionary, so the entry is exactly what the keyboard was handed), `fail`
(`error`) and `endSessionWithMicTaken`, each only when `committed` is non-empty.
**Never from ✕**: `cancel` is the user throwing the words away, and it clears
`committed` before it publishes. Entries carry the text, when, how long, the
entry point (keyboard or Action Button) and the host bundle id when the keyboard
could resolve one. Retention is the most recent 200 **and** nothing older than
30 days, pruned on every write and every load. Settings › Voice typing history
switches it off (the store refuses writes; existing entries stay until "Clear
all") and clears it.

**App side, on purpose.** The file lives in the app's own sandbox (Application
Support, excluded from backup), not the App Group. The App Group is shared with
the keyboard, and the keyboard is the one process that must never hold
transcript history: it runs inside every app the user types into. The keyboard
target does not reference the type at all. The relay was checked before building
this: it meters seconds per feature and relays frames, and stores no transcript
text, so there was nothing server-side to fetch instead.

**Error is the case worth saving.** A `done` that inserted is already in a
field; history is merely convenient for it. An `error` — and exits 1 and 4,
where the app did reach `done` but nothing landed — is where the words would
otherwise be gone, and it happens precisely when something already went wrong.
Exit 2 is covered when the app survives to end the session itself; when the
process was killed outright, the words die with it. The stale downlink that
`reapOrphanedSession` rewrites on the next launch still carries them, and
keeping that too is a possible follow-up (it has no reliable start time or
duration, which is why it is not in the first cut). That is also why there is no
"paste last" key on the keyboard: rescuing words is the app's job, reading
history back into a keyboard is exactly what the sandbox choice rules out, and
copy is the primary row action in Library › Voice typing — one tap from the
list, not behind the detail sheet.

### App Group channel

`DictationChannel` (in ParleyKit, so both targets share it) is seven
single-writer mailboxes, each with its own Darwin notification, so the two
processes never contend on a file:

- `dictation-down.json` — app → keyboard: `{session, committed, partial, state}`.
- `dictation-up.json` — keyboard → app: `{session, hostBundleID, stopRequested,
  cancelRequested?, insertedCount}`. `cancelRequested` is optional so an uplink
  written by an older build still decodes — a mailbox that fails to decode
  reads as "nothing there", which here would mean a stop the app never hears.
- `dictation-window.json` — app → keyboard: `{length, openedAt, expiresAt,
  updatedAt}`, the microphone window and its heartbeat.
- `dictation-window-control.json` — keyboard → app: `{closeRequestedAt}`, the
  keyboard's "end the window now".
- `dictation-ready.json` — app → keyboard: `{signedIn, micGranted, updatedAt}`,
  whether a tap could dictate at all.
- `dictation-presence.json` — app → keyboard: `{awake, servesInPlace,
  updatedAt}`, the app's heartbeat: the process is there, and whether a start
  request would be served without opening Parley. See *Knowing whether the app
  is there* below.
- `dictation-level.json` — app → keyboard: `{level, updatedAt}`, how loud the
  microphone is right now, normalised to 0…1. Written ~12 times a second while
  a session is live and somebody is speaking, and not at all otherwise. See
  *A record button that swells with the voice* below.

The window pair is separate from the session pair because a window outlives any
one dictation, and most of what it has to say happens when no session exists.
Presence is separate from the window because "is the process there" underlies
and outlives "is it holding a microphone", and separate from the downlink
because the downlink is stamped only when the transcript moves — and a user
pausing to think is not a dead app.

**Readiness is the one mailbox with no staleness rule**, and that is a
difference in kind rather than an omission. A window is a claim about a live
process, so a file nobody is re-stamping is a lie (hence the heartbeat). An
account and a microphone grant are facts about the *installation*: they are
still true when the app is dead, so the newest file is always right. A missing
file is not an unknown either — it means Parley has never run here, which is
exactly the state the pane needs to describe. The app republishes on launch, on
every foregrounding, on sign-in and sign-out, and the moment the microphone
prompt is answered.

The files are the source of truth; the Darwin notes are pure "go re-read"
signals (they carry no payload). This is what makes the hand-off robust to the
keyboard being suspended/killed while the app is foregrounded — whatever it
missed is still in the downlink when it returns.

`lexicon.json` sits in the same container but is **not** part of this channel:
it is shared state rather than a mailbox, read at the two moments it matters and
carrying no notification of its own. See the personal dictionary below.

App Group id: `group.com.pathors.parley.ios` (entitlement on both targets).

## Not leaving in the first place — the microphone window

This section used to be called "the jump back to the previous app problem", and
it framed the whole thing as closed by Apple: the private auto-return died in
iOS 26.4, so the answer was a swipe-back guide. That framing is what sent this
feature down the wrong path, because **the competitors' trick is not returning
faster. It is not leaving.**

Wispr Flow sells the microphone as a *window of time* rather than a per-tap
permission — their docs describe sessions as windows during which you let the
app use the microphone. The first tap opens the app and starts the window; while
it is open the app stays resident, and every later tap records with no app switch
at all. Parley already had the shape of that path and almost never won it.

### Why the old path lost

`KeyboardViewController.startDictation` publishes the request to the App Group,
waits `startAckWindow` (700 ms) for the app to answer, and only opens
`parley://dictate` if nothing does. An app that is awake answers in
milliseconds. The problem was how briefly the app stayed awake:
`DictationCoordinator.beginLinger` is a `beginBackgroundTask`, and iOS grants one
of those roughly **30 seconds**. Pause to think mid-sentence and the window is
gone — so in practice every tap took the round trip.

There is also a second reason, and it turned out to be a fact about some phones
rather than a rule: **a backgrounded process can be refused when it starts
recording.** Activating a record session from the background has returned
`AVAudioSessionErrorCodeCannotStartRecording` with `Client … is in the
background and doesn't have the entitlement to start recording in the
background` in the log. On other phones, with the same `UIBackgroundModes:
audio`, the activation succeeds, and the linger had been buying in-place starts
there since #222. Apple has never published exactly how this interacts with the
background mode, and we cannot settle it from a simulator. So the app assumes
neither answer: a lingering process with nothing to borrow opens the microphone
*before* acknowledging a start, and a refusal goes unanswered (see *Knowing
whether the app is there*). A window sidesteps the question entirely.

### What a window is

The window sidesteps both. `MicWindowLength` (`ParleyKit/MicWindow.swift`) is a
user setting — off / 5 minutes / 15 minutes / 1 hour — and while a window is open
the app **does not close the microphone at the end of a dictation**. The audio
session stays active, which is what keeps the process resident for minutes rather
than seconds, and the next session does not *start* recording at all: it borrows
a capture that has been running since the app was last in the foreground. The
question of whether a background start is allowed never comes up, because there
is never a background start.

```
tap 1   keyboard → parley://dictate → app comes forward → mic opens (foreground)
        dictation → user swipes back → dictation ends
        ─── window opens: capture keeps running, audio goes nowhere ───
tap 2   keyboard → Darwin note → app (background, mic already open) attaches
        the relay to the running capture.  No app switch.
tap 3   …
        ─── window expires: capture stops, indicator goes out ───
tap 4   round trip again
```

`DictationCoordinator` stopped treating the microphone as a session's property:
`releaseMicrophone()` at the end of a dictation either hands it to the window or
closes it, and `launch()` reuses whatever is already running. While no dictation
is attached, chunks go into `RelayAudioBridge` with no leg and no hold, which
counts them and drops them — **an open window records nothing, because there is
nowhere for the audio to go.**

`AudioCapture` gained one thing for this: `isCapturing`. A borrow has to ask
whether the capture is *running*, not whether the coordinator still happens to
hold one. The engine can be torn down behind its owner's back — a rebuild that
runs out of attempts, a status that arrives when there is no window left to end
it — and a non-nil `AudioCapture` that will never produce another sample is the
worst thing there is to hand a dictation: the session goes to `.listening`, the
user talks, nothing is transcribed, and it happens in the background, where the
microphone cannot be reopened to recover. So `launch()` stops a capture that says
it is not capturing and opens a fresh one, and if that start is refused — the
ordinary answer in the background — the session fails with the window closed
behind it, which is what puts the keyboard back to honestly promising a trip
through Parley.

### What it costs, and where that is said

The microphone is genuinely open for the whole window, so **iOS shows the orange
recording indicator for the whole window**. That is the real price of this
design, and it is not something to discover.

- The Settings picker states it in the same breath as the benefit, before the
  choice is made — see the footer under *Keeping the microphone ready*. It says
  the indicator will be on, that Parley really is holding the microphone, and
  that nothing is recorded, transcribed, or sent until the mic is tapped.
- The **Record tab** grows a bar while a window is open. Someone who notices an
  orange dot opens Parley and lands there; a record screen saying "not
  recording" under a lit indicator would read as a lie.
- The keyboard shows a **"Mic ready" chip** in the mode strip, in iOS's own
  indicator orange rather than a Parley colour — two marks for the same fact
  should look like the same fact.

Every one of those three is also a way to end the window early.

### A tap that stays and a tap that jumps must not look the same

The chip is the positive signal, and it sits in the mode strip rather than on the
voice pane: the strip already has an empty middle, the fact is true of the
keyboard rather than of one pane, and the voice pane's heights are measured to
the point where adding an element moves the record button. It is hidden during a
session — the record button already says the microphone is live, and the chip is
about the *next* tap.

There used to be a negative signal too, and there no longer is. First a second
line under *Tap to speak* — *This tap opens Parley first* — then, when that read
backwards, a headline that changed to *Dictation starts in Parley* with the jump
glyph on the button. Both were the keyboard answering "will this tap jump", and
#404 took the question away: a lingering Parley serves the tap in place, so the
jump is the exception rather than the rule, and the owner ruled that a first tap
opening the app once is expected behaviour and not a warning's worth of screen.
The button now follows **readiness** — see the state list below — and the chip is
the only thing in the strip that talks about windows at all.

### Bounded on purpose: there is no "until I turn it off"

Wispr Flow offers a never-expires option. Parley does not, for two reasons that
are really one:

1. **It is a promise the platform will not let us keep.** A window is a live
   recording session in a backgrounded app. iOS reclaims those under memory
   pressure; another app taking the microphone ends ours; neither gives us a
   chance to tell anyone. A window we close ourselves is one we can be right
   about.
2. **It is the one option with no natural end.** Every other choice eventually
   turns the indicator off on its own, which makes a forgotten window
   self-correcting. An unbounded one is a microphone left open for a day because
   someone tapped a picker once.

For the same reason the default is **off**. The setting existing is the point;
an on-by-default open microphone is not.

### The heartbeat, and why the keyboard does not trust the expiry

The app writes `dictation-window.json`; the app can also be killed without ever
writing again. The file left behind still says "open for another 50 minutes", and
a keyboard that believed it would show a ready microphone that does not exist and
then jump anyway.

So the app re-stamps the file every `MicWindowState.heartbeat` (20 s) for as long
as the window is really open, and a reader disbelieves a stamp older than
`staleAfter` (55 s). One mechanism, two jobs: the same heartbeat is what keeps the
chip honest without the extension running a timer of its own. (The chip used to
carry the minutes left as well; that went when the pane tabs took the right of
the strip — the Record tab, Settings and the Live Activity still count down.)
Expiry is still punctual — the app's loop sleeps the *shorter* of a heartbeat and whatever
is left, because five minutes has to mean five minutes.

Ending early is a **timestamp, not a flag**: the keyboard writes
`closeRequestedAt` and the app closes any window opened at or before it. Neither
side ever has to clear anything, and a leftover request cannot refuse to let the
next window open.

### What ends a window

Expiry, the user (from the keyboard, the Record tab, or Settings), a session
failure of any kind, the microphone being interrupted or lost, and a meeting
recording starting — there is one microphone, and `MeetingRecorder.start` takes
it. Interruption is deliberately fatal to the window rather than something to
wait out: **a window that cannot be honoured is worse than one that ended early,
because the user can see the second and cannot see the first.**

A background task is never held while a window is open. `beginBackgroundTask` is
worth nothing next to an active audio session, and ending an assertion in the
background is a documented way to get suspended anyway.

### With the window off: a 30-second hold

The window being off used to mean the microphone closed with the dictation and
only the ~30 s background-task linger was left. That linger could not deliver
what it was for. A second tap within those seconds either reached a process
iOS had already suspended, or reached a live one that then had to *start* a
microphone from the background, which iOS can refuse (see *The jump that is
left*). The owner hit it on 1.17: first tap opens Parley, back to the host,
dictate, tap again, and Parley opens again.

So the end of a dictation with no window now keeps the running capture for
`holdAfterDictation` (30 s) in `DictationCoordinator.holdMicrophone`, the same
way a window keeps it, and the next tap borrows it. Nothing is published as a
window: no chip, no Record-tab bar, no Live Activity, because the hold is not
something the user set and ends before any of those would be read. The orange
dot is on for those 30 seconds, and the Settings footer under *Keeping the
microphone ready* says so even when the picker is off. Sound during the hold is
dropped exactly as in a window. A new session, a window opening, a meeting
taking the microphone, or the microphone closing for any other reason ends the
hold, and the linger is not armed on top of it.

### When the system takes the microphone: iOS's own dictation

The report this section exists for: *"If I turn on voice typing and then press the
iPhone's built-in dictation, my voice stops going in — the Parley keyboard can't
be used any more."* Not for that one dictation. From then on.

It is the microphone window's failure mode taken to its conclusion, and the whole
sequence is worth writing down because five separate mechanisms each did the
locally reasonable thing and the sum was a dead keyboard.

**What happens, step by step.** Parley is in the background holding the
microphone; a Parley dictation is running; the user taps the system keyboard's
mic (or the host app's dictation button), which opens a recording session in
another process with a stronger claim on the input.

1. iOS posts `interruptionNotification` `.began`. `AudioCapture` tears the engine
   down and reports `.interrupted`.
2. **The pane went on claiming to listen.** `handle(capture:)` treated
   `.interrupted` during a session as cosmetic — it zeroed the level meter and
   published nothing — so the downlink still said `listening`. The keyboard's
   liveness watchdog could not save it either: the presence heartbeat keeps
   stamping while the process is awake, and `Downlink.presumedDeadAt` takes the
   *newer* of the downlink's stamp and that heartbeat. So ⏹ stayed on screen over
   a microphone iOS had taken away, for as long as two minutes, until the
   session's own cap ended it as a success with nothing to insert.
3. **`.ended` does not reliably arrive.** System services raise interruptions
   that never announce their end. Recovery hung entirely off `.ended`, and the
   watchdog that exists precisely as the backstop for "iOS announced nothing" was
   skipped while `interrupted` was set — the one flag the case sets.
4. **When it did arrive, twelve seconds of being refused.** `rebuild` called
   `AVAudioSession.setActive(true)`, which iOS refuses to a backgrounded app that
   another client interrupted (`!pri` / 561017449, `!int`, `!rec`). Six attempts
   on a 250 ms → 4 s ladder is under twelve seconds — the right length for a
   route change settling, and nothing like long enough for a person dictating a
   sentence into iOS.
5. **Giving up was permanent by construction.** The give-up cleared
   `wantsCapture`, which every recovery path guards on — the watchdog, the route
   change, the configuration change, even a media-services reset. Nothing watched
   for the app coming to the foreground, which is the one state where the
   activation would have been allowed. `stop()` was a no-op for the same reason
   (`end()` guards on that flag), so the audio session was never deactivated and
   whatever the interruption had paused stayed paused.
6. **And then the corpse killed the next session.** `onStatus` hops to the main
   actor, and a backgrounded process runs no main-actor work until it is resumed.
   So the `.failed` published while giving up in the background could be delivered
   *after* the user's next tap had brought Parley forward and opened a fresh
   microphone — and `handle(capture:)` had no way to tell one capture's status
   from another's, so it failed the new session and closed the new window on the
   strength of the old one's obituary. Tap, get thrown into Parley, "lost the
   microphone", repeat. That is the "can't be used any more" part.

**What it does now.** The retry logic is a state machine of its own,
`CaptureRecovery` (ParleyKit), driven by `AudioCapture`: inputs are began /
ended / rebuild-failed / app-became-active / media-services-reset / restarted,
outputs are rebuild-now, rebuild-after(ms), and give-up. Four changes follow from
it.

- **Probe while interrupted.** `.began` schedules a rebuild attempt 2.5 s later
  rather than waiting for an `.ended` that may not come. Being refused while the
  other client still holds the input costs one throw and feeds the ladder;
  succeeding means it let go without saying so.
- **A ladder that outlasts a dictation.** Twelve attempts, 250 ms doubling to a
  4 s cap — about half a minute — and it is *bounded*, because a capture that
  claims to be recovering for minutes is the silent failure this whole file is
  about.
- **Giving up stays armed.** `lost` is a state, not the end of the object:
  `UIApplication.didBecomeActive` / `UIScene.didActivate` and
  `mediaServicesWereReset` each start one more chain, and a late `.ended` does
  too. `wantsCapture` stays true, so `stop()` really stops — the session is
  handed back and the interrupted music resumes.
- **Statuses carry their capture.** `DictationCoordinator` numbers every
  `AudioCapture` it opens and ignores statuses from one it has replaced, exactly
  as relay events carry their leg.

**And the pane stops lying.** A new downlink state, `micTaken`, is published the
moment the microphone is gone — not when the recovery gives up — and the keyboard
renders it as *Microphone taken by the system. Tap to restart.* (麥克風被系統佔用，
點一下重新開始) in the ordinary slot ink. No toast, no alert, nothing new on the
deck, and no red: being interrupted by the phone's own dictation is not a fault,
it is the user having used their phone.

`micTaken` is deliberately **not live** (`Downlink.State.isLive`). The question
`isLive` answers is "should a reader keep waiting on this", and while the
microphone is gone the answer is no whatever the app is doing about it — a live
`micTaken` would put ⏹ back over a microphone nobody has, and would hand the
session to the liveness watchdog, which would cancel something the app may still
resume. Not-live gets both halves right, because **recovery is republishing, not
resurrection**: if the capture wins the microphone back, the app publishes
`listening` for the same session id and the keyboard picks the transcript up
exactly where it stopped. The words already spoken were never thrown away.

The window is closed at the interruption rather than at the give-up, for the
reason the section above gives: it is a promise that the *next* tap stays put,
and the keyboard draws that promise as a ready-microphone chip and as *Tap to
speak*. Both are false the moment the microphone is gone.

A tap in the `micTaken` state — and any tap after a lost microphone — goes
through the ordinary start path and can only end in a brand-new capture. Three
guards make that true rather than likely: `launch()` stops and drops any capture
that is not `isCapturing` (a lost or interrupted one reports false), the app
declines the no-jump start unless it is in the foreground or holding a running
microphone, and the generation number means the old capture cannot speak for the
new one. So the tap either opens the microphone in place (Parley foreground) or
opens Parley, which is where iOS allows a recording session to start at all.

### App Review

The defence is consent that is visible and reversible, in that order: the user
chose the length, the indicator says it is happening, three separate surfaces say
what it means, and each of them ends it. The window is bounded in every case, it
holds no audio, and nothing leaves the device until the mic is tapped. No private
API is involved anywhere in it — audio session, App Group, Darwin notifications,
`insertText`.

### Knowing whether the app is there

Two things the keyboard has to say depend on a fact only the app process can
supply, and until `AppPresence` (`ParleyKit/DictationChannel.swift`) neither
had a source for it.

**What the next tap will do.** `startDictation` always tries the no-jump path
first — publish the request, wait 700 ms for the app to acknowledge — and only
opens `parley://dictate` when nobody does. The record button has to promise one
or the other *before* the tap. It used to promise the jump whenever no window
was open, which was wrong in one direction the user notices immediately: with
Parley itself in the foreground hosting the keyboard (typing into the personal
dictionary, say), the tap has always stayed put, and the button said it would
leave. It was also wrong in the other direction, silently: a Parley lingering in
the background after a dictation *would* answer the note, then fail to open a
microphone — iOS refuses to let a backgrounded process start recording — and
publish "Couldn't open the microphone. Open Parley and tap the mic again", every
time, for as long as the linger lasted.

The app now writes its own answer every ten seconds while it runs:
`servesInPlace` is true in the foreground, or in the background while a running
capture (a window) is there to borrow, and false otherwise. `staysPut` — a
window being open **or** a fresh presence saying the app can answer in place —
is what the app reasons with. It used to drive the record button's glyph as well;
it no longer does, because a tap that opens Parley once is not worth a warning.
See *Three states, and only one of them is a microphone*.

`armRequestObserver` used to apply the same condition before honoring a start:
a backgrounded app with no microphone declined the note outright, on the premise
that iOS never lets a backgrounded process start recording. That premise came
from one phone's log and is false on others, where the linger had been buying
in-place starts since #222, and the guard turned every one of those into a trip
through Parley: the "every dictation jumps to Parley once" regression. So the
app now *tries*: a lingering process with nothing to borrow opens a microphone
before acknowledging, and only a refused activation goes unanswered, at which
point the keyboard's 700 ms fallback opens the app and the microphone is opened
in the foreground where it can be. The glyph stays pessimistic on purpose. A tap
promised as a jump that stays put is a surprise in the right direction; the
reverse is the one the user notices.

Trying costs the ack its speed on this one path: `starting` is written after
`AudioCapture.start()` rather than milliseconds after the note, and the keyboard
only waits `startAckWindow` (700 ms). A background activation slower than that
makes the keyboard open `parley://dictate` over a microphone that is already
running; `begin(session:)` then stops that session and relaunches it in the
foreground, so the user gets the jump they would have had anyway plus a restart,
and nothing worse. How long the activation takes on a given phone is unmeasured;
the app logs it (`subsystem com.pathors.parley`, category `Dictation`, "background
mic start took N ms") so a phone can answer.

**Whether the session on screen is still being served.** The downlink says
`listening` and keeps saying it whatever happens to the app. A backgrounded
Parley is suspended without a hook when the host app takes the audio session
(an interruption), killed by jetsam, or swiped out of the app switcher — and in
every one of those the keyboard kept drawing a stop button that nothing answered
over a transcript slot that nothing filled. That is the "came back and it says
it's listening but nothing happens and I can't stop it" report.

`Downlink.looksDead(presence:)` is the rule: a live state (`starting`,
`listening`, `reconnecting`, `finishing`) whose own stamp *and* the presence
heartbeat are both older than `AppPresence.staleAfter` (25 s, against a 10 s
heartbeat) is presumed dead. Terminal states never look dead — a `done` still
lands after a keyboard relaunch exactly as before. `checkLiveness` in the
keyboard watches the earliest of three deadlines and gives up at it:

- the live downlink's presumed death, as above;
- 10 s from minting, for a session the app never answered (the URL was refused,
  or the app is gone — on the usual path the app switch kills the keyboard first
  and none of this runs);
- 3 s from ⏹, for a session the app has not started ending. The app publishes
  `finishing` synchronously on hearing the note, so a session still `listening`
  three seconds later is one nobody heard the stop for.

Giving up is `abandonSession`: the pane is cleared as ✕ would clear it, the app
is sent the same cancel (a Darwin note it receives the moment it is resumed, if
it ever is), and the slot says *Parley stopped listening. Tap the mic to try
again.* The ⏹ itself no longer takes the pane out of `listening` on the press —
that only meant the next drain put the button back — the app's `finishing` is
what changes the pane, and the watchdog is what covers a `finishing` that never
comes.

One hole the heartbeat alone would leave: a process that crashed and relaunched
is very much present, and its fresh heartbeat would vouch for the `listening`
file the dead process left behind. So `DictationCoordinator.init` reaps first —
any live-state downlink at that point belongs to a process that is no longer
running, and it is rewritten as an `error` (which inserts nothing) with a
message that says what happened. The app also writes `awake: false` at the two
moments it can see its own suspension coming — the linger's expiry handler and
`willTerminate` — so the keyboard need not wait out the stale period in the
common case.

### The jump that is left, and what is actually known about it

There is still a first tap, and a tap after a window closes. Those still open
Parley, and the dictation screen still teaches the swipe back (`SwipeBackGuide`).
Two things are worth writing down rather than repeating:

- **There is no public way to do any of this, on any iOS.** Apple's DTS has
  answered that nothing identifies the host from an extension and nothing
  returns the user to it (FB22247647 remains open). The destination does not
  have to be *detected* though — it can be *chosen*, which is how KeyboardKit
  10.4 handles it, and is tracked separately.

- **What 26.4 changed is less clear than the first reports made it sound.** The
  private bundle-id sources were widely reported as emptied in 26.4, and
  `UIApplication.suspend()` does land on the Home Screen because the app was
  launched by an extension. But keyboards in this category are observably still
  returning users to their host app on iPadOS 26.5 — so "26.4 closed the door"
  is at best not the whole story. It was nonetheless compiled into Parley as
  `if #available(iOS 26.4, *) { return false }`, and that is the part that had
  to go: not because the number was wrong, but because **a number is the wrong
  shape of answer**. See below.
- **Our own pre-26.4 auto-return had never fired on any iOS version** — now
  fixed. `KeyboardHost.bundleID(of:)` probed `_hostBundleID` and
  `_hostApplicationBundleIdentifier` with `responds(to:)` **on the
  `UIInputViewController` itself**, and both parts were wrong: the value lives
  on the controller's `parent` (an `_UIViewServiceViewControllerOperator`), and
  `_hostBundleID` is an **ivar with no getter**, so `responds(to:)` is
  unconditionally false and only KVC's ivar fallback can reach it.
  `HostReturn.attempt` had therefore never run, on 26.4 or before — which the
  version gate made look like a decision rather than a bug.

  The read now lives in `ParleyKit/HostBundleID.swift`, taking an `NSObject`
  rather than a view controller so the dangerous half is testable: `value(forKey:)`
  on an undefined key raises an Objective-C exception Swift cannot catch, so the
  runtime is asked whether the class declares the ivar before KVC touches it. A
  keyboard extension that crashes on appearance would be far worse than one that
  never takes you back.

Neither is why the reported bug happens, which is worth being clear about: the
report is that dictation *leaves*, and leaving is what the window fixes.

### Deciding at runtime instead of guessing at build time

`HostReturnPolicy` replaced the version gate. It answers "attempt the jump?"
from three inputs, and the useful property of all three is that none of them is
a prediction:

1. **A remote flag** — `FeatureFlags.HostReturn`, cached in the App Group by
   `FeatureFlagStore`. `enabled: false` is a kill switch that outranks
   everything; shipping it in the same change as the private-API path is the
   point, because it means a 2.5.1 objection can be answered in minutes rather
   than in a release. `byOSVersion` turns a single iOS off, or back **on**,
   which is the only way to re-arm devices that have given up locally.
2. **Evidence this device collected about itself** — `attemptAndVerify` fires
   the launch and then watches whether the app actually got backgrounded,
   writing the outcome to `HostReturnLedger`. After `failureBudget` (2)
   consecutive failures the device stops trying.
3. **The OS version as a key, never as a threshold** — the ledger is stamped
   with the full OS build string, so an update wipes the count and the device
   tries again on its own. That is exactly the moment the answer might have
   changed, in either direction.

The screen is optimistic and then honest. `returnableHost` is set the moment the
jump is attempted, so `DictationView` shows the hand-off shape; it is cleared
again if the app is still foregrounded ~1.2 s later, and the swipe-back guidance
takes over. That ~1.2 s is the whole cost of being wrong, it is only paid while
the ledger has not yet made up its mind, and it buys the one thing a compiled-in
version check could never produce: **a device that finds out.**

Until `GET /v1/flags` exists server-side every device runs on compiled defaults.
A 404 is folded into "no opinion" rather than into an error, so publishing the
endpoint is the only remaining step to gain the switch — no client release.

## Personal dictionary

Dictation types and forgets. A name the STT mishears stays wrong in every future
dictation, and the user re-fixes it every time — which is the loop the desktop
closed in #295 with a phrase dictionary learned from post-paste corrections. This
is the phone's version of it, and the interesting differences are all in what a
keyboard extension is able to see.

`Lexicon` / `LexiconStore` (ParleyKit) hold correction pairs and hand-added terms
in `lexicon.json` in the App Group container — same plumbing as
`DictationChannel`, atomic writes and a tolerant decode, no Darwin note because
nothing here is live. Every rule lives on the `Lexicon` **value**; the store is
the same API with a file behind it, which is what lets all of it be unit-tested
on a machine that has no App Group container.

### What it can see, and what it can't

The desktop reads the field it pasted into through the Accessibility API and
watches the value settle. The keyboard has no such thing. Its entire view of the
field is `textDocumentProxy.documentContextBeforeInput`: a run of text ending at
the cursor, clipped at a length iOS does not promise, with no notification when
anything changes. So the shape is a snapshot and a comparison — snapshot the
window when the dictated text has just landed (`state == .done`), compare it
against the window again at `viewWillDisappear` or at the start of the next
session, diff, record.

**The scope this buys is narrow, and it is worth stating rather than discovering:
only edits the user makes while our keyboard is still up in that same field.**
Dismiss the keyboard, switch apps, or move to another field before fixing the
word and the correction is never seen. Nothing in the extension API would let it
be — the field belongs to the host app, and the proxy exists only while we are
the active input. Two smaller limits sit under it: the window can slide out of
alignment in a field longer than 200 characters when an edit changes the text's
length, and `viewWillDisappear` is not a promise on a process iOS kills without
ceremony. In both cases nothing is learned, which is the intended failure —
**capturing garbage here becomes a rule that rewrites the user's words from then
on**, and that is far worse than capturing nothing.

`LexiconCapture.alignable` is the one gate: the two windows have to agree at one
end or the other, or they are two different pieces of text. It deliberately does
*not* trim them down to their disagreement first, because a character-level trim
cuts through the middle of words — "we use pearly" against "we use Parley" shares
the prefix `we use ` and the suffix `y`, so the trimmed pair is `pearl → Parle`,
a rule that could never match again since Latin pairs need a whole word. Handing
both whole windows to a token-level diff is what keeps a learned pair at word
edges. The anchor is also *weighted* rather than counted — an ideograph is worth
two — because Chinese packs into five characters what English spends a clause on,
and a raw count would have refused 在 → 再, the correction this was built for.

`EditDiff` is that token-level diff: Latin runs are words, ideographs are single
characters, an LCS aligns them, and adjacent changed tokens merge into one span.
Most of the file is refusals — pure insertions, pure deletions, case,
punctuation, whitespace, and anything over ten characters on either side. An
insertion, a deletion, a typo fix and a wholesale rewrite all arrive through the
same channel; only one of them is vocabulary.

### Why a pair does nothing until it has been seen twice

`Lexicon.autoApplyThreshold` is 2, and the second sighting is the whole point. A
single edit is as likely to be someone rewording their sentence as it is to be a
word Parley gets wrong, and the two are indistinguishable from a diff. Acting on
one sighting would mean that the first time a user changed their mind mid-phrase,
dictation started silently rewriting that word forever. Twice is cheap for a real
mishearing — it recurs every time the word is said — and expensive for a
coincidence. Until then the Settings row says *Learning* rather than showing a
count, because a list of guesses should not look like a list of rules.

A second, different correction of the same original follows one blunt rule: **the
newer correction wins unless the standing one has already been confirmed.** Seen
once is a guess and a fresher guess is better; seen twice is a habit and stays.
It costs the ability to re-learn a confirmed pair a different way — deleting the
row in Settings is how that is done, which is a thing the user can see, unlike a
scoring rule.

### Applied in the app, at the final fold

`DictationCoordinator.applyLexicon` runs once, in `finishUp`, right after the
last partial is folded in and right before the `done` downlink — the first moment
the transcript is finished and the last before the keyboard reads it. Mid-session
is excluded on purpose: the relay is still revising those words, and the keyboard
has already typed them.

It rewrites **only the tail the keyboard has not typed yet.** The keyboard
inserts settled text as it arrives and keeps its place with a plain character
count (`Uplink.insertedCount`); rewriting text already in the user's document
would move that boundary out from under it and the next insertion would be
spliced in at the wrong offset — a correction bought at the price of mangling the
sentence around it. Once insertion becomes one shot at `done` (#309) the boundary
is zero and the whole transcript goes through the dictionary, which is where this
wants to end up.

Application itself is three rules, each of them a way of not doing damage: only
confirmed pairs; longest original first (with both `parley` and `parley cloud` on
file the longer has to win, or it comes out as neither); and word boundaries with
case-insensitive matching for an all-ASCII original against a plain substring
replacement for CJK, which is what makes `api` leave the `api` inside `rapid`
alone while 在 → 再 works at all. A pair whose replacement properly contains its
original is never applied — it would grow the text on every pass.

### Known follow-up: recognition context

The dictionary currently only rewrites text after the fact. Biasing recognition
*at the source* would be better and the terms are ready for it
(`LexiconStore.recognitionTerms`), but the wire is deliberately untouched:
Soniox's config frame takes a `context.terms` list and the desktop fills it
(`src-tauri/src/transcription/soniox.rs`), while `SonioxProtocol.Config` on the
phone carries no such field. Whether the hosted relay forwards a `context` from
an iOS client cannot be established from this side, and a config frame the relay
rejects costs the user dictation altogether — so adding it is a separate change,
made against a relay whose behaviour has been confirmed.

## Action Button / Control Center trigger

`StartDictationIntent` (an `AudioRecordingIntent`, iOS 18+) starts dictation
**without leaving the current app at all** — the intent runs in the app's process
in the background with a recording assertion, so the mic opens with no jump and
no swipe. Whatever Parley keyboard is frontmost inserts the text through the same
App Group path. This is the lowest-friction trigger and sidesteps the whole
auto-return problem; the keyboard button remains the discoverable default.

## The keyboard's face

The extension is a `UIInputViewController` hosting one SwiftUI tree
(`KeyboardRootView`). It is a **list of panes under one strip**: the voice pane
first, then the typing keyboards the user has switched on — English, 注音, or
both. `TypingKeyboards` (ParleyKit) holds that list in the App Group's
`UserDefaults` and the extension re-reads it on every `viewWillAppear`, because
there is no notification an extension without Full Access is allowed to receive
and a setting does not need one: whoever flipped it in Parley is not typing at
that moment.

`UserDefaults` rather than a `DictationChannel` mailbox for the same reason —
the mailboxes need Full Access, and the pane list must not.

### What a keystroke redraws

The controller talks to SwiftUI through one `ObservableObject`,
`KeyboardBridge`, and every keystroke publishes on it — the 注音 composition and
its candidates, the English suggestions, and while dictating the microphone
level twelve times a second. Until 1.20 every typing pane held the bridge as
`@ObservedObject`, and so did `SymbolPlanes` and `ReturnKey` inside them, so
each of those publishes re-evaluated **every pane on the track**, the
off-screen ones included: one 注音 keystroke re-diffed the 注音 pane's 41 keys
*and* the QWERTY pane's, about seventy key bodies, to draw keys none of which
had changed. That is where the owner's "注音 typing lags" pointed.

So the panes do not observe the bridge any more. They hold it for its actions
only, take what they actually draw — `dark`, `showsGlobe` and a
`ReturnKeyStyle` (the return key's word, glyph and tint as one value) — as plain
parameters, and are `Equatable` on those; `KeyboardRootView` wraps them in
`.equatable()` and SwiftUI skips their bodies whenever those values are
unchanged, which on a keystroke is always. A pane still redraws for its own
`@State` — shift, the symbol planes — and there `KeyButton` and `DeleteKey`,
also `Equatable` on their looks, keep the keys that did not change from being
re-evaluated. The strip is the one thing a keystroke should redraw, and it now
invalidates once per key rather than twice: the composition and its
candidates are one published `ZhuyinStrip`, the English word and its
suggestions one `EnglishStrip`.

The rule this leaves: **a view below the root takes values, not the bridge.**
Anything that observes it re-evaluates on every key and every microphone
reading.

### Painting the backdrop

Until 1.21 the keyboard drew **no canvas of its own**. `view.backgroundColor` was
clear, the SwiftUI root was clear, and the system's own `UIInputView` showed
through. That was a deliberate answer to a real bug: the input view is already
the exact colour iOS uses, already rounds its corners the way the host expects
and already covers exactly the area the system keyboard would, and the canvas
painted over it before that had been a slightly wrong grey that seamed against
whatever sat below the keyboard, with a top-left corner that didn't line up —
which is precisely how the bug reported as 跑版 looked.

What that answer cost was ownership of one of the three colours on screen. The
caps and the ink were this keyboard's decision, made from `isDark`; the backdrop
was the system's, made from the trait collection. Any time the two decisions
came out differently, the keyboard drew one appearance on top of the other. 1.19
did it in Claude and LINE (white caps on a dark backdrop); 1.20 fixed that by
teaching `isDark` to believe a host that reports the opposite of the system
style — and #441 is the other side of the same coin: Apple Notes in Dark Mode
reports `.light` while the trait is dark, so 1.20 drew white caps and near-black
candidates on the system's black backdrop, and the candidates disappeared. As
long as two sources pick the colours, some host will make them disagree, and the
ink is always the part that stops being readable.

So the keyboard paints the backdrop again, and **one value drives all three**:
`refreshAppearance()` reads `isDark` once and repaints the backdrop
(`KBTheme.backdrop(dark)`) and rebuilds the SwiftUI root from it, on every
appearance, every `textDidChange` and every trait change. Caps, ink and canvas
can no longer come from two answers, because there is only one.

What made the old canvas seam was not the painting itself but how it was
painted, and each cause has an answer now:

- **The grey is measured, not remembered.** With the system keyboard up in
  Reminders on the iOS 26.5 simulator, the pixels between keys are
  **`#E2E4E8`** in light mode and **`#171717`** in dark (the same 23 the dark
  caps were measured against, below). The iOS 18-era values in #441 (`#D1D3D9`,
  `#2B2B2B`) are visibly off on iOS 26.
- **The backdrop stays inside the system's card.** On iOS 26 the system draws
  the keyboard as a card whose continuous top corners begin at the top of our
  view, reach the screen edge only about 37pt down, and in light mode carry a
  2px rim down the sides and along the top. A full-width
  `view.backgroundColor` — the obvious way to paint — poked square corners out
  of that curve and covered the rim, which is the old top-left misalignment in
  new clothes. The backdrop is therefore its own `UIView` behind the SwiftUI
  root, **1pt inside the view on the top and both sides, with 32pt continuous
  top corners** (`KBMetrics.backdropInset`, `backdropCorner`). That shape lies
  inside the card everywhere; the sliver of card it leaves is the same grey, so
  it cannot be seen, and the rim and the corner stay the system's. Zoomed
  screenshots of all four edges, light and dark, show no step.
- **Nothing else tints it.** The hosting view stays clear. The sub-visible
  fills that make empty points take touches (see *The strip takes touches
  everywhere*) are the backdrop's own colour at 1% (`KBTheme.hitFill`) rather
  than white: white at 1% lifted the dark backdrop from 23 to 25 over exactly
  the SwiftUI area, a two-level step against the home indicator's strip.

One limit is the system's, not ours. iOS 26's light keyboard is glass: over a
white host it is `#E2E4E8`, over Safari's `#F2F2F7` it is `#DFE0E6`, and the
globe-and-dictation strip the system draws under third-party keyboards is that
glass too. An opaque backdrop cannot follow it, so over a light-grey host the
line where our view meets that strip carries a step of about three levels. The
dark keyboard measured the same `#171717` over every host tried.

The dark caps are measured against the same backdrop: iOS 26.5 draws every key
at sRGB 61/255 over a backdrop of 23, so `KBTheme.key(true)` is
`Color(white: 0.24)`. iOS 26 no longer draws the non-letter keys a different
grey; ours keep a darker `keyAlt` (0.17) anyway, because an engaged shift is
shown by borrowing the letter cap and would otherwise have no way to look armed.
The candidate ink is `KBTheme.ink` — `Color(white: 0.08)` (sRGB 20) in light,
white in dark — which is **14.5:1** against `#E2E4E8` and **17.9:1** against
`#171717`, far above WCAG's 4.5:1.

Two more pieces of the same recipe:

- `inputView?.allowsSelfSizing = true`, with the height constraint at
  `UILayoutPriority(999)`. Without self-sizing the system treats a height
  constraint as advisory, so the keyboard renders at a height nobody asked for.
  999 rather than required still lets a compact-height (landscape) layout shrink
  the keyboard instead of breaking the constraint.
- The SwiftUI host is pinned to `view.safeAreaLayoutGuide` **vertically** and to
  the full width horizontally: key rows are supposed to reach the screen edges
  the way system keys do, but the bottom row must not slide under the home
  indicator. The height constraint therefore measures the pane height *plus*
  `view.safeAreaInsets.bottom`, and is recomputed in
  `viewSafeAreaInsetsDidChange`.

Every measurement lives in `KBMetrics` (`KeyboardTheme.swift`) so the view and
the height constraint can't disagree — a disagreement is a seam. The key
geometry is the system portrait keyboard's: 42pt caps, 11pt between rows, 6pt
between keys, 3pt at the screen edge. That puts the QWERTY pane's key area at
213pt (≈ the system's 216pt).

**Every other pane is measured to come out at 213pt too**, so all of them are
251pt tall including the strip. That equality is load-bearing rather than tidy:
the panes are one swipe apart, and a keyboard that changes height mid-swipe
shoves the host app's content up and down every time the user crosses between
them. Change one pane's numbers and the others have to follow.

The two panes that aren't QWERTY get there differently, and both are worth
knowing about:

- The **voice pane** is arranged from round buttons and whitespace — 16 + 74 +
  12 + 100 + 11 — and the whitespace is what was tuned until it landed on 213.
- The **注音 pane** has five rows where QWERTY has four, so it cannot keep 42pt
  caps. `KBMetrics.zhuyinKeyHeight` is therefore *derived* — (213 − 8 − 4 − 4×7)
  ÷ 5 ≈ 34.6pt — rather than picked. Shorter 注音 caps are also what iOS's own
  注音 keyboard does, for exactly this reason.

#### Which appearance

`KeyboardViewController.isDark` is now two lines:

- **The trait collection first.** The system picks its own chrome — the card,
  the globe-and-dictation strip under a third-party keyboard — from
  `traitCollection.userInterfaceStyle`, so that is the one signal that agrees
  with everything around the keyboard.
- **A host asking for `.dark` is an additional way in.** A dark-themed app on a
  light phone gets a dark keyboard.
- **A host's `.light` never overrides a dark trait.** That is the Notes case.
  Believing `.light` could only ever be right for a light-themed app on a dark
  phone, which would get a light keyboard against a dark screen; believing it
  wrongly is what made the candidates invisible. With the backdrop ours, a dark
  keyboard is readable in either case, so the case given up is the one that
  costs nothing.

`hostAppearance`, `hostFollowsSystem` and `readHostAppearance` — the machinery
1.20 needed to guess which hosts meant their report — are gone. One piece of it
survives in a narrower form, because the simulator showed the regression without
it: Reminders and Safari report `.dark` while the phone is dark and **keep
reporting it after the user flips to light with the keyboard on screen**; typing
does not refresh it, only activating the field again does. Taken at its word
that `.dark` kept the keyboard dark on a light phone, above a system strip that
had already turned light. So `staleHostDark` sets aside a `.dark` that was
already there when the trait went from dark to light, until the field is read
again (`viewWillAppear`, or a `textDidChange` that sees any other value). The one
host this misjudges is a dark-themed app on a phone flipped from dark to light:
it gets a light keyboard until the field is next activated — readable, and
corrected on the next appearance.

### Mode strip

Across the top: the **Parley wordmark** on the left, and on the right the panes
as **named tabs** — a small segmented control sized to the 38pt strip, the
current pane on a key-cap-coloured capsule that slides when the pane changes.
The names are *Voice*, *English*, and *注音* — which keeps its own name in both
localizations, because the keys on that pane are 注音 and no English word
identifies it faster.

The tabs have been three things. A two-segment control first, dropped because it
read as the *only* way across and hid the fact that the pane swipes at all. Then
one dot per pane, long for the current one, on the theory that dots say "there
is another one of these, sideways" — and in use nobody took the dots for a
control, so the switch was invisible to exactly the user who never thinks to
drag. So the panes are named again, and the two ways across now coexist: **the
panes sit side by side on a track that follows the finger**, and the tabs are
the second door, not the first. A `DragGesture` with a 24pt minimum distance
drives the track's offset live and commits past a 56pt threshold, so a mistyped
key is never read as a swipe but a real drag shows the next pane arriving. The
previous gesture only committed on release — nothing moved while the finger did,
which is why nobody found it.

The track reads the touch *alongside* the keys (`simultaneousGesture`) rather
than competing with them, and disables the panes for as long as its drag is in
flight. A plain `.gesture` on the track lost to whatever the finger landed on: a
`Button` holds the touch until it lifts, so a swipe that began on a key only
registered at release and never followed the finger, and the zero-distance drag
behind ⌫ took the touch outright — which on the voice pane, where the record
button is the one big target, read as "only the record button swipes". Once the
track has engaged, the key under the finger is cancelled the way a scroll view
cancels a button's touch when it starts to scroll, so the swipe neither types
the key nor leaves ⌫ repeating (`RepeatingKey` keeps its press in a
`@GestureState`, which resets on that cancellation).

That arbitration was only half of it, and the half that could be tested off
the phone. On iOS a **fully transparent point of the keyboard never receives the
touch at all**: the voice pane is mostly empty space over the system's own
`UIInputView`, so a finger that landed anywhere but a drawn control went
nowhere, and the track's `contentShape(Rectangle())` could not change that from
inside SwiftUI. The track therefore carries a fill at 1% white, below what the
eye can see in either appearance and above what hit-testing ignores. It covers
the gaps between keys on the typing panes too. Measured on the iPhone 17 Pro
simulator (iOS 26.3): before, a swipe from the voice pane's blank space did
nothing while one from the record button switched panes; with the fill, both do,
and so does a swipe from between two rows of English keys.

A swipe moves **one pane**, clamped rather than wrapped, with the track rubber-
banding at both ends. Clamped because the rubber band is a promise that there is
nothing further that way, and a swipe that jumped from 注音 back to the mic
would contradict it two panes later.

The strip defaults to the first typing pane when there is no Full Access,
because that is the pane that still works in that state.

While 注音 is being typed the strip gives its whole row over to the
composition — every syllable still pending, space-separated — and the candidates
for the oldest of them; see below. It is the one row the keyboard has to spare,
and a candidate bar of its own above the keys would make that pane taller than
its neighbours every time somebody started a word.

### English pane

A real QWERTY plane — `qwertyuiop` / `asdfghjkl` (inset half a key, as iOS does)
/ shift + `zxcvbnm` + delete / `123` + globe (only where the system asks for
one) + `@` + space + return — over the
two symbol planes everyone expects: `1234567890` / `-/:;()$&@"` and
`[]{}#%^*+=` / `_\|~<>$£¥•`, sharing a punctuation row and a bottom row.

Those two planes are `SymbolPlanes`, a view of its own, because the 注音 pane
reaches the same two through the same `123` key. They fit either side without
resizing the keyboard: four 42pt rows is exactly what QWERTY measures, so `123`
from the shorter 注音 rows still lands on 213pt.

Layout is arithmetic rather than a table: one key is the unit (`KeyRowMetrics`),
every wide key is expressed in units, so the rows line up on a 320pt SE and a
440pt Pro Max alike — and the same arithmetic does 大千's eleven-key top row by
being told there are eleven columns instead of ten.

The behaviours that make it feel like a keyboard rather than a grid of buttons:

- **Shift** is three-state. Tap arms it for one letter; a second tap within
  0.3 s locks it (`capslock.fill`); a slow tap turns it off. An armed shift
  borrows the light letter-key cap, the way iOS signals it.
- **Delete repeats while held** — ~0.4 s before it starts, then ~0.1 s a tick,
  matching the system key. It can't be a `Button` (a button only reports on
  touch-up), so it is a zero-distance drag gesture driving a `KeyRepeater`.
- **Double-tapping space** types `". "` instead of a second space, but only when
  the character before it is a letter or a digit — after punctuation or at the
  start of a line, two taps are two spaces, which is what iOS does.
- **Return always inserts `"\n"`.** The host's `returnKeyType` changes what the
  key *says* (Go / Send / Search / Done / Next) and whether it is tinted, and
  nothing else: a keyboard extension has no public way to fire the host's return
  action, and a key labelled Send that quietly did nothing would be worse than
  one that visibly types.

#### Word suggestions

The 注音 pane has predicted as you type since 1.16; the English pane made you
spell every word out, which is how the owner put it — 「中文有 auto complete 英文
卻沒有」 — and it was the one thing the system QWERTY had that ours did not.

**While the cursor is inside a word, the mode strip is given over to a
suggestion bar**: up to five completions of the run of letters before the cursor,
most frequent first, on the same terms the 注音 composition takes the strip. The
argument is the same one, too — the strip is the one row this keyboard has to
spare, and a bar of its own above the keys would make the English pane taller
than its neighbours every time somebody started a word, which shoves the host
app's content up and down mid-swipe. When the partial word is empty the strip is
the wordmark and the tabs again. A pending 注音 composition wins the row, though
it cannot arise while the English pane is current.

The partial word is the run of letters and apostrophes immediately before the
cursor in `textDocumentProxy.documentContextBeforeInput`, recomputed after every
key this keyboard types and on `textDidChange` — because the cursor can also move
without us, and a bar describing a word that is no longer there would replace the
wrong letters on a tap. "Letter" is Unicode's answer, so `café` is one word.
`WordSuggestions` (ParleyKit) owns that rule and the case rule as pure functions,
because a keyboard extension cannot be unit-tested and a string function can.

**Nothing is ever rewritten without a tap.** Space and punctuation type exactly
what was typed; there is no autocorrect, and no space-commits-the-suggestion
rule. A keyboard that silently replaces a word it thinks is wrong is worse than
one that suggests nothing — and this keyboard already asks for a lot of trust,
since the personal dictionary learns from what the user retypes. Tapping a
suggestion deletes one scalar per scalar of the partial and inserts the word plus
a space. Case comes from what the user already said with the shift key: a
capitalised partial gets a capitalised word, an ALL-CAPS partial of two letters
or more gets an all-caps word, and one uppercase letter alone is read as a
sentence starting rather than as caps lock.

The user's own `Lexicon` terms are offered ahead of the bundled list — they are
the one source that knows the names and jargon this particular person types. They
live in the App Group, so a keyboard without Full Access simply has none of them
and the list answers alone; that is a supported state, not a failure, and it is
the state App Review 4.4.1 judges the keyboard in. The suggestions themselves
need no network and no App Group at all.

**The data** is `english-words.txt` in ParleyKit: 40,000 lowercase words, 338 KiB,
frequency ordered, generated by `scripts/gen-english-words.mjs` from
hackerb9/gwordlist's `frequency-alpha-alldicts.txt` — the alphabetic words of
Google's Books Ngram corpus verified against dictionaries, sorted by corpus
frequency. **CC-BY 3.0** for the data (that repository's *programs* are GPL and
are not used); the notice is in `ios/THIRD-PARTY.md`, and the download is pinned
to a commit stamped into the resource's header, exactly as the 注音 tables are.
Lists that were rejected on licensing, so nobody re-litigates it: Norvig's
`count_1w` (LDC-derived, terms unclear), hermitdave/FrequencyWords (CC-BY-**SA**),
SUBTLEX (non-commercial), google-10000-english (LDC-derived).

A corpus of books from 1880 onward has two blind spots a keyboard cannot live
with: Google's tokenizer splits every contraction, so there is not one apostrophe
in 246,591 rows, and it is too old for words like `app` and `wifi`. The generator
adds a short hand-written supplement for both, scored as if the corpus had seen
each word 50 million times — the same device, for the same reason, as
`CONVERSATIONAL` in `gen-zhuyin-phrases.mjs`.

`EnglishWords` reads the file the way `ZhuyinPhrases` reads its table: **lazily,
once, and warmed off the main thread** when the English pane becomes current (and
in `viewDidLoad` when the keyboard opens on it, which every keyboard without Full
Access does). Rank is the file's order and nothing else. What it builds at load
is the other order — the same words sorted alphabetically with each word's rank
beside it — so a prefix is a contiguous range found by binary search and the
answer is the lowest-ranked few in that range. A linear pass over 40,000 words
per keystroke is the kind of cost that turns into dropped keys on an old phone;
the only expensive case left is a one-letter prefix, and by the third letter the
range is a handful. A missing resource answers nothing rather than crashing.

### Voice pane

**A control panel, not a keyboard.** Nothing on this pane types a letter, so it
borrows none of UIKit's key-cap treatment — no raised caps, no hard shadows, no
inverted press. It is a fixed-height text slot over a ⌀80 record button with
three ⌀44 translucent discs arranged around it:

```
        live transcript (74pt, three lines, bottom-aligned)

   ✕ (while listening)                        ⌫
   @                    ◉  record
                                              ⏎
```

`⌫` and `⏎` stack on the right, where a right thumb falls, because they are the
edits a dictating user actually reaches for. `@` takes the bottom-left corner —
low-frequency, and the corner the system's own globe occupies on the devices
that ask us to draw one (in which case `@` moves up and the globe takes that
corner). **The top-left is empty except during a session**: it is where the
pane breathes, and keeping it that way the rest of the time is what lets `✕`
arrive without the deck reflowing. The two ways out of a dictation end up at
the same height, one disc apart, and nothing else on the pane moves when `✕`
appears or goes.

On the devices that draw their own globe, `@` is in that slot and a session
borrows it. That is the whole cost, and it is the right thing to spend: `@` is
a shortcut for something nobody is doing in the middle of speaking. The globe
below it is never touched — a keyboard you cannot switch away from is a
keyboard you are trapped in.

`✕` is drawn as an ordinary control disc, not in the recording red. The pane
keeps its one colour on the record button, which is *already* red while a
session runs; a second red disc beside it would compete with the control the
user reaches for most, and would read as the more dangerous of the two rather
than the smaller one.

The pane used to be caps — a mic pill flanked by two 56pt caps over a
full-width `return` — and that was the mistake. A cap's raised look says "there
are twenty-six of these, start typing"; on four control buttons it is noise, and
the widest key on the keyboard was the least-pressed one. The voice pane and the
typing panes now read as different kinds of thing, which is itself a signal for
which one you're on.

The record button is one of exactly two places the keyboard is allowed to look
like Parley rather than iOS: idle it carries Pathors' brand gradient (`#1469D4`
→ `#2DB6F3`); listening it goes flat recording red and swells with the voice
inside two rings the voice pushes outward, so "armed" is never something you
have to read out of a gradient — and never needs a second element saying
"Listening…" beside it. The other is the wordmark (`#1469D4` light, `#2DB6F3`
dark). Nothing else on the pane carries a colour, including `⏎` when the host
has asked for an action and `✕` when a session is running.

#### A record button that swells with the voice

The rings used to breathe on a 1.2 s `repeatForever`, and the note beside them
said a real meter would cost more than the reassurance was worth — the audio is
in the app, and streaming levels across the App Group at frame rate is not a
thing a keyboard extension should be doing. Both halves of that were wrong in
the same way. A canned pulse is reassuring in the precise way that is a lie: it
looks identical over a microphone that has stopped hearing anything, which is a
state this feature genuinely reaches (see *When the system takes the
microphone*). And a level is not frame-rate streaming — it is **one `Float`,
twelve times a second, in a mailbox of its own**.

- **Its own mailbox, not a field on the downlink.** The downlink is re-stamped
  only when the transcript moves, and that stamp is the liveness watchdog's
  only input (`Downlink.presumedDeadAt`). A value that moves whether or not a
  word does would refresh it forever, which does not weaken the watchdog but
  switches it off — and several bugs were spent getting it right.
- **12 Hz.** Below ~10 Hz the swell visibly trails the syllable that caused it.
  Above it, each write is a file write plus a Darwin post in a process that is
  usually *backgrounded* while dictating. 12 is also the rate the measurement
  arrives at — `AudioCapture` taps 4096 frames, ~85 ms at 48 kHz — so a faster
  mailbox would mostly republish readings that had not changed.
- **One number, not a trace.** A ring of recent values would let the keyboard
  draw a scrolling waveform; nothing on this pane draws one. The lag the ripple
  needs is derived in the keyboard (a slower copy of the same smoothed value)
  rather than carried on the wire.
- **Silence is the resting state, and it is representable.** A reading at or
  below the floor, a reading older than 0.6 s, an unstamped one and a missing
  file all read as zero. Staleness is what stops a killed app leaving the button
  frozen mid-swell — the keyboard only re-reads on a note, and a dead process
  posts none, so the keyboard also runs one cheap watchdog (waking once per
  stale period, and only while the meter is off its rest) to ask.
- **Smoothed, asymmetrically.** A raw 12 Hz sample twitches, and a meter that
  twitches reads as broken. Each reading moves the drawn value a fraction of the
  way towards it — fast up (~0.25 s to full), slower down (~0.5 s) — so the
  swell lands with the syllable and what happens between words is a settle
  rather than a collapse.
- **The ripple travels because it is late.** The outer ring is driven by the
  same value put through a slower filter, so a syllable pushes the inner ring
  out first and the outer one after it. In silence there is no ripple at all:
  the rings leave the view tree, and inside it every opacity is multiplied by
  the value driving it.

Reduce Motion rests the button and drops the rings, which is exactly what
shipped before this change.

The keyboard also has one haptic for the pane's worst moment: the system taking
the microphone is `.heavy` → `.heavy`, a two-beat pattern that deliberately goes
nowhere. Every other beat in `Haptics` moves, and the direction is what says
which way the session went — all of them answer a press. This one answers
nothing the user did, so it has no direction to borrow. Once per transition into
the state, not on every drain that republishes it.

#### Three states, and only one of them is a microphone

The pane used to draw the mic button and *Tap to speak* in every state, so a
keyboard that could not transcribe a word looked identical to one that could —
which is how a feature that was merely not set up got reported as broken. The
glyph is what changed: the colour stays (the button is still the thing to press)
but a **microphone is only drawn when speaking here would actually work.**

| state | button | text slot |
|---|---|---|
| no Full Access | dimmed, mic | *Voice typing needs Full Access* + the Settings path |
| not set up (`!ready`) | gradient, `arrow.up.forward.app` | *Set up voice typing in Parley* / *Tap to open the app* |
| set up (`ready`) | gradient, `mic.fill` | *Tap to speak* |

**The glyph follows readiness, not presence.** There used to be a fourth row
between the last two: set up, but this particular tap would open Parley first,
drawn with the jump glyph and captioned *Dictation starts in Parley*. Since #404
a lingering Parley serves the tap where the user is, so the jump stopped being
the common case — and the owner ruled that a first tap opening the app once is
expected behaviour rather than something the button should warn about. Warning
about it every time made the keyboard look less capable than it is.

`KeyboardBridge.staysPut` and the presence machinery behind it are unchanged and
still used: they are how the *app* decides whether it can answer a start note in
place. They just no longer change what the button looks like. See *Knowing
whether the app is there*.

These are the *idle* states. A live session takes the slot ahead of all four
(the transcript, or the reconnecting line), and so does an error from the last
one — an error names the actual problem, where this table can only name a
destination. So does the one non-error interruption the slot describes for
itself: *Microphone taken by the system. Tap to restart.*, which sits between the
error and the live transcript in the same fixed-height slot. See *When the system
takes the microphone*.

`ready` is the readiness mailbox saying both `signedIn` and `micGranted`; a
missing file counts as not ready. The not-set-up tap **mints no session** — it
opens `parley://` and nothing else, because a start request in that state can
only be answered with a failure, and a pane that flipped to "listening" to show
it would be the same lie in a new state.

The third row is the interesting one, because it describes a tap whose outcome
is not yet known: it goes through the ordinary `startDictation` path, so if the
app is still resident it acks over the Darwin channel within milliseconds and
the pane flips to listening *in place*. Promising the jump and then not making it
is the right way round — the reverse is the bug this whole section is about — and
in practice the user reads the glyph after the button has already become ⏹.

**Return is a glyph, not a word.** The host decides what the key is *called* —
Go, Send, Search — and a 44pt disc has no room for "Search"; `returnKeyGlyph`
maps the type to a symbol instead. What the key *does* is unchanged: it types a
line break, because a keyboard extension cannot fire the host's return action.

**The live transcript.** The settled tail is echoed above the button in a softer
ink, followed by the words not yet settled. This began as an echo — settled text
was already in the document, which is usually hidden behind the keyboard — and
since insertion moved to the end of the session it is the *only* place the words
are visible while they are being spoken. The window is still capped at 140
characters and cleared with the session: a few hundred bytes, not the transcript
history a keyboard extension must not hold. Raising the cap would not show more,
because three lines at this size hold fewer characters than that — it would only
push more of the newest words past the truncation. The slot's height is fixed so
beginning to speak never resizes the keyboard.

### 注音 pane

This section used to be called "No Bopomofo engine — 注音 is the system's job",
and it argued that Chinese input in Parley is dictation while Chinese *typing*
belongs to the system 注音 keyboard. **That is reversed.**

What the old argument missed is what it was actually asking of the user.
Switching to the system 注音 keyboard is not a neutral hop between layouts — it
is leaving Parley's keyboard, and the mic button with it, mid-conversation.
Someone typing Chinese has to give up dictation to do it, which is the one thing
this keyboard exists to offer. "Bundling a Bopomofo engine is a product of its
own" was true about a full IME and beside the point about the pane actually
needed: per-syllable 注音 with a frequency-ordered candidate bar is a week of
work, not a product.

**Measured against the system keyboard, not against a memory of it.** On
iOS 26.5 the system 注音 keyboard does not ask for a tone before it will take the
next syllable. Typing ㄋㄧㄏㄠ straight through leaves a buffer reading
`ㄋㄧ ㄏㄠ` — segmented by the keyboard itself, shown space-separated, with
candidates for it above the keys. SPACE there is not a confirm key: it applies
the **first tone** to the syllable being typed, after which the buffer reads
`ㄋㄧ ㄏㄠˉ`. Tapping a candidate commits, and so does return. Punctuation
commits what was pending before the punctuation itself lands. Its delete key is
not in the function row at all: it sits at the right end of the fourth symbol
row, an eleventh column under `ㄦ`. Rows 2 and 3 are not centred under row 1
either — they are staggered rightwards by roughly one and two thirds of a key
pitch — and `123` and return are about 2.5 keys wide.

The pane now does all of that. Where 1.15 differed, the difference was the
composer's limit rather than a position anybody argued for.

**v1 is 傳統注音: typed continuously, predicted by phrase, converted greedily.**

- **大千 layout**, as it is actually defined: a mapping onto a QWERTY board. So
  the top row is *eleven* keys (`1234567890-`) and the three below it are ten
  symbols each. A tidy 4×10 grid would have to drop `ㄦ`, and 兒/二/而/耳 are not
  optional. 37 symbols + 4 tone marks = 41 keys, which is the whole block.
- **Delete lives in the symbol block, not in the function row.** It used to sit
  between space and return; it is now an eleventh column at the right end of row
  4, under `ㄦ` — where the system's 注音 keyboard keeps it, and where a right
  thumb already is. Rows 2 and 3 are staggered rightwards by one and two thirds
  of a key pitch rather than centred, for the same reason: the shape of the block
  is the thing a 注音 typist has learned, and ours differing from it bought
  nothing. The function row is then `123`, the globe where the system asks for
  one, `，`, space, `。` and return, with `123` and return at 2.5 units each. The pane is
  still five rows and still measures 213pt — none of this moved a height, and it
  could not, because the panes are one swipe apart.
- **Slots inside a syllable, an ordered list of syllables above them.**
  `ZhuyinSyllable` is unchanged: at most one 聲母, one 介音, one 韻母 and one
  tone, so an out-of-order or doubled reading stays unrepresentable rather than
  something to validate after the fact. What changed is the layer above it.
  `ZhuyinComposer` now holds up to `maxPending` (6) syllables in order. A symbol
  extends the last syllable when its slot is empty *and* later than the last slot
  filled; otherwise — the slot is taken, the symbol is out of order, or the last
  syllable already carries a tone — it **starts a new syllable**. The old rule
  that a symbol replaces whatever is in its slot is gone at the composer level,
  because that rule is exactly what made continuous typing impossible: `ㄋㄧ`
  followed by `ㄏ` used to become `ㄏㄧ`. When a seventh syllable starts, the
  first one commits itself at its best guess.
- **A toneless reading is a reading, not an unfinished one.** A syllable carrying
  no tone is matched across all five tones at once, so ㄋㄧㄏㄠ has candidates
  without anyone pressing a tone key. The generated dictionary carries that as
  `~`-prefixed rows: `~ㄋㄧ` is the union of ㄋㄧ / ㄋㄧˊ / ㄋㄧˇ / ㄋㄧˋ / ㄋㄧ˙,
  ordered by each character's corpus frequency across the five. The prefix is not
  decoration. First tone is written with **no** mark, so `ㄋㄧ` already means
  "ㄋㄧ, first tone" and cannot also mean "ㄋㄧ, tone not given"; one of the two
  needs a key of its own, and the toneless one is the one that is new.
- **Tones sharpen the guess; they no longer gate the next syllable.** A tone
  applies to the **last** syllable — `ˊˇˋ˙` with theirs, space with the first,
  since 大千 has no first-tone key — and a second tone key re-tones and
  re-queries, because `ㄕˋ` for `ㄕˊ` is the mistake everyone makes. What a tone
  is no longer is the price of moving on.
- **The bar belongs to the front of the buffer**, not to the syllable under the
  finger. With two or more syllables pending it opens with the **phrases** the
  buffer could still become (see *The phrase table*), then the single characters
  of the oldest syllable not yet converted. Tapping a candidate commits as many
  syllables as it has characters — one character is one syllable, so no span has
  to be carried — and the bar moves on to what is left. **Return** commits every
  pending syllable at its best guess, and otherwise types a line break. **Space**
  is the first tone while the last syllable has no tone, and commits everything
  once it has one. So a sentence stays typeable without ever looking at the bar,
  and choosing one word does not cost the syllables behind it.
- **⌄ opens every candidate as a grid.** The bar shows what fits in one row;
  the ⌄ at its end (only while there are candidates) opens all of them as a
  grid in the 注音 pane's own 213pt key area — `CandidateGrid`, 22pt key-cap
  cells, `max(4, width ÷ 64)` columns, scrolling vertically — in exactly the
  composer's order, never re-sorted. The keyboard's height does not change: the
  grid takes the keys' place rather than growing the keyboard. It *replaces*
  them rather than covering them, because the SwiftUI tree paints no background
  of its own (see *Painting the backdrop*): the pane track is hidden and stops taking
  touches while the grid is up. The strip keeps the reading and flips ⌄ to ⌃ to
  close it; the grid carries its own ⌫ (bottom right, hold-to-repeat), because
  the pane's is hidden with the keys and delete still unwinds the buffer. The
  open state lives on the bridge (`candidatesExpanded`) because the controller
  closes it: whenever the reading empties — a pick that used the last
  syllables, return, space, punctuation, leaving the pane — the grid goes and
  the keys come back. A pick that leaves syllables pending keeps it open with
  their candidates.
- **The strip takes touches everywhere.** A fully transparent point in a
  keyboard extension never receives a touch, and the strip had no fill, so only
  the drawn pixels of a candidate's glyphs were tappable — and of ⌄, just two
  thin strokes. It now carries the same sub-visible fill the pane track does.
- **Two lone 聲母 already predict.** `ㄋㄏ` offers 你好 before a vowel or a tone
  has been typed, because a phrase is matched **by prefix within each
  syllable**: the slots the user has filled must agree with the phrase's
  syllable, `nil` included (`ㄧㄡ` has no 聲母 and does not match `ㄌㄧㄡˊ`), the
  slots they have not filled are wildcards, and a tone is a wildcard until it is
  typed. This is the behaviour the product owner named as the gap — "就算只打
  幾個字的第一個注音，它還是猜得出來" — and it is what the system keyboard does.
- **Delete unwinds the buffer before it reaches the document**: the last
  syllable's tone, then its slots, then the empty syllable itself, and on into
  the syllable before it. Only with nothing pending does it reach the field.
- **Punctuation commits first.** A mark typed from the symbol planes or the
  function row flushes the pending syllables and then lands, rather than
  arriving in front of the word that was being typed.
- **Punctuation is full-width.** Chinese is punctuated with 。，、？！「」, and
  until 1.20 the 注音 pane could only type the ASCII marks it shared with
  QWERTY. Two parts:
  - **「，」 and 「。」 flank space on the function row**: `123`, the globe where
    the system asks for one, `，`, space, `。`, return. This is *not* where the
    system puts them — iOS 26.5's 注音 keyboard has no punctuation on its main
    plane at all (screenshotted in Reminders), so every sentence costs two trips
    to `123`. They go beside space because that is where both thumbs already
    are. `123` and return keep their 2.5 units: on a 320pt SE with the globe,
    space still gets about 81pt (11-column unit ≈ 23.1pt, 2.5 units ≈ 66.7pt).
  - **The symbol planes opened from 注音 are the system 注音 keyboard's planes**
    (`SymbolPlanes(fullWidth: true)`; the rows are in `FullWidthPunctuation`,
    ParleyKit, with tests). Numbers: `1234567890` / `- / ： ； （ ） $ @ 「 」` /
    `#+=` `。 ， 、 ？ ！ .` ⌫. Symbols: `[]{}#%^*+=` / `_ — \ | ～ 《 》 ¥ & ·` /
    `123` `… ， 。 ？ ！ '` ⌫. The system's `^^` emoticon key is replaced by `。`;
    one ASCII `.` stays on the numbers plane for decimals, as it does on the
    system's. Marks with no full-width convention in Taiwanese writing (`$ @ & #
    - /` …) stay ASCII — a `＠` in an email address is a broken address — and
    digits stay half-width. The mapping itself: `, . ? ! : ; ( ) [ ] ' ~ < >` →
    `， 。 ？ ！ ： ； （ ） 「 」 、 ～ 《 》`.
  - **Double-space types 「。」** on the 注音 pane, with no trailing space — the
    full-width mark carries its own. QWERTY keeps `. `.
- **The composition is drawn in the mode strip**, space-separated, rather than as
  marked text in the host's field. `UITextDocumentProxy` does offer
  `setMarkedText(_:selectedRange:)`, and the system keyboard uses exactly that;
  it is not used here because how a host renders and commits marked text is the
  host's business, and a composition that the keyboard cannot see cannot be
  guaranteed to end the way the composer thinks it did. The strip is ours. Six
  syllables and a candidate bar do not both fit in one row, so **the chip shows
  the last two syllables**, behind a `…` when more are pending (VoiceOver still
  reads the whole buffer): the newest syllable is the one being typed, the one
  before it shows the segmentation, and the front of the buffer is on screen
  anyway as the candidates. Until 1.20 the chip showed the whole buffer capped
  at 170pt, which at six syllables left a 320pt phone two or three candidates —
  reported as "only about three characters". The chip is also 15pt now, down
  from 17. Measured on the simulator: the chip for `…ㄖㄣ ㄐㄧㄣ` is 100pt plus a
  6pt gap, a one-character candidate cell 45pt, a two-character phrase 65pt,
  and ⌄ 33pt. So at 320pt (296pt of strip) the bar has 157pt — three and a half
  single characters, or two and a half phrases — and at 402pt (iPhone 17 Pro)
  239pt, three and a half phrases. `ZhuyinComposer.maxPending` is unchanged.
- Leaving the pane commits what was pending — the user swiped, they didn't press
  delete. Coming back to a *different* field drops it, the same rule the
  transcript tail follows and for the same reason.

**Nothing commits itself on the way past.** The rule that starting a syllable
confirmed the one before it went with one-at-a-time: starting the next syllable
only appends. Every commit is one of five deliberate things — tapping a
candidate (the first pending syllable), return, space on a last syllable that
already carries a tone, punctuation from the symbol planes, leaving the pane
(all of them) — plus the one the buffer forces, a seventh syllable pushing the
oldest out at its best guess.

Everything above is `ZhuyinComposer` in ParleyKit, which never touches the
document: it answers `handled` / `insert(_)` / `passThrough` and the keyboard
does the inserting. That is what makes it testable on a Mac with `swift test`,
and it is why `passThrough` exists at all — space, delete and return keep their
ordinary meanings on every other pane without those panes knowing a composer
exists.

#### The dictionary

`zhuyin-dict.txt` (in ParleyKit's resources) is reading → characters, most
frequent first, generated by `scripts/gen-zhuyin-dict.mjs` from
**McBopomofo's MIT-licensed data**: `BPMFBase.txt` for the readings and
`phrase.occ` for the ordering. Since 1.16 it also carries the `~`-prefixed
toneless rows described above: 1,413 toned rows and 429 toneless ones, about
52,000 characters in all, which takes the file from 94 KiB to 172 KiB. Every
character in a toneless row already appears in a toned one, so what the second
copy buys is one lookup instead of five merged and re-sorted on every keystroke,
in the process that can least afford to do the work. Attribution is in
`ios/THIRD-PARTY.md`; the generator pins the download to a commit and stamps it
into the resource's header, so the committed file names what it was built from.

It is loaded **lazily and once**, on the **first 注音 symbol typed** — a syllable
with no tone already has candidates, so there is no later moment to wait for —
because this process runs against a jetsam limit far tighter than an app's, and a
keyboard opened on the voice or QWERTY pane still never pays for it. Those
~52,000 characters are a few hundred kilobytes resident, and the file's own
string is dropped as soon as it is parsed. Rows are stored with no separator
between characters because every character in the source is exactly one Unicode
scalar, including the ones outside the BMP.

The 大千 table was checked, not eyeballed: McBopomofo's data carries a 大千
keystroke column beside every reading, and the table in `ZhuyinDachen` agrees
with 26,648 of their 26,652 rows (the four misses are typos in their key column,
e.g. `公 ㄍㄨㄥ˙ … ej/5`). That is why the table is written out in Swift rather
than derived from the data.

#### The phrase table

`zhuyin-phrases.txt` (`ZhuyinPhrases`, generated by
`scripts/gen-zhuyin-phrases.mjs`) is what turns the pane from a transcriber into
a predictor. It comes from McBopomofo's `BPMFMappings.txt` — phrase → toned
syllables — which their README marks as simplified from **libtabe's `tsi.src`
(BSD)**; an earlier version of this file skipped it for that second provenance,
and the reason it is in now is that the owner's test against the system keyboard
made the gap concrete: no per-syllable data can answer `ㄋㄏ`, because neither
syllable is finished. libtabe's notice sits beside McBopomofo's in
`ios/THIRD-PARTY.md`.

- **2–4 character phrases only**, one row per (phrase, reading), about 61,000
  rows in 1.7 MB: everything with a corpus count of ten or more, plus every
  zero-count two-character phrase (upstream order is alphabetical, so a prefix of
  the zero-count rows would be a biased slice, and the two-character ones are
  the words). Keeping every count > 0 row was 3 MB and 102,000 rows, which is a
  lot to hold in a keyboard extension for phrases that occur nine times in a
  corpus.
- **Ordered once, at generation time.** The file's order is the ranking and the
  class does no sorting. The score is not raw occurrence: the corpus is written
  news, and by raw count `ㄋㄏ` puts 女孩, 年後, 男孩, 南韓 and 內涵 ahead of 你好
  (12th). So the score is `ln(occ + 1)` plus the mean `ln(charOcc + 1)` of the
  phrase's characters — a phrase built of common characters is more likely to be
  the word somebody is typing into a message than one built of rare ones — and a
  short list of everyday words (你好, 謝謝, 請問, 不好意思, 沒問題 …) is given a
  floor of 3,000 occurrences before scoring, because this keyboard types
  messages and the corpus never did. That list is in the generator with its
  reason, and it is the one place in the data where an opinion was written down.
- **Indexed by the first symbol of each of the first two syllables** — 你好
  lives under `ㄋㄏ` — because two first symbols is the least a user can have
  typed and still be asking a question. A lookup is that bucket filtered
  syllable by syllable with the prefix rule above, split into three groups in
  frequency order: phrases exactly as long as the buffer, longer ones (the
  predictions — `ㄋㄧㄏㄠ` offers 你好嗎 after 你好, and picking it takes the
  whole buffer), and shorter ones covering a prefix of it. Forty at most. Since
  1.20 a lookup can read **more than one bucket**: a wrong first symbol files the
  intended phrase under a different key, so the forgiving half of a lookup (see
  *Error tolerance*) also reads every key a first-symbol substitution could
  reach — the typed symbol or one of its alternatives, for each of the two —
  which is up to about forty buckets for two lone 聲母. The exact half still
  reads only the typed key.
- **`best` is greedy, not a lattice.** Return, space-on-a-toned-syllable,
  punctuation and leaving the pane all commit `best`, which walks the buffer
  left to right taking the longest phrase that exactly covers the syllables in
  front of it (four, then three, then two) and otherwise that syllable's top
  character. Deterministic and explainable, and wrong in ways the user can see
  in the bar and fix by tapping instead. A viterbi over the same table is the
  obvious next step and is not this one.
- **Loaded lazily, warmed early, never twice at once.** Parsing and indexing
  61,000 rows is about 100 ms on a current phone, which is not a hitch to spend
  on the user's second syllable. So both tables are warmed on a background
  queue the moment the 注音 pane becomes current. A lookup that arrives before
  the warm has landed **answers nothing** rather than parsing a table of its
  own: until 1.20 it loaded synchronously, and for the length of that parse two
  whole tables and their source strings coexisted — the highest this process's
  memory ever went, in a process iOS kills without warning at its limit. No
  crash was ever matched to it (there was no log to match against); the change
  is preventive. `warm(onReady:)` calls back on the main queue when the table
  lands, and the keyboard uses that to answer whatever is pending again
  (`ZhuyinComposer.refresh()`), so the key that lost the race shows an empty
  bar for a fraction of a second and then the right one. The completion runs in
  the same main-queue block that stores the table, and keys arrive on the main
  queue too, so a key is either before the landing or after it — never in
  between. `EnglishWords` and `ZhuyinDictionary` follow the same contract.
- **Given back under memory pressure.** `unload()` drops the table, and the
  next lookup reads the file again. `didReceiveMemoryWarning` unloads the
  phrase table and the English list when the pane on screen is not using them
  and logs what it dropped (`com.pathors.parley.ios.keyboard`, category
  `memory`), so a sysdiagnose from a keyboard that died has something to say.
  The table under the user's fingers is kept: dropping it would make the next
  keystroke re-parse it at exactly the moment memory is shortest. The 注音
  dictionary is never dropped — a few hundred kilobytes, needed by every key.
- **Readings are packed once, at load.** Until 1.20 a row kept its reading as
  text and it was split and parsed on every keystroke for every row of the
  bucket, on the argument that pre-parsing rows nobody types costs memory. It
  was the other way round: a reading is 20-odd bytes of UTF-8, past the 15 Swift
  keeps inline, so every one of the 61,000 rows owned a heap string. Now each
  syllable is `ZhuyinSyllable.packed` — the 聲母, 介音 and 韻母 as one-based
  indices into their alphabets and the tone, 0 for an empty slot, fourteen bits
  in all — four of them to a `UInt64`, beside a `UInt32` file rank that lets
  rows drawn from several buckets be merged back into file order. A row is the
  phrase (four BMP characters or fewer, so inline too), the reading and the
  rank: 32 bytes, the same stride as the two strings it replaced, with no heap
  behind it. Measured cold in a fresh process, building the index costs about
  12.6 MB of footprint against 15.5 MB before, most of what remains being the
  file and its split lines, which are freed but whose pages stay; after a warm
  the index itself retains about 3 MB. Comparing a slot is now a mask, and a
  keystroke allocates nothing per row.

#### Error tolerance

The owner's report on build 34: one wrong 注音 symbol and the bar was empty,
while the system keyboard still guessed. Both tables matched exactly, so a
syllable nobody pronounces answered nothing and a mistyped real one answered a
different word. Since 1.20 both forgive **one wrong symbol per syllable**, by two
rules kept in `ZhuyinFuzzy`:

- **模糊音 pairs**, both ways: ㄣ/ㄥ, ㄓ/ㄗ, ㄔ/ㄘ, ㄕ/ㄙ, ㄈ/ㄏ, ㄌ/ㄋ, ㄖ/ㄌ. These
  are facts about how Taiwanese speakers talk, so they are written down by hand.
  They are not transitive (ㄋ and ㄖ are not each other's), and ㄧㄣ/ㄧㄥ needs
  no entry because the 介音 is its own slot.
- **Adjacent keys**, computed from `ZhuyinDachen.rows` and the pane's stagger
  (`ZhuyinDachen.rowOffsets`, 0, ⅓, ⅔ and 0 key pitches — kept in step with
  `KeyboardZhuyinPane.swift` by hand): left and right on the row, and on the rows
  above and below every key whose centre is less than one pitch away. That is
  always the same-index key plus one staggered neighbour, whose direction
  depends on the row pair — the fourth row is not staggered, so `ㄋ` (s) sits
  over `ㄏ` (c) and `ㄌ` (x), not over `ㄌ` and `ㄈ` as on a physical board.

Both rules keep to the syllable model: a substitute must be in the **same slot**
as the typed symbol, a tone mark is never substituted and never substitutes, an
empty slot is never filled (a missing symbol is not a wrong one), and a typed
tone is never forgiven. The resulting table is 模糊音 partners first, then
neighbours nearest-centre first — `ㄋ` → ㄌㄇㄎㄊㄍㄏ, `ㄓ` → ㄗㄔㄐ,
`ㄣ` → ㄥㄟㄢㄦㄤㄠ, `ㄧ` → ㄨ.

- **The dictionary** answers the exact row first, untouched, then for each
  variant of the syllable (every syllable one substitution away, 模糊音 ones
  before slips) its first eight characters not already listed. The cap is
  there because the strip draws every candidate and toneless rows run to 441
  characters. A syllable with an exact row keeps its exact top; one with none
  (`ㄓㄨㄡ`) takes the first variant's (中), so return commits a character
  rather than raw 注音.
- **The phrase table** counts, per row, how many typed syllables needed a symbol
  forgiven. Every exact match comes first, in the three groups as before; then
  the forgiving ones, fewest errors first, then the same three groups, then file
  order; forty in all, and a phrase already offered is never offered again. Only
  the best few forgiving matches can reach the bar while two lone 聲母 can match
  five thousand rows, so they are kept in a short sorted list rather than
  collected and sorted, and a tier of buckets whose every row carries more
  errors than the list's worst is not read. So `ㄌㄧㄏㄠ` still offers 良好,
  理好 … first and 你好 right after them, `ㄋㄧㄎㄠ` offers 你好 first, and
  `ㄗㄨㄥ ㄨㄣˊ` offers 中文 first.
- **`best` is stricter than the bar**, because the bar is a list to choose from
  and `best` is text that lands unasked. An exact cover of any length beats a
  forgiven one of any length. A forgiven cover is taken only for a window
  holding a syllable with **no exact row** — one that cannot be right as typed
  — and then the fewest errors win, length breaking a tie. So `ㄓㄨㄡ ㄨㄣˊ`
  commits 中文, but `ㄗㄨㄥ ㄨㄣˊ`, whose syllables are both real readings (從,
  文), commits as typed with 中文 first in the bar. Letting any forgiven cover
  beat one character per syllable was tried first and changed five of twenty
  correctly typed everyday sentences — 他說的人 became 他說到任, 吃飯了麼
  吃飯老馬 — because two real syllables that are not a phrase are exactly where
  a one-symbol-off phrase is always waiting.

The cost, with both tables warm, measured per keystroke on an M4 Mac mini in a
debug build: about 0.1 ms for one syllable, about 1.1 ms for two and for six
pending syllables whose every symbol has alternatives, 0.65 ms for two lone
聲母 (the widest fan-out); a release build is under 0.1 ms throughout. Exact
matching alone was 0.02–0.8 ms in the same debug build. The budget is 8 ms on a
phone.

#### What v1 does not do

Named here so nobody has to guess whether it was forgotten:

- **No lattice.** Phrases are predicted and committed greedily (above); there is
  no viterbi over segmentations, and no 5–6 character phrases. That includes
  error tolerance: `best` weighs a forgiven cover against the covers at the same
  position, never against a whole alternative segmentation.
- **One wrong symbol per syllable, and only a wrong one.** A syllable with two
  substitutions, a missing symbol, an extra one, two symbols swapped between
  syllables, or a wrong tone is not forgiven (see *Error tolerance*).
- **No user dictionary and no learning.** The bar's order is the corpus's, not
  yours. A keyboard extension that accumulated a per-user model would be holding
  state this process is deliberately kept free of.
- **No 漢語拼音 or 倚天 layouts.**
- **No half-width/full-width toggle.** The 注音 pane types full-width marks and
  the English pane ASCII (see *Punctuation is full-width* above); a user who
  wants `,` in Chinese text swipes to English for it.
- **No associated-phrase prompts** after a commit.
- **No unbounded buffer.** Six syllables may be pending; a seventh commits the
  oldest at its best guess. A sentence-length buffer would be a sentence this
  process has to hold, redraw and unwind, and phrases are four syllables at
  most anyway.

What is *not* on this list any more is having to finish a syllable before
starting the next. Until 1.16 a tone key was the only way to move on; that was
the composer's limit, and it read as a rule. Nor, since 1.20, is exact-only
matching: one wrong symbol per syllable no longer empties the bar.

#### The globe, and why it is still not on every device

The old section's argument about the globe survives its reversal, because it was
never really about 注音: App Review asks that a keyboard not trap the user, so
there has to be a way out to another keyboard.

The globe used to be drawn **on every device** rather than only where
`needsInputModeSwitchKey` is true. That was wrong. From iPhone X onwards **iOS
draws the Emoji/Globe and Dictation keys itself**, in the strip beneath a raised
keyboard, over custom keyboards included. That is why `needsInputModeSwitchKey`
returns false there — the system is telling us it has the exit covered — and the
HIG asks explicitly not to repeat it: "Don't duplicate system-provided keyboard
features … avoid causing confusion by repeating them in your keyboard." Drawing
our own was a duplicate key that cost a slot in every pane and made the voice
pane read as crowded.

**Every pane now follows the flag.** Where it is true (older, Home-button
devices) the globe appears — bottom-left in the voice pane, in its usual place in
the QWERTY and 注音 bottom rows. Where it is false the system's own key is the
exit and we draw nothing.

**The system's dictation key in that same strip cannot be removed.** It sits a
thumb's length from our record button and starts Apple's dictation into the
same field, and the owner asked for it to go. `UIInputViewController.
hasDictationKey` is documented as "when set to YES, the system dictation key,
if provided, will be disabled" — measured on iOS 26.5 (iPhone 17 Pro
simulator, a fresh extension process), set in both initialisers and again in
`viewDidLoad`, the key was still drawn and still opened Apple's dictation
prompt. So the property is not set, and the only mitigation is the one the
pane already makes: our record button is the large, coloured, obvious control,
and the system's mic is a small glyph in the bezel strip. A user who wants it
gone can turn off *Enable Dictation* in Settings, which is the system's switch,
not ours.

### Which keyboards are on

`Settings › Keyboards` in the app is one toggle per typing keyboard. The default
before anyone touches it: **English and 注音 for a phone whose language list
includes Traditional Chinese, English alone for everyone else.** The asymmetry is
deliberate — for a Taiwanese user the 注音 pane is the reason to install this
keyboard, and for an English-only user it is a pane of unfamiliar symbols one
swipe from the mic button.

At least one has to stay on, and the way that is said is a toggle that won't move
rather than an alert after the tap. It is also the only reason `TypingKeyboards.enabled()`
can never return empty: a keyboard with no typing pane would leave someone with
Full Access off unable to type at all.

The section sits outside the account gate the dictation sections are behind.
Typing needs neither an account nor Full Access, which is the whole reason the
keyboard has typing panes — see 4.4.1 below.

It is a real `UIButton` behind a SwiftUI cap or disc, wired
whole-touch-sequence to `handleInputModeList(from:with:)`: that selector demands
the live `UIEvent` from a control action, which a SwiftUI gesture has no way to
supply, and it is UIKit's own globe behaviour — a tap advances to the next
keyboard, a hold presents the system keyboard picker, from which 注音 is one
more tap.

## App Review notes

- **4.4.1** (keyboards must work without Full Access): with Full Access off the
  keyboard opens on the first typing pane, and the whole plane, the quick keys,
  the globe and the 注音 pane work normally — none of them need the network or
  the App Group, and the 注音 dictionary is a file inside our own bundle. Only
  dictation is unavailable, and the voice pane says so with a jump to Settings.
- **Never trapping the user**: the exit is the system's own globe on the devices
  that draw one, and ours on the devices that don't — `needsInputModeSwitchKey`
  decides, on every pane. See the 注音 section above.
- **Third-party data**: the 注音 dictionary is generated from McBopomofo's
  MIT-licensed lexicon, and the phrase table from their `BPMFMappings.txt`,
  which descends from libtabe's BSD-licensed `tsi.src`; both notices are in
  `ios/THIRD-PARTY.md`. Nothing with an unclear licence is shipped.
- **2.5.1** (private APIs): the only private code in the project is the
  pre-26.4 auto-return — reading the host's bundle id, and asking
  `LSApplicationWorkspace` to open it — version-gated to where it works. Every
  symbol is assembled from fragments at runtime, so no literal appears in the
  binary, and every failure path returns `nil` rather than guessing. Everything
  the feature actually runs on is public: audio session, openURL, App Group,
  Darwin notifications, insertText, App Intents. Note this path is now live for
  the first time; before the `HostBundleID` fix it was unreachable code.
- **The microphone window** is the one part of this keyboard that holds a
  system resource while the user is elsewhere. Its defence is consent that is
  visible and reversible: see that section.
- Memory: the keyboard process holds no audio, no model, and no transcript
  history — it only shuttles text — to stay under the tight jetsam limit
  keyboard extensions run against. The one file it does read is the 注音
  dictionary, lazily and once; see that section for what it costs.
