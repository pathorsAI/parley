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

### App Group channel

`DictationChannel` (in ParleyKit, so both targets share it) is five
single-writer mailboxes, each with its own Darwin notification, so the two
processes never contend on a file:

- `dictation-down.json` — app → keyboard: `{session, committed, partial, state}`.
- `dictation-up.json` — keyboard → app: `{session, hostBundleID, stopRequested,
  insertedCount}`.
- `dictation-window.json` — app → keyboard: `{length, openedAt, expiresAt,
  updatedAt}`, the microphone window and its heartbeat.
- `dictation-window-control.json` — keyboard → app: `{closeRequestedAt}`, the
  keyboard's "end the window now".
- `dictation-ready.json` — app → keyboard: `{signedIn, micGranted, updatedAt}`,
  whether a tap could dictate at all.

The window pair is separate from the session pair because a window outlives any
one dictation, and most of what it has to say happens when no session exists.

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

The negative signal cannot be the mere absence of the chip. It used to be a
second line under *Tap to speak* — *This tap opens Parley first* — shown only to
someone who had turned a window on, on the grounds that without the setting
every tap had always opened Parley and saying so would be noise. That reasoning
was wrong in the one way that mattered: the headline still said *Tap to speak*,
which is a promise about this keyboard, and the button still drew a microphone.
The fix is in the state list below — the promise now lives in the headline and on
the button's own glyph, so the caption has nothing left to add and is gone.

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

### Mode strip

Across the top: the **Parley wordmark** on the left, and on the right the
current pane named beside one dot per pane — a long one for where you are, short
ones for the panes you haven't got to. The dots stay tappable, so nothing is
lost. The names are *Voice*, *English*, and *注音* — which keeps its own name in
both localizations, because the keys on that pane are 注音 and no English word
identifies it faster.

This replaced a two-segment control, which read as the *only* way across and
hid the fact that the pane swipes at all. **The panes sit side by side on a
track that follows the finger**: a `DragGesture` with a 24pt minimum distance
drives the track's offset live and commits past a 56pt threshold, so a mistyped
key is never read as a swipe but a real drag shows the next pane arriving. The
previous gesture only committed on release — nothing moved while the finger did,
which is why nobody found it.

A swipe moves **one pane**, clamped rather than wrapped, with the track rubber-
banding at both ends. Clamped because the rubber band is a promise that there is
nothing further that way, and a swipe that jumped from 注音 back to the mic
would contradict it two panes later.

The strip defaults to the first typing pane when there is no Full Access,
because that is the pane that still works in that state.

While a 注音 syllable is being typed the strip gives its whole row over to the
composition and its candidates — see below. It is the one row the keyboard has
to spare, and a candidate bar of its own above the keys would make that pane
taller than its neighbours every time somebody started a word.

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

### Voice pane

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
the widest key on the keyboard was the least-pressed one. The voice pane and the
typing panes now read as different kinds of thing, which is itself a signal for
which one you're on.

The record button is one of exactly two places the keyboard is allowed to look
like Parley rather than iOS: idle it carries Pathors' brand gradient (`#1469D4`
→ `#2DB6F3`); listening it goes flat recording red inside two rings breathing
outward, so "armed" is never something you have to read out of a gradient — and
never needs a second element saying "Listening…" beside it. The other is the
wordmark (`#1469D4` light, `#2DB6F3` dark). Nothing else on the pane carries a
colour, including `⏎` when the host has asked for an action.

#### Four states, and only one of them is a microphone

The pane used to draw the mic button and *Tap to speak* in every state, so a
keyboard that could not transcribe a word looked identical to one that could —
which is how a feature that was merely not set up got reported as broken. The
glyph is what changed: the colour stays (the button is still the thing to press)
but a **microphone is only drawn when speaking here would actually work.**

| state | button | text slot |
|---|---|---|
| no Full Access | dimmed, mic | *Voice typing needs Full Access* + the Settings path |
| not set up (`!ready`) | gradient, `arrow.up.forward.app` | *Set up voice typing in Parley* / *Tap to open the app* |
| set up, no open window | gradient, `arrow.up.forward.app` | *Dictation starts in Parley* |
| microphone window open | gradient, `mic.fill` | *Tap to speak* |

These are the *idle* states. A live session takes the slot ahead of all four
(the transcript, or the reconnecting line), and so does an error from the last
one — an error names the actual problem, where this table can only name a
destination.

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

