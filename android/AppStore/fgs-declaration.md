# Foreground service permissions declaration — `microphone`

Everything Play Console → **App content** → **Foreground service permissions**
asks for, and the answer Parley gives to each field. The declaration is
mandatory: `android/app/src/main/AndroidManifest.xml` requests
`FOREGROUND_SERVICE_MICROPHONE` and types **two** services as
`android:foregroundServiceType="microphone"` — `MeetingService` for meeting
recording and `DictationService` for the Parley keyboard's voice typing — and a
release whose declaration is incomplete cannot be rolled out.

The form has three parts — the permission, a written justification, and a video.
The video is the part that most often bounces, so it is dealt with in full
below.

## 1. Which foreground service type

**`microphone`** — still the only type Parley declares, but as of the release
that ships the keyboard it has **two** users, and the declaration has to cover
both:

| | `MeetingService` | `DictationService` |
| --- | --- | --- |
| Service | `com.pathors.parley.meeting.MeetingService` | `com.pathors.parley.ime.DictationService` |
| Source | [`…/meeting/MeetingService.kt`](../app/src/main/kotlin/com/pathors/parley/meeting/MeetingService.kt) | [`…/ime/DictationService.kt`](../app/src/main/kotlin/com/pathors/parley/ime/DictationService.kt) |
| Feature | "Record a meeting" — live in-person meeting recording and transcription | Voice typing — the Parley keyboard, `ime/ParleyInputMethodService.kt` |
| Started by | The user tapping **Record a meeting**, after granting `RECORD_AUDIO` | The user tapping the microphone key in the Parley keyboard |
| Stopped by | The user tapping **Stop**, in the app or in the notification | The user tapping the key again, the ten-minute per-dictation cap (counted down on the keyboard for its last 30 s), the keyboard hiding, or the notification's **Stop** |
| Typical duration | The length of a meeting | Seconds — a single utterance; never more than ten minutes |
| Notification | Ongoing "Recording a meeting", with a chronometer and a **Stop** action | Ongoing, on the `voice-typing` channel at `IMPORTANCE_LOW`, with a **Stop** action, posted for the whole time the microphone is open |
| Audio destination | The STT relay tagged `?feature=meeting`, plus the finished Ogg/Opus file uploaded to the account's library | The same STT relay tagged `?feature=voice_typing` (`SttRelayClient.Feature.VOICE_TYPING`); **nothing is stored** — no library entry, no file |

`DictationService` is `android:exported="false"`: nothing outside the app can
start it. No other service in the app is foreground-typed, and the microphone is
not touched at any other time — in particular, the keyboard being visible is not
enough, only the user tapping its one key is.

## 2. The written justification

The box is a single free-text field, so it has to account for both users of the
permission. Paste both paragraphs. The first is the same text as the one in
[`review-notes.md`](review-notes.md); keep the two in step if either is edited.

> **Recording a meeting.** Parley records in-person meetings. Recording is
> started explicitly by the user and must survive the app going to the
> background or the screen turning off —
> a meeting is longer than the user's attention on the phone, and without a
> microphone foreground service Android feeds a backgrounded app silence. The
> service runs only for the duration of a recording the user started, shows a
> persistent notification with a running timer and a stop action for its whole
> lifetime, and stops itself when the user ends the meeting. No audio is
> captured at any other time.

> **Voice typing.** Parley also ships a voice-only input method: a keyboard
> whose single key is a microphone, which types what the user says into
> whichever app they are already using. While that key is open the app has to
> record, and an input method is never the top app — the app being typed into
> is. Android feeds a process that is not the top app silence from
> `AudioRecord` unless a microphone foreground service is running, so without
> this service voice typing would record nothing. The service starts only when
> the user taps the microphone key, runs only while the user is dictating —
> usually seconds, and never more than ten minutes, after which it stops itself
> with a 30-second countdown on the keyboard — shows an ongoing notification
> with a stop action for its whole lifetime, and stops itself when the
> dictation finishes, when the keyboard is hidden, or when the user taps stop. It
> captures nothing while the keyboard is merely on screen, it never reads the
> text the user is typing into, and it refuses to open the microphone at all in
> a password field.

### Why a foreground service rather than a background job

Worth being able to answer directly, because it is the question the reviewer is
actually asking:

- **A background job cannot hold the microphone.** Since Android 11, an app
  without a `microphone`-typed foreground service that is not the top app is
  fed silence by `AudioRecord` rather than an error — the recording appears to
  keep running and produces a silent file. There is no "record quietly in the
  background" alternative to fall back on.
