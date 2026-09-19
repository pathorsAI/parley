# Voice typing, on the lock screen

Parley can hold the microphone open for up to an hour for the dictation
keyboard. Until now the only thing that said so was iOS's own orange dot — plus
three places you had to go and look at: the picker footer in Settings, the bar
on the Record tab, and the "Mic ready" chip in the keyboard's mode strip. Lock
the screen and all three are gone.

This is the Live Activity that fills that gap, and the haptics that go with it.
**It is about voice typing, and only about voice typing.** It covers two things
the app already does and never showed anywhere durable:

- a **keyboard dictation**, after the keyboard has been swiped away,
- an **open microphone window** with nothing being recorded — the state that is
  hardest to explain and, until now, had no chance to explain itself.

A meeting recording holds the very same microphone and gets **no card at all**.
That is a decision, taken after the two-subject version shipped and was used on
a device; it is written up under *[What was removed, and
why](#what-was-removed-and-why)* rather than left to be rediscovered.

## One microphone, one card

There is exactly one `AudioCapture` in the app: `MeetingRecorder.start` calls
`DictationCoordinator.yieldMicrophone()` before opening its own, because there
is one microphone and two things that want it. The Live Activity is shaped by
the same fact — **one activity with two modes**, never one per subsystem:

```
MicActivityState.Mode
  .dictation  a keyboard dictation session is live    blue
  .standby    a window is open, nothing is recorded    orange
  (no card)   the microphone is closed — or a meeting has it
```

`MicActivityState.derive` is the single place that precedence is written, and it
is a free function in ParleyKit rather than a method on the controller so it can
be tested without a main actor or a device. Precedence is dictation > standby,
which is not a preference: the window is the microphone nobody is using, so
anything actually using it outranks it.

**Starting a meeting makes a live card disappear rather than turn red**, and
that is the behaviour, not a bug. `yieldMicrophone()` ends the dictation session
and closes the window, so both of `derive`'s inputs go nil and it correctly
returns nothing. The answer is written at `derive` too, because that is where
somebody chasing the disappearance will land first.

### The colours are borrowed, not invented

Nothing new was picked for this. Blue is the brand signal blue. Orange is **iOS's
own privacy-indicator orange**, the same value the keyboard's "Mic ready" chip
uses — while a window is open the system is showing that exact dot in the status
bar, and two marks for one fact should look like one fact.

Moving `ParleyDesignTokens` into ParleyKit is what makes that literally true
rather than approximately true: the widget extension cannot import the app
target, so before this the only way to match was to copy hex values and hope.
`ParleyDesignTokens.recording` — the Record tab's red — is no longer read by the
widget, and is otherwise untouched: the app still uses it in four places, and a
meeting is still red everywhere a meeting is drawn.

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

- elapsed time on a dictation is `Text(timerInterval: since...)`, which the
  system ticks inside the widget process,
- the standby countdown is the same thing counting down to `window.expiresAt`,
- mode changes still go through `activity.update(...)`, but a mode change that
  fails to land degrades the card to a stale clock under a correct label rather
  than to a wrong one.

An update is therefore an enrichment, never the thing that keeps the card true.
It is also the reason there is no waveform on the card; see *[What is
deliberately not here](#what-is-deliberately-not-here)*.

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

The eight-hour range survives in exactly one fallback — a standby state whose
`until` did not survive the trip — because a card that does not know the expiry
may not invent one. `derive` does not produce that state, so in practice nothing
is laid out for `8:00:00` any more.

**The compact island shows the status dot and nothing else.** The only question
a collapsed island has to answer is *is the microphone open, and for what*, and
the dot's colour answers both halves. Elapsed time is something you stop and
read, and stopping to read is what the long-press expansion and the lock-screen
card are for. Both surviving ranges are short enough that a clock would now fit
there, which makes this the one decision here that could be revisited — and it
should not be: an empty region is the only version that can never widen again,
whatever a future mode brings.

### Colour is the dot, and the dot only

The two colours live in one 9pt disc. Every word on the card is a system
semantic colour, and the card paints no background of its own. A lock screen is
the plainest page there is, and the app's rule — colour is a signal, never a wash
— applies there more than anywhere. Two coloured marks would be a legend to
learn; one dot that is blue or orange is the same mark the reader already knows
from the keyboard's mic pill and the system's own privacy indicator.

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
dictation session in the background, push an update every five seconds, and
watch whether the Dynamic Island follows.

The refresh beat in `MicActivityController` is the thing that spike actually
measures. The card's *content* barely changes — an hour-long microphone window
derives maybe two distinct states — so pushing only on change would set the last
`staleDate` three minutes in and leave the widget spending the remaining
fifty-seven minutes saying the microphone may already be closed. So a loop
re-pushes the same state every `staleAfter / 3` purely to move the horizon
forward. If background updates do not land, that loop is exactly what fails, and
setting `staleAfter` to `nil` disarms the loop and the staleness claim together.

Updates are otherwise deduplicated on content: the dictation hook hangs off
`publish()`, which fires per settled word, and the card carries no words.

### Eight hours

The system dismisses a Live Activity after 8 hours and keeps it on the lock
screen in a stale state for up to 4 more. `MicActivityPolicy.outlivesSystemLimit`
is where that is detected, and `MicActivityController.refreshNow` lets go of the
handle rather than pushing into an activity that is no longer there.

Nothing the card now describes can reach it — a dictation stops itself at 120 s
and the longest microphone window is an hour — so this is a guard rather than a
case. It stays because the refresh loop is what would do the pretending, and it
costs one comparison a minute. It mattered concretely while meetings were on the
card: a nine-hour recording would have watched its own card be taken away with
the microphone still open, which is the same class of lie the card exists to
prevent.

## There are no buttons

The card carries a clock, a state word, a dot, and — for standby — one line of
small print. `.widgetURL` opens Parley from a tap anywhere. That is the whole
interaction.

It used to carry four `LiveActivityIntent`s: Finish, Discard, End Standby, and
Stop Recording. They worked, and they are gone anyway. Finish-or-discard is not
a decision to make on a surface you are glancing at with the phone face-up on a
table and the screen locked; it is a decision that wants the transcript in front
of you, which means the app. Once that was true of the dictation card it was
true of the card, and keeping one button for standby alone would have been a
lonely control whose only argument was that it already existed.

What went with them:

- `FinishDictationIntent`, `CancelDictationIntent`, `EndMicWindowIntent`,
  `StopMeetingRecordingIntent`, and `MicActivityCopy` — the localized button
  words, which lived in ParleyKit because an `AppIntent`'s own `title` cannot
  carry them (see below).
- `MeetingControlChannel` and the `MeetingControl` mailbox, the only one of the
  four that was new. The other three wrote mailboxes the keyboard had always
  written, and **those are untouched**: the keyboard's own ⏹, ✕ and "end window"
  still work exactly as they did, because the card was only ever a second
  keyboard as far as the app was concerned.
- `MeetingRecorder`'s Darwin observer for that mailbox, and with it the
  `weak var host: AppState?` and the `app:` parameter on `start` that existed
  solely so a stop arriving from outside the view layer could reach the
  uploader.

### Two platform rules that shaped the code, found by hitting them

Both cost a build failure each and neither is guessable from the API surface.
The first still governs live code; the second is kept because it is the sort of
thing that gets rediscovered the day someone adds a button back.

**`#if os(iOS)`, never `#if canImport(ActivityKit)`.** The macOS SDK ships
`ActivityKit.framework` and `AppIntents.framework`, so `canImport` is *true* when
ParleyKit builds for macOS — and then `ActivityAttributes` and
`LiveActivityIntent` are both `@available(macOS, unavailable)` and nothing
compiles. The obvious guard is the wrong one. ParleyKit builds for macOS so its
logic can be tested without a simulator, which is what makes this reachable at
all, and `MicActivityAttributes.swift` still carries the guard.

**An App Intent's `title` must come from the main bundle.** AppIntents extracts
its metadata at build time and rejects any `LocalizedStringResource` naming
another bundle — `ExtractAppIntentsMetadata` fails with *AppIntents requires
'LocalizedStringResource' to use the main bundle* — and ParleyKit's strings live
in `Bundle.module`. So the intents carried bare English literals as titles and
the buttons were labelled from a separate `MicActivityCopy` accessor instead.
Labelling from the intent titles would have compiled, looked right in English,
and silently shipped a Chinese-less card.

## What the card does not say

**The transcript is not on the card**, and this is a decision rather than an
omission. A lock screen and a Dynamic Island are public surfaces: the phone is
face-up on the table, and whoever is sitting opposite can read them. Putting the
words of whatever is being dictated into a private message on that surface is a
privacy leak with no way to take it back.

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

**The meeting's haptics outlived the meeting's card**, and they were never part
of it. A card is something you look at; a haptic is what tells you that you do
not have to. Removing the card is the argument *for* keeping the beats, not
against them: a recording that starts and stops with no screen confirmation and
no buzz is a recording you have to check on.

The last two rows were left alone on purpose. The system's success pattern
already means what it needs to mean and users recognise it from other apps, and
`.rigid` is already the most distinguishable of the endings.

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

## What was removed, and why

**The meeting card was built, shipped in iOS 1.15, and removed after use.** It
is recorded here rather than deleted quietly, because the lock-screen card for a
running recording was the feature's *original* motivation and somebody will
reasonably propose it again.

What it was: a third mode, `.meeting`, red, with the recording's elapsed time and
a Stop button, drawn on the lock screen and in the Dynamic Island.

Why it is gone: **the lock-screen card for a meeting was worth less in practice
than the Dynamic Island's constant presence cost.** A Live Activity is one thing
with several presentations, not several things — the island and the lock-screen
card cannot be separated, and dropping the island for meetings means dropping
the card with it. That trade was put to the founder twice, explicitly, and taken
both times: recording a meeting is something you do with the phone in front of
you and the Record tab open, so the card was answering a question that was rarely
being asked, while the island sat over the top of every other app for the whole
recording.

Voice typing is the opposite case, which is why the card survives for it. A
dictation is *meant* to be used with the keyboard swiped away and the phone out
of the way, and a microphone window is open precisely when nothing on screen
says so. There the card is the only thing that answers *is it still listening*.

What that cost, concretely: `MicActivityState.Mode.meeting` and the `title` field
that existed for the meeting's name; `MicActivityController`'s second half and
the `troubleOfWhicheverHalfWins` arbitration between the two; the three `didSet`
hooks in `MeetingRecorder` that drove it; `MeetingControlChannel`; and the
two localized *Recording* strings, which the catalog had to key apart because
the state word and the untitled-recording fallback are the same word in English
and two different words in Chinese. The haptics stayed (see above), and so did
everything the app draws for a recording anywhere else.

## What is deliberately not here

**No waveform, and no animated visualiser of any kind.** It is the obvious thing
to put in the expanded island's now-empty bottom region, and it must not go
there. A level that followed the user's voice would need `activity.update()` to
land several times a second from a backgrounded app — the one assumption this
whole feature is written to survive being wrong about (see
*`MicActivityPolicy.staleAfter` is the lever*), and a battery cost even if it
held. What is left is a loop that moves whether or not anybody is speaking: a
picture of listening rather than evidence of it, on the surface whose entire job
is to be believable. `docs/design/ios-visual-language.md` rules out cheap
visualisers generally; this one would also be a small lie. The comment at the
empty region says so, so that the next person to reach for it finds the argument
before writing the code.

**"Continue recording" is not in this change.** If the app is swiped away while
recording, the recording stops — no iOS API brings it back on its own. Resuming
into the same recording means a new audio segment stitched onto an existing one,
which is a change to the recording's file model. It is worth doing and it is
worth costing separately. Nothing on the lock screen reports on it either way
now that meetings have no card.

A local notification for the same event is held back with it, because it would
introduce the first notification-permission prompt this app has ever shown, and
that prompt should arrive attached to something that works.

## See also

- `docs/design/ios-voice-keyboard.md` — the microphone window, and why a window
  never starts but only continues. That is what makes the standby mode possible
  to start in the first place: a window is always opened with the app in the
  foreground, which is the only place ActivityKit allows a Live Activity to begin.
- `docs/design/ios-visual-language.md` — white page, blue as a signal.
