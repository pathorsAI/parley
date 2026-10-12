# Play review information

What a Google Play reviewer needs to get through this app, and the two
declarations that will otherwise bounce the release: **App access** (the app is
behind a sign-in wall) and **foreground service permissions** (the `microphone`
type needs a demonstration video).

Target: `com.pathors.parley`, versionName `0.1.4` / versionCode `5`
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
- **The account is live and non-expiring** — confirmed 2026-09-13 by signing
  in on the hosted page (`POST /sign-in/email` → 302 to
  `parley://auth-callback?token=…`; on desktop Chrome that redirect shows as
  *canceled*, which is the success case, not a failure — nothing on the desktop
  handles the `parley://` scheme). The password in Play Console → App content →
  App access was re-entered the same day; the one filed on 2026-08-21 did not
  match the account.
- **Seed sample meetings before every submission.** The library of this account
  is empty unless someone puts recordings in it. Seed at least one English and
  one Chinese sample recording so the library and transcript screens have
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

> Parley is a microphone-based recorder for meetings you have in person, a
> transcriber for audio files you already have, and a voice-only keyboard that
> dictates into other apps. It does **not** record phone calls and does not
> capture the audio of other apps — it uses the device microphone only, through
> `AudioRecord`.
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
> If the review device has no audio file on it, this step cannot be performed;
> a short sample clip can be hosted and linked here so the reviewer can
> download one.
>
> **To test voice typing (the Parley keyboard):** it is off until you turn it
> on, because Android requires the user to enable an input method themselves.
>
> 1. Open **Settings → System → Languages & input → On-screen keyboard →
>    Manage keyboards** and switch **Parley** on. Android will show its own
>    warning about what a keyboard could collect; accept it. (What this
>    keyboard actually does and does not read is described below.)
> 2. Open any app with a text field — Notes, a browser, a search box. Tap into
>    the field, then press the keyboard-switch key in the navigation bar and
>    choose **Parley**.
> 3. Tap the **microphone key**. The first time, the keyboard asks for
>    microphone permission by sending you to the **Parley voice typing
>    settings** screen, and the grant happens there. This is not a bug: an
>    input method has no Activity of its own and so cannot request a runtime
>    permission directly, so the settings screen is where Android will accept
>    the grant. Allow microphone access, then go back to your text field.
> 4. Tap the microphone key and speak. The words appear in the field as they
>    are recognized, produced by the same hosted transcription service as the
>    meeting recorder, over the same encrypted connection and the same account.
>    Tap the key again to stop. A dictation also stops itself after ten
>    minutes; the keyboard counts the last 30 seconds down first.
>
> **The keyboard is voice-only — there is one key, and it is the microphone.**
> There is no QWERTY layout, no Zhuyin/Bopomofo layout, no numbers, symbols
> or emoji. This
> is deliberate, not an unfinished screen: you keep whichever keyboard you
> already use for typing and switch to Parley to dictate. The keyboard-switch
> key returns you to your previous keyboard
> (`switchToNextInputMethod(false)`).
>
> **The keyboard refuses password fields.** With Parley active, tap into any
> app's password field — a sign-in screen, a Wi-Fi password prompt. The
> microphone key is disabled and says why, and no audio can be captured. This
> is worth checking, because it is the claim we make about the keyboard that
> matters most.
>
> **Voice typing also uses the `microphone` foreground service**, for the
> seconds the microphone is open: pull down the notification shade while
> dictating and you will see an ongoing notification with a Stop action, which
> disappears when the dictation ends. Nothing dictated is saved — it is
> streamed, transcribed, typed into your field, and gone. No entry appears in
> the Parley library.
>
> **If the network drops**, a finished recording is kept on the device and
> listed under "Waiting to upload" in the library, with an "Upload now" action;
> it also uploads itself when connectivity returns. Nothing is lost.
>
> This version has no audio playback — a saved recording opens as a transcript,
> which is what the store listing says.

## Why a meeting-recording app ships a keyboard

The question a reviewer is entitled to ask about this release, answered
honestly rather than with a feature list.

Parley is a speech product, not a recorder that happens to transcribe. Turning
speech into text for the account is the whole of what the backend does, and
meeting recording is one way in. Dictation is the other, and it is already
shipping on the other two platforms: the desktop app has voice typing, and the
iOS app ships it as a keyboard extension (`ios/Keyboard/`, advertised in
`ios/AppStore/review-notes.md`). Android was the platform without it.

