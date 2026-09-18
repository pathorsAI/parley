# The microphone, on the lock screen

Parley can hold the microphone open for up to an hour. Until now the only thing
that said so was iOS's own orange dot — plus three places you had to go and look
at: the picker footer in Settings, the bar on the Record tab, and the "Mic ready"
chip in the keyboard's mode strip. Lock the screen and all three are gone.

This is the Live Activity that fills that gap, and the haptics that go with it.
It covers three things the app already does and never showed anywhere durable:

- a **meeting recording**, while the screen is off or the app is behind another,
- a **keyboard dictation**, after the keyboard has been swiped away,
- an **open microphone window** with nothing being recorded — the state that is
  hardest to explain and, until now, had no chance to explain itself.

## One microphone, one card

There is exactly one `AudioCapture` in the app: `MeetingRecorder.start` calls
`DictationCoordinator.yieldMicrophone()` before opening its own, because there is
one microphone and two things that want it. The Live Activity is shaped by the
same fact — **one activity with three modes**, never three activities:

```
MicActivityState.Mode
  .meeting    a meeting recording is running          red
  .dictation  a keyboard dictation session is live    blue
  .standby    a window is open, nothing is recorded    orange
  (no card)   the microphone is closed
```

`MicActivityState.derive` is the single place that precedence is written, and it
is a free function in ParleyKit rather than a method on the controller so it can
be tested without a main actor or a device. Precedence is meeting > dictation >
standby, which is not a preference: if both a meeting and a dictation look live,
the meeting is the one that actually holds the microphone, because starting it
is what took the microphone away from the other.

### The colours are borrowed, not invented

Nothing new was picked for this. Red is `ParleyDesignTokens.recording`, the same
red the Record tab uses. Blue is the brand signal blue. Orange is **iOS's own
privacy-indicator orange**, the same value the keyboard's "Mic ready" chip uses —
while a window is open the system is showing that exact dot in the status bar,
and two marks for one fact should look like one fact.

Moving `ParleyDesignTokens` into ParleyKit is what makes that literally true
rather than approximately true: the widget extension cannot import the app
target, so before this the only way to match was to copy three hex values and
hope.

## Every clock is a `Text(timerInterval:)`

This is the most load-bearing decision in the feature, and it is defensive.

A Live Activity's content is normally kept current by the app calling
`activity.update(...)`. Parley's problem is that the moments when the card
matters most are exactly the moments the app is in the background holding a
recording audio session — and **it is not established that background updates
land there.** The reports that exist say updates work from the background under
background *location* and Picture-in-Picture, and do not on device under the
`audio` background mode, while working fine in the simulator. Parley holds an
active *recording* session rather than playing audio, which may or may not be
the same case. It cannot be settled from documentation, and a simulator will
give a false pass.

So the card is built to be correct without any update at all:

- elapsed time on a meeting or a dictation is `Text(timerInterval: since...)`,
  which the system ticks inside the widget process,
- the standby countdown is the same thing counting down to `window.expiresAt`,
- mode changes still go through `activity.update(...)`, but a mode change that
  fails to land degrades the card to a stale clock under a correct label rather
  than to a wrong one.

An update is therefore an enrichment, never the thing that keeps the card true.

### A clock's width comes from its range, not from its digits

`Text(timerInterval:)` is laid out once, for the widest value the range can
reach, and it does not grow as the number does. The first version handed every
clock the same eight-hour range, so every clock was sized for `8:00:00` — and
the compact Dynamic Island, which had a clock in its trailing slot, took about
81% of the screen width to show a dot and `0:25`.

So the range each mode is given is a layout decision as much as a temporal one,
and each one is now the tightest end the card can actually stand behind:

- `.standby` counts down to the window's real expiry,
- `.dictation` counts up to `MicActivityPolicy.dictationLimit`, the 120 s cap
  `DictationCoordinator` already enforces, so the clock is laid out as `M:SS`.
  The constant moved into ParleyKit for this: the widget extension cannot import
  the app target, and a copied literal would go stale silently, the only symptom
  being a clock slightly too wide.
