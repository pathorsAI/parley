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
   the walk kept only as an older-system fallback).
2. **App records.** `onOpenURL` routes to `DictationCoordinator`, which starts
   the mic + relay and mirrors the growing transcript into a *downlink* file,
   posting a Darwin notification on each update.
3. **Return to the host app** — or, far better, never leave it. See the
   microphone window below.
4. **Keyboard inserts.** On the Darwin note (and on every `viewWillAppear`, in
   case it was suspended through the notification), the keyboard reads the
   downlink and inserts whatever is new past its high-water mark
   (`insertedCount`), so a keyboard that was killed and relaunched mid-session
   never double-inserts. The tentative tail is shown above the keys, never
   inserted.
5. **Stop.** The keyboard's ⏹ writes `stopRequested` and posts the uplink note;
   the app finishes the relay, drains the last utterance, folds the final tail
   into the committed text, and marks the session done.

### App Group channel

`DictationChannel` (in ParleyKit, so both targets share it) is four
single-writer mailboxes, each with its own Darwin notification, so the two
processes never contend on a file:

- `dictation-down.json` — app → keyboard: `{session, committed, partial, state}`.
- `dictation-up.json` — keyboard → app: `{session, hostBundleID, stopRequested,
  insertedCount}`.
- `dictation-window.json` — app → keyboard: `{length, openedAt, expiresAt,
  updatedAt}`, the microphone window and its heartbeat.
- `dictation-window-control.json` — keyboard → app: `{closeRequestedAt}`, the
  keyboard's "end the window now".

The window pair is separate from the session pair because a window outlives any
one dictation, and most of what it has to say happens when no session exists.

The files are the source of truth; the Darwin notes are pure "go re-read"
signals (they carry no payload). This is what makes the hand-off robust to the
keyboard being suspended/killed while the app is foregrounded — whatever it
missed is still in the downlink when it returns.

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

There is also a second, harder reason, and it is the one that makes "keep the
process awake longer" insufficient on its own: **iOS refuses to let a
backgrounded process start recording.** Activating a record session from the
background returns `AVAudioSessionErrorCodeCannotStartRecording` with
`Client … is in the background and doesn't have the entitlement to start
recording in the background` in the log. Apple has never published exactly how
this interacts with `UIBackgroundModes: audio`, and we cannot settle it from a
simulator. A resident process that still could not open the microphone would
have had to come forward anyway.

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

`AudioCapture` is unchanged. `DictationCoordinator` simply stopped treating the
microphone as a session's property: `releaseMicrophone()` at the end of a
dictation either hands it to the window or closes it, and `launch()` reuses
whatever is already running. While no dictation is attached, chunks go into
`RelayAudioBridge` with no leg and no hold, which counts them and drops them —
**an open window records nothing, because there is nowhere for the audio to go.**

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

The negative signal cannot be the mere absence of the chip, so the idle slot
gains a second line — *This tap opens Parley first* — but **only for someone who
has turned a window on**. Without the setting, every tap has always opened
Parley; saying so on every keyboard would be noise rather than information.

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
`staleAfter` (55 s). One mechanism, two jobs: the same heartbeat is what ticks the
chip's countdown without the extension running a timer of its own. Expiry is
still punctual — the app's loop sleeps the *shorter* of a heartbeat and whatever
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

### App Review

The defence is consent that is visible and reversible, in that order: the user
chose the length, the indicator says it is happening, three separate surfaces say
what it means, and each of them ends it. The window is bounded in every case, it
holds no audio, and nothing leaves the device until the mic is tapped. No private
API is involved anywhere in it — audio session, App Group, Darwin notifications,
`insertText`.

### The jump that is left, and what is actually known about it

There is still a first tap, and a tap after a window closes. Those still open
Parley, and the dictation screen still teaches the swipe back (`SwipeBackGuide`).
Two things are worth writing down rather than repeating:

- **On iOS 26.4+ the host app cannot be detected at all.** The private
  bundle-id path returns nil and `UIApplication.suspend()` lands on the Home
  Screen because the app was launched by an extension. Apple's DTS has answered
  that there is no public way to identify the host or to return to it
  (FB22247647 remains open). The destination does not have to be *detected*
  though — it can be *chosen*, which is how KeyboardKit 10.4 handles it, and is
  tracked separately.
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
  never takes you back. **Whether the returned id actually gets a pre-26.4 user
  home is still unverified** — it needs a device below 26.4.

Neither is why the reported bug happens, which is worth being clear about: the
report is that dictation *leaves*, and leaving is what the window fixes.

## Action Button / Control Center trigger

`StartDictationIntent` (an `AudioRecordingIntent`, iOS 18+) starts dictation
**without leaving the current app at all** — the intent runs in the app's process
in the background with a recording assertion, so the mic opens with no jump and
no swipe. Whatever Parley keyboard is frontmost inserts the text through the same
App Group path. This is the lowest-friction trigger and sidesteps the whole
auto-return problem; the keyboard button remains the discoverable default.

## The keyboard's face

The extension is a `UIInputViewController` hosting one SwiftUI tree
(`KeyboardRootView`). It is two panes under one strip.

### Not painting a background

The keyboard draws **no canvas of its own**. `view.backgroundColor` is clear,
the SwiftUI root is clear, and the system's own `UIInputView` shows through.
This is not a style choice: the input view is already the exact colour iOS uses,
already rounds its corners the way the host expects, and already covers exactly
the area the system keyboard would. A canvas painted over it is a slightly wrong
grey that seams against whatever sits below the keyboard and a top-left corner
that doesn't line up — which is precisely how the bug reported as 跑版 looked.

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

**The voice pane is measured to come out at 213pt too**, so both panes are
251pt tall including the strip. That equality is load-bearing rather than tidy:
the panes are one swipe apart, and a keyboard that changes height mid-swipe
shoves the host app's content up and down every time the user crosses between
them. Change one pane's numbers and the other has to follow.

### Mode strip

Across the top: the **Parley wordmark** on the left, and on the right the
current pane named beside two dots — a long one for where you are, a short one
for the pane you haven't got to. The dots stay tappable, so nothing is lost.

This replaced a two-segment control, which read as the *only* way across and
hid the fact that the pane swipes at all. **The panes sit side by side on a
track that follows the finger**: a `DragGesture` with a 24pt minimum distance
drives the track's offset live and commits past a 56pt threshold, so a mistyped
key is never read as a swipe but a real drag shows the other pane arriving. The
previous gesture only committed on release — nothing moved while the finger did,
which is why nobody found it.

The strip defaults to the keyboard pane when there is no Full Access, because
that is the pane that still works in that state.

### EN mode

A real QWERTY plane — `qwertyuiop` / `asdfghjkl` (inset half a key, as iOS does)
/ shift + `zxcvbnm` + delete / `123` + globe (only where the system asks for
one) + `@` + space + return — plus the
two symbol planes everyone expects: `1234567890` / `-/:;()$&@"` and
`[]{}#%^*+=` / `_\|~<>$£¥•`, sharing a punctuation row and a bottom row.

Layout is arithmetic rather than a table: one letter key is the unit, every wide
key is expressed in units, so the rows line up on a 320pt SE and a 440pt Pro Max
alike.

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

### Voice mode

**A control panel, not a keyboard.** Nothing on this pane types a letter, so it
borrows none of UIKit's key-cap treatment — no raised caps, no hard shadows, no
inverted press. It is a fixed-height text slot over a ⌀80 record button with
three ⌀44 translucent discs arranged around it:

```
        live transcript (74pt, three lines, bottom-aligned)

                                              ⌫
   @                    ◉  record
                                              ⏎
```

`⌫` and `⏎` stack on the right, where a right thumb falls, because they are the
edits a dictating user actually reaches for. `@` takes the bottom-left corner —
low-frequency, and the corner the system's own globe occupies on the devices
that ask us to draw one (in which case `@` moves up and the globe takes that
corner). **The top-left is deliberately empty**: it is where the pane breathes.