- **The work is continuous and user-visible, not deferrable.** `WorkManager`
  and friends exist for work the system may schedule whenever it likes.
  A meeting recording has to run *now*, for as long as the meeting lasts, and
  the user is waiting on its output. It is the textbook case the foreground
  service API exists for.
- **The duration is bounded by the user, not by us.** The service starts on an
  explicit tap and calls `stopSelf()` when the user stops; it is not restarted
  by the system (`START_NOT_STICKY`) and holds no wakelock beyond the recording.
- **It is advertised the whole time.** `setOngoing(true)` plus
  `setUsesChronometer(true)` means the user cannot lose track of a running
  recording, and the notification carries its own **Stop** action so it can be
  ended without returning to the app.

### Why a keyboard needs one too, and why it may start from the background

`DictationService` raises two questions `MeetingService` does not, and they are
the two a reviewer will actually ask.

- **An input method is never the top app, so it needs the service more than
  the recorder does.** The top app is whatever the user is typing into; the
  keyboard is not it, ever. The silence rule above therefore applies to voice
  typing *always*, not only when the user walks away — and from Android 14 a
  foreground service must declare a type and hold the matching permission
  before the microphone is live at all. Without `DictationService` the
  microphone key would look like it worked and transcribe silence. There is no
  arrangement of a keyboard that avoids this: it is a consequence of what an
  IME is.
- **The background start is a documented exemption, not a loophole.** Android
  12 blocked starting a foreground service from the background
  (`ForegroundServiceStartNotAllowedException`) and published a list of
  exempted cases. One of them is *your app is the current input method* —
  which is exactly this case, and the only reason the
  `startForegroundService()` call from `ime/ParleyInputMethodService.kt`
  succeeds. The app leans on that one entry and nothing else: no
  `SYSTEM_ALERT_WINDOW`, no exact-alarm route, no prompt asking the user to
  turn off battery optimization.
- **An utterance, not a session.** It runs only while the microphone is open —
  one dictation, usually seconds — and a single dictation is capped at **ten
  minutes**, after which it finalizes itself and the service stops. The same
  cap as iOS and the desktop, and like theirs it is not silent: the keyboard
  counts the last 30 seconds down, and says the limit was reached when it is.
- **Advertised for its whole life, like the recorder.** An ongoing
  notification on the `voice-typing` channel (`IMPORTANCE_LOW`, so it is quiet
  rather than hidden) is posted for as long as the microphone is open and
  carries a **Stop** action, so a dictation can be ended from the shade
  without going back to the keyboard. It disappears when the dictation does.
- **It honors the same `startForeground` contract.** Every path out of
  `onStartCommand` posts the notification before the instance is allowed to
  stop, including the paths that only want to stop — the same
  `ensureForeground()` discipline `MeetingService` uses, and for the same
  reason: an instance that stops without ever calling `startForeground` is
  killed with `ForegroundServiceDidNotStartInTimeException`, which is a crash
  in the user's face rather than a log line. `MeetingService`'s class
  documentation explains the contract in full
  ([`MeetingService.kt`](../app/src/main/kotlin/com/pathors/parley/meeting/MeetingService.kt),
  "The startForeground contract"); `DictationService` does not restate it, it
  follows it. The keyboard makes this *more* load-bearing, not less, because
  dictation starts and stops many times a day where a recording starts once.

## 3. The video

**Play wants a URL, not an upload.** The form field takes a link, so the file
has to be hosted somewhere Google can reach without signing in. An **unlisted
YouTube video** is the route Play's own documentation suggests and the one to
use here.