- `.meeting` keeps the eight hours, because a meeting genuinely has no length
  the app will impose. A tighter end here would be a number the card cannot
  keep — the clock would stop while the microphone was still open, which is the
  lie the whole card exists to prevent. The eight hours are the card's real
  lifetime, a wide clock is what they cost, and the expanded island and the lock
  screen have room for it.

**The compact island shows the status dot and nothing else.** The only question
a collapsed island has to answer is *is the microphone open, and for what*, and
the dot's colour answers both halves. Elapsed time is something you stop and
read, and stopping to read is what the long-press expansion and the lock-screen
card are for. Honest ranges alone would not have settled this — a meeting's
range is unbounded, so a clock in that slot would still be laid out for
`8:00:00`. An empty region is the one version that can never widen again.

### Colour is the dot, and the dot only

The three colours live in one 9pt disc. Every word on the card is a system
semantic colour, and the card paints no background of its own. A lock screen is
the plainest page there is, and the app's rule — colour is a signal, never a wash
— applies there more than anywhere. Three coloured marks would be a legend to
learn; one dot that is red, blue or orange is the same mark the reader already
knows from the Record tab, the keyboard's mic pill, and the system's own privacy
indicator.

### There are two "this might not be true" signals and they are not the same

`trouble` is the app asserting something: it is awake, it looked, and the
microphone is gone or the relay is down. The card says *Interrupted*.

`isStale` is the absence of anyone asserting anything for `staleAfter`. The card
hedges — *This may have stopped* — and it **wins over `trouble` when both are
set**, which is the counter-intuitive half: a card nobody has refreshed cannot
vouch for its own `trouble` flag either, so the weaker claim is the only one
still supported by evidence.

Both drop the accent to grey and stop the pulse. Neither is allowed to leave a
confident-looking live card animating.

### `MicActivityPolicy.staleAfter` is the lever

`staleAfter` (180 s) is how long the card believes itself without a refresh; past
it, ActivityKit sets `isStale` and the widget renders the honest face — *this may
have stopped* — instead of a clock that keeps running under a dead process. That
is also how the app being force-quit is handled, and it is deliberately **not**
done by detecting termination: a backgrounded app that the user swipes away is
not guaranteed to get `applicationWillTerminate`. Nothing has to notice the
death. The card simply stops being vouched for.

The catch is that this only works if background updates work, since the refresh
that pushes `staleDate` forward is itself an update. If the device spike says
they do not, `staleAfter` becomes `nil`: the card then makes no staleness claim,
the timers carry it, and the honest-interruption face is driven only by what the
app can say while it is awake. One constant, one place, both behaviours already
written.

**This has to be measured on a device before the feature is called done.** Put a
recording in the background, push an update every five seconds, and watch whether
the Dynamic Island follows.

The refresh beat in `MicActivityController` is the thing that spike actually
measures. The card's *content* barely changes — a meeting derives maybe three
distinct states in an hour — so pushing only on change would set the last
`staleDate` three minutes in and leave the widget spending the remaining
fifty-seven minutes saying the recording may have stopped. So a loop re-pushes
the same state every `staleAfter / 3` purely to move the horizon forward. If
background updates do not land, that loop is exactly what fails, and setting
`staleAfter` to `nil` disarms the loop and the staleness claim together.

Updates are otherwise deduplicated on content: the dictation hook hangs off
`publish()`, which fires per settled word, and the card carries no words.

### Eight hours

The system dismisses a Live Activity after 8 hours and keeps it on the lock
screen in a stale state for up to 4 more. A recording that outlives that will
watch its own card be taken away while the microphone is still open, which is the
same class of lie the card exists to prevent. `MicActivityPolicy.outlivesSystemLimit`
is where that is detected; what the app does about it is a product decision that
has not been made yet, and the honest interim is that the card disappears and the
Record tab is still right.

## The buttons

