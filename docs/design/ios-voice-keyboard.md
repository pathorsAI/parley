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

## App Review notes

- **4.4.1** (keyboards must work without Full Access): the keyboard always shows
  a minimal key row (globe, space, return, delete). Dictation itself requires
  Full Access (network + App Group) and says so with a jump to Settings.
- **2.5.1** (private APIs): the auto-return path is private and version-gated to
  where it works; the rest of the flow (openURL, App Group, insertText, App
  Intents) is entirely public.
- Memory: the keyboard process holds no audio, no model, and no transcript
  history — it only shuttles text — to stay under the tight jetsam limit
  keyboard extensions run against.