- The video is committed at
  [`assets/fgs-demo-video.mp4`](assets/fgs-demo-video.mp4) — 30.4 s,
  1080 × 2400, H.264, ~640 KB, silent. It shows **meeting recording only**;
  see [the open item below](#open-item-the-committed-video-does-not-show-voice-typing).
- The file was uploaded unlisted to the Pathors YouTube channel on 2026-08-19
  and the link below is what the Play form now holds.

> **Video URL:** https://youtu.be/jIm6IXJG6iA (unlisted)

**Declaration as submitted** (Play Console → App content → Foreground service
permissions, which only appears once a bundle declaring the permission has been
uploaded — it did not exist before 0.1.0 reached the internal track):

| Field | Value |
| --- | --- |
| Permission | `FOREGROUND_SERVICE_MICROPHONE` |
| Task | Background audio input |
| Video | https://youtu.be/jIm6IXJG6iA |

That is the declaration **as it stands**, and it was filed before
`DictationService` existed: the justification text in it covers meeting
recording only, and so does the video. Both fields have to be re-entered with
the text in section 2 before the release that ships the keyboard — the
permission and the task are unchanged, the words and the video are not.

### What the video shows

One unbroken take, no cuts, in this order:

| At | Beat |
| --- | --- |
| 0:00 | The recordings library, populated — a real app with content in it |
| 0:05 | The user taps **Record a meeting** — the recording is user-initiated |
| 0:07 | The live transcript filling in, with the elapsed timer and level meter running |
| 0:15 | The notification shade pulled down over the running recording: the ongoing **"Recording a meeting"** notification, its chronometer, and its **Stop** action |
| 0:21 | The shade dismissed, back on the recording screen, transcript still growing |
| 0:27 | **Stop** pressed, and the app back on the library |

The shade is pulled while the transcript is still growing on purpose, so the
notification and the live feature are demonstrably the same session.

### Open item: the committed video does not show voice typing

**TODO (human) — a person has to shoot, upload and file this; the repository
cannot.** It is a **blocker for the release that ships the keyboard**, not a
nicety.

The video above, and the URL filed in Play Console, show the meeting recorder
and nothing else. They were captured before `DictationService` existed, so
nothing in them demonstrates the second user of the permission. Play reviews the
declaration against the *permission*, not against whichever feature was
convenient to film, so a demonstration covering voice typing has to exist before
that release can roll out. Two ways to close it:

1. **Re-shoot one take covering both features.** Preferred — the form takes a
   single URL, so one video that covers the permission end to end leaves
   nothing for a reviewer to notice is missing.
2. **A second video, linked alongside.** Only if a re-shoot is not practical;
   it means explaining in the justification box why there are two.

No URL exists for it yet and none is invented here. The beats it needs, in the
style of the table above:

| Beat | Why it has to be in shot |
| --- | --- |
| The Parley keyboard being enabled in system settings — Languages & input → On-screen keyboard → Manage keyboards | The user turns the input method on, not the app |
| A **third-party** app — notes, a browser — with the user tapping into a text field and switching to the Parley keyboard | Proves the feature types into another app, which is the whole point of an IME |
| The single microphone key tapped, and the user speaking | The capture is user-initiated, and the keyboard visibly has one key |
| The words landing in the *other app's* field as they are recognized | Ties the microphone to the user-visible output |
| The shade pulled down while the microphone is still open: the ongoing notification and its **Stop** action | The same beat as 0:15 above, and the one Play cares about most |
| The notification gone the moment dictation ends | The service does not outlive the utterance |

This is harder to capture than the meeting video was, and the reason is worth
knowing before someone tries: a fixture transcript cannot stand in here. The
proof is words appearing in a *different app's* text field, which only real
recognition produces, and the emulator has no audio input to speak into. So this
one wants a physical device signed into a real account — the same constraint
that already applies to a re-shoot of the meeting video, below, which is an
argument for doing both in one sitting.

### How it was captured, and what is real in it

Captured on the `parley-test` AVD (Pixel 7, API 35) from a **debug** build, with
`adb shell screenrecord` driving straight to an MP4 and `adb shell input`
driving the UI. The exact procedure is in
[`assets/README.md`](assets/README.md#the-foreground-service-demo-video).

Being precise about this, because it is a submission to a store:

- **The foreground service in the video is the real one.** The notification is
  posted by `MeetingService` through the same channel, chronometer, stop action
  and `FOREGROUND_SERVICE_TYPE_MICROPHONE` as a genuine recording, and Android
  granted it on the strength of a real `RECORD_AUDIO` grant. Nothing about the
  notification is mocked up.
- **The transcript content is fixture, not live speech.** The capture runs in
  `com.pathors.parley.screenshot.DemoMode`, the same debug-only harness the
  store screenshots use, so no real account and no real customer meeting appear
  — the emulator also has no audio input to speak into. The companies and
  dialogue are invented (Northwind, Halcyon Labs, Meridian).
- **The video is silent.** `adb shell screenrecord` captures no audio track at
  all; this is a limitation of the tool, not a choice. Play does not require
  audio for this declaration.
- **The playback is choppy in places.** The emulator renders through
  swiftshader, so the source averaged about 7 fps before being re-encoded to a
  constant 30. It is legible throughout; it is not smooth.

If a reviewer pushes back on the scripted transcript, the answer is to re-shoot
the same six beats on a physical device signed into the review account, speaking
into it — the beats and the timings above transfer unchanged. That version needs
a real account and a working relay, which is why it is not the one committed
here.

## Related

- [`review-notes.md`](review-notes.md) — the App access declaration, the notes
  to the reviewer, and the same justification text.
- [`data-safety.md`](data-safety.md) — the Data safety answer sheet.
- [`assets/README.md`](assets/README.md) — every store graphic, and the capture
  procedure for this video.