Four `LiveActivityIntent`s, and all four are the same kind of thing: **write an
App Group mailbox, post a Darwin note, touch nothing else.** None of them opens a
microphone, which is the entire reason they work from a card on a lock screen
over a backgrounded app.

| Button | Intent | Mailbox | Who already listens |
|---|---|---|---|
| Finish | `FinishDictationIntent` | `Uplink.stopRequested` | `DictationCoordinator.requestObserver` |
| Discard | `CancelDictationIntent` | `Uplink.cancelRequested` | same |
| End Standby | `EndMicWindowIntent` | `MicWindowControl` | `DictationCoordinator.windowControlObserver` |
| Stop Recording | `StopMeetingRecordingIntent` | `MeetingControl` | new — `MeetingRecorder` |

Three of the four needed no app-side work at all, because the keyboard already
asks for exactly these things through exactly these mailboxes. The card is a
second keyboard as far as the app is concerned, which is why it was cheap.

The intents live in ParleyKit rather than in the app target because both sides
have to see the type: the widget extension references them to draw the buttons,
and the app executes them.

### Two platform rules that shaped the code, found by hitting them

Both cost a build failure each and neither is guessable from the API surface, so
they are written down here as well as at the code.

**`#if os(iOS)`, never `#if canImport(ActivityKit)`.** The macOS SDK ships
`ActivityKit.framework` and `AppIntents.framework`, so `canImport` is *true* when
ParleyKit builds for macOS — and then `ActivityAttributes` and
`LiveActivityIntent` are both `@available(macOS, unavailable)` and nothing
compiles. The obvious guard is the wrong one. ParleyKit builds for macOS so its
logic can be tested without a simulator, which is what makes this reachable at
all.

**An App Intent's `title` must come from the main bundle.** AppIntents extracts
its metadata at build time and rejects any `LocalizedStringResource` naming
another bundle — `ExtractAppIntentsMetadata` fails with *AppIntents requires
'LocalizedStringResource' to use the main bundle* — and ParleyKit's strings live
in `Bundle.module`. So the four intents carry bare English literals as titles,
which is tolerable because that text is Shortcuts metadata for intents that are
all `isDiscoverable = false`, and it is **not** what the card draws. The words on
the buttons come from `MicActivityCopy`, a plain `String(localized:bundle:.module)`
accessor that the widget labels its buttons with. Labelling from the intent
titles instead would compile, look right in English, and silently ship a
Chinese-less card.

### `MeetingControl` is a timestamp, not a flag

The one new mailbox copies `MicWindowControl` exactly. A stop request carries the
time it was made, and applies only to a recording that started at or before it.
Neither side ever clears anything, and a control file left behind by a crash
cannot stop the *next* recording — which a boolean would.

It is a separate channel rather than a seventh mailbox on `DictationChannel`
because `DictationChannel` is scoped to dictation, says so, and a meeting stop is
not dictation. It reuses that file's plumbing and its App Group, nothing else.

### No Delete on the lock screen, and no unlock required

Stop does not require authentication. `LiveActivityIntent` can demand an unlock
first, and the trade was made the other way: the cost of a stray tap is a
recording that stopped a few seconds early and is still saved, while the cost of
requiring an unlock is that the fast path — stop this now — stops being fast,
which is the only reason the button is there.

**Discard and Delete are different things and only one of them is on the card.**
Dictation's ✕ throws away a transcript that has not been inserted anywhere; that
is recoverable by saying it again. A meeting's `discard()` deletes an audio file.
Nothing that destroys recorded audio is reachable from a locked screen.

## What the card does not say

**The transcript is not on the card**, in either mode, and this is a decision
rather than an omission. A lock screen and a Dynamic Island are public surfaces:
the phone is face-up on the table, and whoever is sitting opposite can read them.
Putting the words of a meeting — or of whatever is being dictated into a private
message — on that surface is a privacy leak with no way to take it back.

So the card carries state and time, and the words stay in the app. If this is
ever wanted it should be a setting, and it should default to off.

## Haptics

