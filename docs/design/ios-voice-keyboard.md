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
3. **Return to the host app.** See the two regimes below.
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

`DictationChannel` (in ParleyKit, so both targets share it) is two single-writer
mailboxes plus two Darwin notifications, so the two processes never contend on a
file:

- `dictation-down.json` — app → keyboard: `{session, committed, partial, state}`.
- `dictation-up.json` — keyboard → app: `{session, hostBundleID, stopRequested,
  insertedCount}`.

The files are the source of truth; the Darwin notes are pure "go re-read"
signals (they carry no payload). This is what makes the hand-off robust to the
keyboard being suspended/killed while the app is foregrounded — whatever it
missed is still in the downlink when it returns.

App Group id: `group.com.pathors.parley.ios` (entitlement on both targets).

## The "jump back to the previous app" problem

Typeless's signature touch — tap the keyboard, it opens the app, and the app
*automatically returns you to where you were* — was never a public API. It relied
on the keyboard reading the host app's bundle id through private getters
(`_hostBundleID`) and the app calling the private
`LSApplicationWorkspace.openApplicationWithBundleID:`.

**Apple closed this in iOS 26.4.** The host-bundle-id getters now return nil, and
the private launch lands on the Home Screen rather than the host app. Wispr Flow's
own docs confirm the change: before 26.4 their keyboard "briefly opened the Flow
app and returned you automatically"; now they instruct users to swipe right on
the home indicator to go back.

Parley's decision (隱蔽 + 版本閘門) is to keep the good experience where it still
works and degrade cleanly where it doesn't:

- **iOS < 26.4** (`HostReturn.canReturn == true`): the app auto-returns to the
  host app via the private launch. Every private symbol is assembled from string
  fragments at runtime and reached through `responds(to:)`/`perform`, so no
  literal private symbol sits in the binary (lowering the odds of a static-scan
  2.5.1 flag) and a missing getter is a `nil`, never a crash.
- **iOS 26.4+**: no private call is attempted. The dictation screen owns the
  hand-off instead — it teaches the one gesture that replaces auto-return (swipe
  right on the home bar) with a looping first-run guide, and reassures that
  talking still works from the other app (the audio session keeps the mic alive
  under `UIBackgroundModes: audio`). This matches shipped Wispr Flow behavior.

If Apple ships a public round-trip API (their open enhancement is FB22247647),
only steps 1–3 change.

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
- **2.5.1** (private APIs): the auto-return path is private and version-gated to
  where it works; the rest of the flow (openURL, App Group, insertText, App
  Intents) is entirely public.
- Memory: the keyboard process holds no audio, no model, and no transcript
  history — it only shuttles text — to stay under the tight jetsam limit
  keyboard extensions run against.
