# Play review information

What a Google Play reviewer needs to get through this app, and the two
declarations that will otherwise bounce the release: **App access** (the app is
behind a sign-in wall) and **foreground service permissions** (the `microphone`
type needs a demonstration video).

Target: `com.pathors.parley`, versionName `0.1.0` / versionCode `1`
(`android/app/build.gradle.kts`). minSdk 29 — a reviewer on anything older than
Android 10 will not be offered the app.

## App access — the sign-in wall

The app opens on a sign-in screen and there is no way past it: `ParleyRoot`
renders the wall in front of the whole navigation graph while no token is
stored. Play Console → App content → **App access** must therefore be set to
"All or some functionality is restricted" with working credentials.

**Account to use: `appreview@pathors.com`.** It is named in
`ios/AppStore/review-notes.md` as a non-expiring production review account and
is the same hosted backend (`api.parley.tw`), so it signs in here unchanged.

Three caveats, stated rather than guessed:

- **The password is deliberately not in this repository** and is not in the iOS
  packet either — it lives in the team secret manager. Nothing in the repo can
  supply it, so it must be pasted into Play Console by hand.
- **`[TODO: confirm with Jack]` that the account is still live and still
  non-expiring.** The iOS note was written for the 1.1 submission; this repo
  cannot verify the account's current state. An expired demo account is the
  single most avoidable rejection (`android/RELEASING.md`).
- **`[TODO: confirm with Jack]` what its sample meetings look like now.** The
  iOS packet carries an unresolved warning that they were still titled in
  Chinese (`示範會議…`) from the 1.0 pass. For Play, seed at least one English
  and one Chinese sample recording so the library and transcript screens have
  something in them whichever locale the reviewer's device is in — and so the
  reviewer never has to record anything to see the product.

If a fresh account is minted for Play instead, it must be **email/password**:
the hosted sign-in page also offers Google and Apple, and review must not
depend on a personal identity.

### Instructions to paste into the App access form

> Parley requires a Parley Cloud account; there is no offline mode. Sign-in
> happens on our hosted page, which opens in a Chrome Custom Tab and hands the
> session back to the app.
>
> 1. Launch the app. Tap **Sign in** on the welcome screen.
> 2. A browser tab opens `https://api.parley.tw/sign-in`. Enter the email and
>    password supplied above. (The page also offers Google and Apple sign-in —
>    please use the email/password account.)
> 3. The browser returns to the app automatically via the `parley://auth-callback`
>    deep link, and the recordings library appears. No email confirmation, no
>    second factor.

## Notes to the reviewer

> Parley is a microphone-based recorder for meetings you have in person, plus a
> transcriber for audio files you already have. It does **not** record phone
> calls and does not capture the audio of other apps — it uses the device
> microphone only, through `AudioRecord`.
>
> **To test recording:** from the library, tap "Record a meeting". The app asks
> for microphone permission; allow it. Speak near the device — the transcript
> appears line by line while you talk, produced by our hosted transcription
> service over an encrypted connection. Tap Stop. The recording is saved,
> uploaded, and appears in the library; open it to read the transcript.
>
> **The recording continues in the background** by design: that is what the
> `microphone` foreground service is for. While recording, an ongoing
> notification ("Recording a meeting") with a running timer is shown, and it
> carries a stop action. Leave the app during a recording to see it.
>
> **To test importing a file:** from the library, tap "Import recording" and
> pick any audio file through the system file picker. The app decodes it,
> transcribes it faster than real time with a progress indicator, and the
> result lands in the same library as a recording marked "Imported". Any common
> format the device can decode works (m4a, mp3, wav, ogg).
> `[TODO: confirm with Jack]` — if the review device has no audio file on it,
> this step cannot be performed; consider hosting a short sample clip and
> linking it here so the reviewer can download one.
>
> **If the network drops**, a finished recording is kept on the device and
> listed under "Waiting to upload" in the library, with an "Upload now" action;
> it also uploads itself when connectivity returns. Nothing is lost.
>
> This version has no audio playback — a saved recording opens as a transcript,
> which is what the store listing says.

## Foreground service permissions declaration (`microphone`)

The manifest declares `FOREGROUND_SERVICE_MICROPHONE` and
`android:foregroundServiceType="microphone"` on `MeetingService`. Play Console →
App content → **Foreground service permissions** therefore requires a written
justification *and* a video showing the feature in use. Without the video the
declaration is rejected and the release cannot roll out.

**Justification to enter:**

> Parley records in-person meetings. Recording is started explicitly by the user
> and must survive the app going to the background or the screen turning off —
> a meeting is longer than the user's attention on the phone, and without a
> microphone foreground service Android feeds a backgrounded app silence. The
> service runs only for the duration of a recording the user started, shows a
> persistent notification with a running timer and a stop action for its whole
> lifetime, and stops itself when the user ends the meeting. No audio is
> captured at any other time.

**The video has been captured**: [`assets/fgs-demo-video.mp4`](assets/fgs-demo-video.mp4),
30.4 s, one continuous take, showing the library → the user starting a
recording → the live transcript with the elapsed timer and level meter → the
shade pulled down over the running recording to show the ongoing "Recording a
meeting" notification, its chronometer and its Stop action → the shade dismissed
→ Stop pressed.

**It still has to be hosted.** Play's form takes a *URL*, not an upload, so the
file must go up as an unlisted YouTube video and the link pasted into the
declaration. Do not invent one.

The full field-by-field answer sheet — which service type, why a foreground
service rather than a background job, what is real in the video and what is
fixture — is [`fgs-declaration.md`](fgs-declaration.md). The capture procedure
is in [`assets/README.md`](assets/README.md#the-foreground-service-demo-video).

Two honest caveats to carry into any conversation with a reviewer, both spelled
out in `fgs-declaration.md`: the notification and the foreground service in the
video are genuine, but the **transcript content is demo-mode fixture** rather
than live speech (an emulator has no audio input, and a real capture would put
a real account on screen), and the video is **silent**, because
`adb shell screenrecord` captures no audio track at all.

## What else this app will be asked

- **Data safety** — the filled-in answer sheet is [`data-safety.md`](data-safety.md).
  It contains one unresolved blocker (no account-deletion route reachable from
  Android); read it before opening the form.
- **Recording consent.** The listing copy frames Parley as a note-taker used
  with the room's knowledge and never suggests covert recording, which is the
  framing that passed App Store review. Note for anyone answering follow-up
  questions: **the Android app shows no consent prompt** — iOS does, and the
  iOS listing advertises it, but there is no such string in either
  `values/strings.xml` or `values-zh-rTW/strings.xml`. Do not tell a reviewer
  there is one. `[TODO: confirm with Jack]` whether to port the iOS consent
  confirmation to Android before the first production rollout.
- **Ads:** none. **In-app purchases:** none in this build. **Target audience:**
  general/adult, not child-directed. **Content rating:** the IARC
  questionnaire has nothing to declare beyond user-generated content that is
  private to the account.

## Before submitting

- Test the whole flow on a **release** build, not debug: `parley://auth-callback`
  after minification is the classic works-in-debug-only failure
  (`android/RELEASING.md`).
- Confirm `https://api.parley.tw/sign-in` returns HTTP 200. A 404 there is
  exactly what got the iOS 1.0 submission rejected under Apple's 2.1(a); the
  same page is the only door into this app.
- Sign in as the review account on a clean install and confirm its sample
  recordings are visible before handing the credentials to Play.