**v1 is 傳統注音, one syllable at a time.**

- **大千 layout**, as it is actually defined: a mapping onto a QWERTY board. So
  the top row is *eleven* keys (`1234567890-`) and the three below it are ten,
  centred by the same half-key inset QWERTY's home row uses. A tidy 4×10 grid
  would have to drop `ㄦ`, and 兒/二/而/耳 are not optional. 37 symbols + 4 tone
  marks = 41 keys, which is the whole block.
- **Slots, not a string.** `ZhuyinSyllable` is at most one 聲母, one 介音, one
  韻母 and one tone, so a symbol *replaces* whatever is in its slot. Typing
  `ㄅㄆ` leaves `ㄆ`. An out-of-order or doubled reading is unrepresentable
  rather than something to validate after the fact — and the slots are what give
  delete a definition: it clears the last slot filled.
- **Tones finalize.** 大千 has no first-tone key, so **space is the first tone**;
  `ˊˇˋ˙` finalize with theirs. A finalized syllable queries the dictionary and
  its candidates take over the strip. A second tone key re-tones and re-queries,
  because `ㄕˋ` for `ㄕˊ` is the mistake everyone makes.
- **Space confirms; the next syllable auto-confirms.** Once candidates are up,
  space commits the first one and starting the next syllable commits it too.
  That second rule is what makes a sentence typeable without ever looking at the
  bar.
- **Delete edits the buffer before the document**: out of the candidate bar,
  then the syllable slot by slot, and only then does it reach the field.
- **Return** commits a pending syllable and otherwise types a line break, the
  way the system keyboard behaves.
- Leaving the pane commits what was pending — the user swiped, they didn't press
  delete. Coming back to a *different* field drops it, the same rule the
  transcript tail follows and for the same reason.

Everything above is `ZhuyinComposer` in ParleyKit, which never touches the
document: it answers `handled` / `insert(_)` / `passThrough` and the keyboard
does the inserting. That is what makes it testable on a Mac with `swift test`,
and it is why `passThrough` exists at all — space, delete and return keep their
ordinary meanings on every other pane without those panes knowing a composer
exists.

#### The dictionary

`zhuyin-dict.txt` (~93 KiB, in ParleyKit's resources) is reading → characters,
most frequent first, generated by `scripts/gen-zhuyin-dict.mjs` from
**McBopomofo's MIT-licensed data**: `BPMFBase.txt` for the readings and
`phrase.occ` for the ordering. `BPMFMappings.txt` is deliberately skipped — it
is the file their README marks as simplified from libtabe's `tsi.src`, so it
carries a second license's provenance, and it is phrases, which v1 does not
convert. Attribution is in `ios/THIRD-PARTY.md`; the generator pins the download
to a commit and stamps it into the resource's header, so the committed file names
what it was built from.

It is loaded **lazily and once**, on the first finalized syllable, because this
process runs against a jetsam limit far tighter than an app's — a keyboard opened
on the voice or QWERTY pane never pays for it. ~1,400 readings over ~27,000
characters is a few hundred kilobytes resident, and the file's own string is
dropped as soon as it is parsed. Rows are stored with no separator between
characters because every character in the source is exactly one Unicode scalar,
including the ones outside the BMP.

The 大千 table was checked, not eyeballed: McBopomofo's data carries a 大千
keystroke column beside every reading, and the table in `ZhuyinDachen` agrees
with 26,648 of their 26,652 rows (the four misses are typos in their key column,
e.g. `公 ㄍㄨㄥ˙ … ej/5`). That is why the table is written out in Swift rather
than derived from the data.

#### What v1 does not do

Named here so nobody has to guess whether it was forgotten:

- **No phrase conversion.** No lattice, no viterbi, no 2–6 character lexicon. A
  sentence is typed one character at a time with a frequency-ordered bar. This is
  the deliberate line: per-syllable done well before phrases done adequately.
- **No user dictionary and no learning.** The bar's order is the corpus's, not
  yours. A keyboard extension that accumulated a per-user model would be holding
  state this process is deliberately kept free of.
- **No 漢語拼音 or 倚天 layouts**, and no half-width/full-width punctuation
  switch — punctuation comes from the symbol planes shared with QWERTY.
- **No associated-phrase prompts** after a commit.

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
  MIT-licensed lexicon and attributed in `ios/THIRD-PARTY.md`. No phrase data
  with murkier provenance is shipped; see that section.
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