Touch can carry one thing reliably: direction. A single tap says *something
happened*; two beats that grow say *starting*, and two beats that fade say
*leaving, but still here*. Before this, three of the four dictation events
differed only in texture — `.medium`, `.rigid`, the system's `.success` — which
is close to indistinguishable with the phone out of sight, and out of sight is
the situation the whole feature is about.

| Event | Before | Now |
|---|---|---|
| The microphone opens, either way | one `.medium` (dictation only) | `.medium` → `.heavy`, rising |
| A meeting recording stops | **nothing** | `.heavy` → `.medium`, falling to rest |
| The keyboard is swiped away mid-session | nothing | `.heavy` → `.light`, falling away |
| The transcript lands in the field | `.success` | unchanged |
| ✕ discards, either way | `.rigid` (dictation only) | unchanged |

The last two were left alone on purpose. The system's success pattern already
means what it needs to mean and users recognise it from other apps, and `.rigid`
is already the most distinguishable of the endings.

**A meeting recording had no haptics at either end**, which is how this got
noticed: the microphone opened with two beats and closed with silence. It now
shares the dictation vocabulary rather than getting one of its own — a
microphone opening is one event met in two places, and a rise only reads as a
rise against a fall the same hand has already felt.

The two falls are the pair worth being careful about, because they are the same
gesture meaning nearly opposite things. *Stopped* comes to rest — it lands on
`.medium` after 60 ms, and nothing follows because nothing is still running.
*Leaving* trails away — `.light` after 130 ms, quieter and later, because
something is still listening behind it. Weight and timing are the two dimensions
the hand actually reads, and both are used to separate them.

The start beat fires at `phase == .recording`, not on the press. The Record
button flips synchronously on the tap — before permission, before the audio
engine is up — so the screen confirms the tap was heard, not that the room is
being recorded. A rise for a capture that then failed would be the wrong news.

`Haptics` moved from the keyboard target into ParleyKit to make this possible,
which is what its own header said to do when the app ever needed it rather than
copying the file. It is guarded with `#if os(iOS)` for the reason given above.

The rise starts at `.medium` rather than `.light`, which makes a shorter slope
than it could have. That is the point: `.medium` is exactly what shipped before,
and the report this answers was *I did not feel it*, not *I could not tell what
it meant*. The added `.heavy` is the whole change, and nothing about the
millisecond of the press is allowed to get quieter in the process. The falling
pattern has no such constraint — its quiet beat is a tail nobody is waiting for —
so it drops all the way to `.light` and reads more clearly as a fall. What makes
the two a pair is the `.heavy` they share at opposite ends.

The falling pattern fires only when a session is actually live. Dismissing the
keyboard is an ordinary, constant action, and buzzing every time is how a signal
becomes noise.

Both patterns can be truncated: a keyboard extension can be suspended moments
after it starts going away, so the second beat may never play. That is tolerable
under the rule already in `Haptics.swift` — nothing here is load-bearing, and a
haptic that does not play costs the user nothing — but it does mean the first
beat has to be legible on its own.

There is no setting for any of this, for the same reason there was not one
before: a device with haptics turned off already plays nothing, and a second
switch would only be a way to disagree with the system.

## What is deliberately not here

**"Continue recording" is not in this change.** If the app is swiped away while
recording, the recording stops — no iOS API brings it back on its own — and the
card will say so rather than pretend otherwise. Resuming into the same recording
means a new audio segment stitched onto an existing one, which is a change to the
recording's file model and not to anything on a lock screen. It is worth doing
and it is worth costing separately.

A local notification for the same event is held back with it, because it would
introduce the first notification-permission prompt this app has ever shown, and
that prompt should arrive attached to something that works.

## See also

- `docs/design/ios-voice-keyboard.md` — the microphone window, and why a window
  never starts but only continues. That is what makes the standby mode possible
  to start in the first place: a window is always opened with the app in the
  foreground, which is the only place ActivityKit allows a Live Activity to begin.
- `docs/design/ios-visual-language.md` — white page, blue as a signal.