On Android the input-method API is the *only* way to put dictated text into
another app's text field. There is no share sheet for "insert text here", no
accessibility route that is not a much broader grant, and no reason a user
should have to dictate in Parley and paste. So the keyboard is not a second
product bolted on — it is the same hosted speech pipeline as the meeting
recorder, billed to the same account (`?feature=voice_typing` against the same
relay), reached through the same sign-in, and it ships as an input method
because that is the API Android provides for it.

What it deliberately is **not**: a keyboard. There is one key, a microphone.
Parley is not trying to replace Gboard, and a user who enables it keeps their
existing keyboard for typing — which is also why the reviewer should not expect
letters and should not read their absence as a broken screen.

The privacy story is in [`data-safety.md`](data-safety.md), under
"What the keyboard does not collect": the input method only ever *writes* to
the field, never reads it, and refuses to open the microphone in a password
field at all.

## Foreground service permissions declaration (`microphone`)

The manifest declares `FOREGROUND_SERVICE_MICROPHONE` and
`android:foregroundServiceType="microphone"` on **two** services now:
`MeetingService` for meeting recording and `ime/DictationService.kt` for the
keyboard's voice typing. Play Console → App content → **Foreground service
permissions** therefore requires a written justification *and* a video showing
the feature in use. Without the video the declaration is rejected and the
release cannot roll out.

**Justification to enter** — both paragraphs, because one permission now has
two users:

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

Starting that service from an input method is allowed by a documented
exemption from Android 12's background foreground-service-start restrictions —
"your app is the current input method" — and by nothing else;
[`fgs-declaration.md`](fgs-declaration.md) has the full answer.

**The video has been captured**: [`assets/fgs-demo-video.mp4`](assets/fgs-demo-video.mp4),
30.4 s, one continuous take, showing the library → the user starting a
recording → the live transcript with the elapsed timer and level meter → the
shade pulled down over the running recording to show the ongoing "Recording a
meeting" notification, its chronometer and its Stop action → the shade dismissed
→ Stop pressed.

**It is hosted.** Play's form takes a *URL*, not an upload, so the file went up
as an unlisted YouTube video on 2026-08-19:
[`https://youtu.be/jIm6IXJG6iA`](https://youtu.be/jIm6IXJG6iA). That URL, and
nothing invented, is what belongs in the declaration —
[`fgs-declaration.md`](fgs-declaration.md) is where it is recorded.

**TODO (human): re-shoot the video to show voice typing.** The take above
was captured before `DictationService` existed, so it demonstrates only one of
the two users of `RECORD_AUDIO`. Play reviews the declaration against the
**permission**, so a demonstration covering voice typing — preferably one
re-shoot covering both features, since the form holds a single URL — has to be
recorded, uploaded and pasted into the declaration before the release that
ships the keyboard rolls out. That is a person with a phone and a YouTube
account, not something the repository can do. The beats it needs are sketched
in [`fgs-declaration.md`](fgs-declaration.md); no URL for it exists yet.

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
  questions: **neither app shows a consent prompt.** Both used to ask "has
  everyone agreed?" before recording; that was dropped on 2026-09-29 because
  getting the room's permission is the user's call, as with any recorder, and
  the privacy policy tells them to. Do not tell a reviewer there is one.
- **The OS's own keyboard warning.** Worth being straight about because it is the first thing a reviewer enabling
  the keyboard will see: when the user switches on *any* third-party input
  method, Android shows a warning that it "may be able to collect all the text
  you type, including personal data like passwords and credit card numbers".
  **We cannot reword it, suppress it, or answer a form field about it** — it is
  OS behavior applied to every IME on the platform, not a policy question, and
  Android has no per-keyboard capability grant equivalent to iOS's Full Access
  that an app could decline. The only place it can be pre-empted is the app's
  own onboarding, which is where the explanation belongs. What makes our answer
  to that warning *true* rather than reassuring is written down and testable:
  the keyboard only writes to the field and never reads it, and it refuses
  password fields outright — see "What the keyboard does not collect" in
  [`data-safety.md`](data-safety.md), and the password-field check in the notes
  above.
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
