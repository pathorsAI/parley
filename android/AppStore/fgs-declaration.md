# Foreground service permissions declaration — `microphone`

Everything Play Console → **App content** → **Foreground service permissions**
asks for, and the answer Parley gives to each field. The declaration is
mandatory: `android/app/src/main/AndroidManifest.xml` requests
`FOREGROUND_SERVICE_MICROPHONE` and types `MeetingService` as
`android:foregroundServiceType="microphone"`, and a release whose declaration is
incomplete cannot be rolled out.

The form has three parts — the permission, a written justification, and a video.
The video is the part that most often bounces, so it is dealt with in full
below.

## 1. Which foreground service type

**`microphone`** — the only one Parley declares. It is used by exactly one
component:

| | |
| --- | --- |
| Service | `com.pathors.parley.meeting.MeetingService` |
| Source | [`android/app/src/main/kotlin/com/pathors/parley/meeting/MeetingService.kt`](../app/src/main/kotlin/com/pathors/parley/meeting/MeetingService.kt) |
| Feature | "Record a meeting" — live in-person meeting recording and transcription |
| Started by | The user tapping **Record a meeting**, after granting `RECORD_AUDIO` |
| Stopped by | The user tapping **Stop**, in the app or in the notification |

No other service in the app is foreground-typed, and the microphone is not
touched at any other time.

## 2. The written justification

Paste this into the "Describe how your app uses this foreground service" box.
It is the same text as the one in [`review-notes.md`](review-notes.md); keep the
two in step if either is edited.

> Parley records in-person meetings. Recording is started explicitly by the user
> and must survive the app going to the background or the screen turning off —
> a meeting is longer than the user's attention on the phone, and without a
> microphone foreground service Android feeds a backgrounded app silence. The
> service runs only for the duration of a recording the user started, shows a
> persistent notification with a running timer and a stop action for its whole
> lifetime, and stops itself when the user ends the meeting. No audio is
> captured at any other time.

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

## 3. The video

**Play wants a URL, not an upload.** The form field takes a link, so the file
has to be hosted somewhere Google can reach without signing in. An **unlisted
YouTube video** is the route Play's own documentation suggests and the one to
use here.

- The video is committed at
  [`assets/fgs-demo-video.mp4`](assets/fgs-demo-video.mp4) — 30.4 s,
  1080 × 2400, H.264, ~640 KB, silent.
- **Nobody has uploaded it yet, so there is no URL to paste.** This document
  deliberately does not contain one; invent nothing here. Upload the file as
  unlisted, then record the resulting link below and in the Play form.

> **Video URL:** `[TODO: upload assets/fgs-demo-video.mp4 as an unlisted YouTube
> video and paste the watch URL here]`

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