The pane used to be caps — a mic pill flanked by two 56pt caps over a
full-width `return` — and that was the mistake. A cap's raised look says "there
are twenty-six of these, start typing"; on four control buttons it is noise, and
the widest key on the keyboard was the least-pressed one. The two panes now read
as different kinds of thing, which is itself a signal for which one you're on.

The record button is one of exactly two places the keyboard is allowed to look
like Parley rather than iOS: idle it carries Pathors' brand gradient (`#1469D4`
→ `#2DB6F3`); listening it goes flat recording red inside two rings breathing
outward, so "armed" is never something you have to read out of a gradient — and
never needs a second element saying "Listening…" beside it. The other is the
wordmark (`#1469D4` light, `#2DB6F3` dark). Nothing else on the pane carries a
colour, including `⏎` when the host has asked for an action.

**Return is a glyph, not a word.** The host decides what the key is *called* —
Go, Send, Search — and a 44pt disc has no room for "Search"; `returnKeyGlyph`
maps the type to a symbol instead. What the key *does* is unchanged: it types a
line break, because a keyboard extension cannot fire the host's return action.

**The live transcript.** The settled tail is echoed above the button in a softer
ink, followed by the words not yet settled. Settled text has already been
inserted into the document — but the document is usually behind the keyboard, so
without the echo dictation reads as words that appear and then vanish. The
window is capped at 140 characters and cleared with the session: a few hundred
bytes, not the transcript history a keyboard extension must not hold. The slot's
height is fixed so beginning to speak never resizes the keyboard.

### No Bopomofo engine — 注音 is the system's job

**Parley deliberately ships no Chinese input engine.** A keyboard extension
cannot reach the system's Chinese input engine, and bundling a Bopomofo engine
(a phonetic table, a candidate bar, a user dictionary) is a product of its own,
not a round of polish on a dictation keyboard. Chinese input in Parley is
dictation; Chinese *typing* belongs to the system 注音 keyboard.

That made the globe look load-bearing, and it used to be drawn **on every
device** rather than only where `needsInputModeSwitchKey` is true. That was
wrong, and it is the one decision in this document that has been reversed.

From iPhone X onwards **iOS draws the Emoji/Globe and Dictation keys itself**,
in the strip beneath a raised keyboard, over custom keyboards included. That is
why `needsInputModeSwitchKey` returns false there — the system is telling us it
has the exit covered — and the HIG asks explicitly not to repeat it: "Don't
duplicate system-provided keyboard features … avoid causing confusion by
repeating them in your keyboard." Drawing our own was a duplicate key that cost
a slot in both panes and made the voice pane read as crowded.

**Both panes now follow the flag.** Where it is true (older, Home-button
devices) the globe appears — bottom-left in the voice pane, in its usual place
in the QWERTY bottom row. Where it is false the system's own key is the exit and
we draw nothing. Either way a 注音 user is always one obvious tap from leaving,
which is what App Review actually asks for.

It is a real `UIButton` behind a SwiftUI cap or disc, wired
whole-touch-sequence to `handleInputModeList(from:with:)`: that selector demands
the live `UIEvent` from a control action, which a SwiftUI gesture has no way to
supply, and it is UIKit's own globe behaviour — a tap advances to the next
keyboard, a hold presents the system keyboard picker, from which 注音 is one
more tap.

## App Review notes

- **4.4.1** (keyboards must work without Full Access): with Full Access off the
  keyboard opens on the QWERTY pane, and the whole plane, the quick keys and the
  globe work normally — none of them need the network or the App Group. Only
  dictation is unavailable, and the voice pane says so with a jump to Settings.
- **Never trapping the user**: the exit is the system's own globe on the devices
  that draw one, and ours on the devices that don't — `needsInputModeSwitchKey`
  decides, in both panes. See the 注音 section above.
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
  keyboard extensions run against.
