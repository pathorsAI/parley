# Data safety answers (Play Console → App content → Data safety)

Every answer below is derived from what the Android app actually does, with the
file that proves it. Play holds the developer to this form, not to the iOS
privacy label, so where the two differ the difference is stated rather than
smoothed over — see [Cross-check against the iOS label](#cross-check-against-the-ios-privacy-label).

Scope: `com.pathors.parley`, the cloud edition as it ships. Base URL
`https://api.parley.tw`, STT relay `wss://api.parley.tw/stt/stream`
(`android/docs/api-cloud.md`, `android/docs/api-parleykit.md`), and the chat
endpoint `POST https://api.parley.tw/v1/chat/completions` — already used by the
filing suggestion on a finished meeting (`filing/FilingPass.kt`, covered by the
meeting-transcript row) and, new with voice typing, called with model
`parley-fast` by the keyboard's optional cleanup pass.

This version also ships a **pure voice input method**:
`com.pathors.parley.ime.ParleyInputMethodService`, a keyboard whose only key is
a microphone (`res/xml/method.xml` — a single subtype, `imeSubtypeMode="voice"`).
Three answers below move because of it, and each is called out where it lands
rather than summarized here: the **audio** row, because audio now leaves the
device from *other apps'* text fields; a new **optional** row, because the
dictated text can be sent to the chat endpoint and a switch turns that off —
alongside the two diagnostic rows; and **row 6 of the iOS
cross-check**, which used to say there was no Android keyboard at all.

> **Action before the next release — by hand.** The release that ships
> problem reports (`feedback/`) changes two answers below: **Crash logs** and
> **Diagnostics** are now *collected*. This file does not update Play. Someone
> has to open Play Console → App content → Data safety, add both data types
> exactly as the table below says, and submit the form **before** the build
> goes to review — a store listing that says "no crash logs" while the app
> sends them is a policy violation Play can act on. The website privacy page is
> updated separately (it is shared with iOS).

## The three top-level questions

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | Account identity, recorded audio and transcripts all leave the device; so do crash logs (automatically unless turned off) and diagnostics (when the user sends a problem report) — and, since voice typing, so does audio dictated into another app's text field. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Everything is HTTPS or WSS to `api.parley.tw` (`CloudClient.DEFAULT_BASE_URL`, `SttRelayClient.DEFAULT_RELAY_URL`), and the manifest sets `android:usesCleartextTraffic="false"`, so a plaintext request cannot be made even by mistake. The keyboard adds no new host and no new scheme: dictation uses the same WSS relay, and the cleanup pass is HTTPS to the same `api.parley.tw` (`CloudClient.chatCompletion`). |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In-app account deletion (`ui/AccountSheet.kt`, two-step confirmation), per-recording deletion from the library, and the public web route a non-installer can reach. See [Deletion](#deletion--settled). |

## Data types

"Collected" in Play's sense means transmitted off the device. "Shared" means
transferred to a third party — Play's definition excludes a service provider
processing on the developer's behalf, which is what the hosted STT vendor is
(`android/docs/api-parleykit.md`: relay → Soniox). So **no row is shared.**

Nothing here is used for advertising, personalization, or fraud prevention,
and there is no third-party analytics, ads, or crash-reporting SDK at all
(`android/app/build.gradle.kts` — Compose, DataStore, Browser, OkHttp,
coroutines, serialization, and the local `:parleykit`, nothing else). The two
diagnostic rows below are the app's own code posting to our own server
(`POST /feedback`); their purpose is Play's **Analytics** in its own definition
— monitoring app health and diagnosing and fixing bugs and crashes — not usage
tracking, and nothing in them identifies the device.
Voice typing changes none of that: the keyboard pulls in no new dependency,
ships no analytics of its own, and reads no identifier, so **Device or other
IDs** stays **No** in the release that ships it.

| Data type (Play taxonomy) | Collected | Shared | Optional? | Purposes | Evidence |
| --- | --- | --- | --- | --- | --- |
| Personal info → **Name** | Yes | No | Required | App functionality, Account management | `CloudUser.name` from `GET /me` (`cloud/Models.kt`); set during hosted sign-in. |
| Personal info → **Email address** | Yes | No | Required | App functionality, Account management | `CloudUser.email`, shown in the account sheet (`ui/AccountSheet.kt`). |
| Personal info → **User IDs** | Yes | No | Required | App functionality, Account management | `CloudUser.id`; the session token stored in DataStore and sent as `Authorization: Bearer` (`auth/AuthManager.kt`, `cloud/CloudClient.kt`). |
| Audio → **Voice or sound recordings** | Yes | No | Required | App functionality | Three sources now, not two. **A recorded meeting:** live mic (`audio/MicCapture.kt`) streamed to the STT relay, and the finished Ogg/Opus file uploaded with `PUT /recordings/{id}/audio` (`upload/MeetingUploader.kt`). **An imported file:** decoded (`audio/AudioFileDecoder.kt`), streamed to the same relay, and uploaded as an Ogg/Opus file the same way. **Dictation:** tapping the microphone key in the Parley keyboard streams `MicCapture` audio to the same relay tagged `?feature=voice_typing` (`ime/DictationSession.kt`, `SttRelayClient.Feature.VOICE_TYPING`; the microphone is held by `ime/DictationService.kt`) — from whatever app has focus, capped at ten minutes per dictation, and **never saved as a recording**. Do not describe this row as "recordings made in the app"; that stopped being true with the keyboard. |
| App activity → **Other user-generated content** (meeting transcripts) | Yes | No | Required | App functionality | Transcript segments, title, duration, speaker indexes and timings pushed by `POST /recordings/{id}` (`android/docs/api-cloud.md`, "meta"). The optional free text of a problem report is also user-written, but only ever sent by the user's own tap — see *Diagnostics*. |
| App activity → **Other user-generated content** (dictated text, cleanup pass) | Yes | No | **Optional** | App functionality | With **AI cleanup** switched on, the raw dictated transcript is sent to `POST /v1/chat/completions` (model `parley-fast`, 6-second budget) and the rewritten text is what gets typed; any failure or timeout types the raw text instead (`parleykit/.../TranscriptPolisher.kt` owns the prompt and the accept gate; `ime/DictationSession.kt` applies the 6-second budget). The switch lives in `ime/VoiceTypingSettingsActivity.kt` and defaults to **on**; switched off, the dictated text never leaves the device — the transcript comes back from the relay and goes straight into the field. |
| App info and performance → **Crash logs** | Yes | No | **Optional** — sent automatically by default; the user can turn it off (Account → Feedback & diagnostics → "Send crash reports automatically"), after which each crash is only offered on the next launch and sent on a tap | Analytics | `feedback/CrashReports.kt`: an uncaught-exception handler writes the crash (exception, stack, thread, time) for the next launch, and on Android 11+ `ApplicationExitInfo` adds native crashes and ANRs. A crash report carries **only** the app version and build, the OS version, the device model and the crash itself — no log, no recording, no account state (`DiagnosticsBuilder.forCrash`). Linked to the account when one is signed in (the request carries the session), anonymous otherwise. Not processed ephemerally. |
| App info and performance → **Diagnostics** | Yes | No | **Optional** — only when the user sends a problem report | Analytics | `feedback/FeedbackCenter.kt`: nothing leaves the phone until the user taps "Send us diagnostics", a retranscribe answer, or Send on the report sheet. The report carries app/OS version, device model, locale and time zone; the recording's shape (id, length, segment count, where the transcript ends — never its words); microphone permission, audio route and recovery count; the upload queue's size and last error; whether someone is signed in; and this process's recent app log, scrubbed of tokens, emails and file names (`feedback/LogScrubber.kt`). A screenshot is included only if the report came from the screenshot prompt and the user did not remove it; it is the app's **own window** drawn by the app (`PixelCopy`), never read from the photo library, which is why *Photos* stays "No". Linked to the account when signed in, anonymous otherwise. Not processed ephemerally. |

The two *Other user-generated content* rows are **one** Play data type. The
form asks optionality once per data type, not once per purpose, and `Other user-generated content` now
covers both a meeting transcript (required — there is no Parley without it) and
the dictation cleanup pass (optional — a switch turns it off). The form cannot
say both. Answer **Required** for the type, since the required half is the half
a user cannot opt out of, and spell the optional half out in the row's
description box. `[TODO: confirm with Jack]` whether to answer Optional
instead: it reads better for the keyboard and is false of meeting transcripts,
which is the wrong way round for a form the developer is held to.

Everything else in Play's taxonomy is **not collected**: Location, Financial
info, Health and fitness, Messages, Photos and videos, Contacts, Calendar,
Files and docs, Web browsing history, In-app search history, Installed apps,
Device or other IDs, App interactions, Other app performance data. Two of those
deserve a sentence because a reviewer may reasonably ask:

- **Files and docs — No.** Importing a recording opens the SAF picker and reads
  one user-chosen file, but the file itself is never uploaded: it is decoded to
  16 kHz PCM, streamed to the relay, and re-encoded to Ogg/Opus
  (`meeting/ImportSession.kt`). What leaves the device is audio, declared
  above. The picked file's **name** does leave the device, because it becomes
  the recording title (`ImportSession.title`) — that is covered by
  *Other user-generated content*.
- **Device or other IDs — No.** No advertising ID, no Play Services, no
  `ANDROID_ID` read, no device fingerprint. The only identifier is the account
  session token. Problem reports name the device *model* ("Google Pixel 8"),
  which identifies a kind of phone, not a phone; each report's id is a fresh
  random UUID per report, not a stable installation id.

### What the keyboard does not collect

The most important claim in this packet, because it is the answer to the
warning Android itself puts in front of the user when a third-party input
method is enabled — that the keyboard "may be able to collect all the text you
type, including personal data like passwords and credit card numbers":

**The Parley keyboard never reads the field it is typing into.** It only
writes, through `InputConnection.setComposingText()` and `commitText()`
(`ime/ParleyInputMethodService.kt`). Point by point, each falsifiable by
reading that one file:

- **No context reads.** No `getTextBeforeCursor()`, `getTextAfterCursor()` or
  `getSelectedText()`. The keyboard offers no suggestions and no
  autocorrection, so it has no reason to read what is already in the field.
- **No keystroke capture, because there are no keystrokes.** The keyboard has
  one key and it is a microphone (`res/xml/method.xml`). No QWERTY, no
  Zhuyin/Bopomofo layout, no symbol or emoji panel — there are no character
  keys to log.
- **No clipboard read, no learning, no personalized dictionary, no per-app
  history.** The only things the input method persists are the user's own
  preference for the cleanup switch and a flag that the keyboard has been used
  on this phone (so What's New can address keyboard users) — no text, no
  audio, no field or app names.
- **Password fields are refused.** When `EditorInfo.inputType` carries
  `TYPE_TEXT_VARIATION_PASSWORD`, `TYPE_TEXT_VARIATION_VISIBLE_PASSWORD`,
  `TYPE_TEXT_VARIATION_WEB_PASSWORD` (what a browser reports for
  `<input type="password">`) or `TYPE_NUMBER_VARIATION_PASSWORD`, the
  microphone key is disabled and no capture can start. The decision is one pure
  function, `ime/InputFieldGuard.kt`, covered by `InputFieldGuardTest`; the tap
  is refused a second time in `ime/ParleyInputMethodService.kt`, because the
  drawn state of a key is a frame old and the guard has to hold at the call
  that reaches the microphone, not only in the rendering. Play's IME security
  guidance asks for exactly this. It is a deliberate, tested refusal, not a
  greyed-out button that a later restyle could quietly undo.
- **Dictation is not stored as a recording.** No library entry, no Ogg file, no
  `POST /recordings/{id}`: the audio is streamed, transcribed, typed, and gone
  (`ime/DictationSession.kt`). Worth stating outright, because a reviewer
  looking at a meeting recorder will assume the opposite.

Android has no per-keyboard "Full Access" gate for this form to ask about —
enabling an input method hands it the input connection outright. Which is
precisely why the no-read discipline and the password refusal are **ours** to
enforce rather than the platform's, and why they are written down here where
they can be checked. See
[row 6 of the iOS cross-check](#cross-check-against-the-ios-privacy-label).

### Required, not optional — except the two diagnostic rows and the cleanup pass

Every row but *Crash logs*, *Diagnostics* and the dictation cleanup pass is
marked "Data collection is required" rather than "Users can choose whether this
data is collected": the app is behind a sign-in wall
(`ui/ParleyRoot.kt`) and a recording is transcribed by the hosted relay, so
there is no configuration of the app in which it functions without sending
these. Recording is of course still user-initiated — `RECORD_AUDIO` is a
runtime permission and a meeting starts only when the user taps record, and a
dictation only when they tap the microphone key.

**The AI cleanup pass is optional.** Switching it off in
`ime/VoiceTypingSettingsActivity.kt` keeps the dictated text off the chat
endpoint, and voice typing still works — the user gets the raw transcript
instead of a tidied one. See the note under the data-type table for how to fit
it into a form that allows one optionality answer per data type.

The two diagnostic rows are optional because the app works identically without
them: crash reports have an off switch in the account sheet (it defaults to on,
and the footnote under it states what a crash report contains), and every other
report is sent only by a tap on a prompt or on the report sheet.

## Security practices

| Practice | Answer |
| --- | --- |
| Data is encrypted in transit | **Yes** — see the table above. |
| Users can request that their data is deleted | See below. |
| Committed to follow the Play Families Policy | No — the app is not child-directed. |
| Independent security review | No. |

On-device storage, for the reviewer's benefit (Play does not ask, but it is the
answer to "where does it sit before upload"): the session token is in a
Preferences DataStore and pending uploads are files under `filesDir`, both
app-private, and `android:allowBackup="false"` keeps them out of cloud backup
(`AndroidManifest.xml`, `android/docs/api-cloud.md`).

## Deletion — settled

Both routes Play cares about now exist (#235), so this is no longer an open
item. The facts:

- The Android app ships **in-app account deletion**: the Account sheet →
  Delete account → `HomeViewModel.deleteAccount()` → `CloudClient.deleteAccount()`
  → `DELETE /me`, with a confirmation dialog and a 409 `owned_organizations`
  refusal when the account still owns a shared org.
- **`https://parley.tw/account-deletion/`** is the required web URL. It
  documents the in-app path on both platforms, the shared-organization
  exception, and an email path from the registered address for anyone who
  cannot open the app.
- The iOS app ships the same thing at Settings → Account → Delete Account
  (`ios/App/Parley/SettingsView.swift` → `AppState.deleteAccount()`).

Voice typing adds nothing to this answer, in either direction: dictation audio
and dictated text are never persisted server-side as a recording, so there is
nothing for a deletion route to reach (see
[What the keyboard does not collect](#what-the-keyboard-does-not-collect)).

No gap remains. Per-recording deletion landed with the catch-up release: the
library offers it from an overflow menu and a long press, behind a confirmation
that names the recording, and it also clears what the phone kept locally — the
audio saved for playback, any queued re-transcription, and the retry ledger
entry. `CloudClient.deleteRecording` used to have no caller outside the client;
it has one now.

Answer **"Users can request that their data is deleted: Yes"** and
**"Users can delete their data from the app: Yes"**, entering
`https://parley.tw/account-deletion/` as the deletion URL. Both answers are
true of the shipped Android app, not borrowed from iOS.

## Cross-check against the iOS privacy label

Compared line by line with `ios/AppStore/privacy-label.md`. Same product, same
backend, so the story has to match; where it does not, the reason is here.

| # | iOS label says | Android reality | What to do |
| --- | --- | --- | --- |
| 1 | `Usage Data → Product Interaction` collected — "hosted STT/LLM usage counters used to enforce included quotas" | The Android app **reads** those counters (`GET /me/usage`, `ui/AccountSheet.kt`); it never sends interaction data. Metering happens server-side, by the byte, from the audio already declared above (`android/README.md`). | Answer **App activity → App interactions: No**. Reading a counter back is not collection. `[TODO: confirm with Jack]` if you would rather mirror iOS and answer Yes for consistency — that is over-declaring, which is safe with Play but makes the two stores say different things about the same server. |
| 2 | `Diagnostics → Crash Data` and `Other Diagnostic Data` | Settled by the problem-reports release: the app now sends crash reports itself (automatically by default, off-switchable) and diagnostics when the user sends a report — the scheme iOS gets in the same release, same `POST /feedback`, same fields. | Answer **Crash logs: Yes** and **Diagnostics: Yes**, both *optional*, purpose *Analytics*, not shared (the table above). **Other app performance data: No** — nothing is measured beyond what those two carry. Server-side request logs are a privacy-policy matter, not a Play answer; the policy page is shared with iOS and updated there. |
| 3 | `User Content → Other User Content` includes "folders … and organization placement" | Android surfaces neither. Folders and organizations are explicitly out of scope (`android/docs/app-structure.md`, "Known gaps"; `api-cloud.md`, "Not implemented"). `folderId` exists in the wire shape but nothing sets it. | Nothing to fix — Android collects a strict subset. Do not copy the words "folders" or "organization" into the Play form. |
| 4 | The label covers recordings the user makes | Android also transmits the audio of **files the user imports** — a source iOS does not have (`ImportSession`, `source: "upload"`). | Covered by *Voice or sound recordings*; just do not describe the row as "recordings made in the app". |
| 5 | Deletion is in-app (iOS Settings → Account → Delete Account) | Android matches it, and goes further: account deletion in the account sheet, **and** per-recording deletion from the library, which iOS does not offer. | Nothing to fix. The two stores no longer contradict each other here. |
| 6 | Keyboard extension section (Full Access, no extra data type) | **This is no longer iOS-only.** Android has a keyboard too (`ime/ParleyInputMethodService.kt`), though a narrower one: voice-only, one microphone key, where the iOS extension also carries QWERTY, Zhuyin and symbol planes (`ios/Keyboard/`). And there is **no Full Access gate** to answer for — Android hands an enabled input method the input connection outright, so there is no capability grant to request or withhold. Its nearest equivalent is the OS's own enable-time warning, which every third-party IME triggers and which no app can reword or suppress. | Do not ignore this section any more — and do not copy it either. The Android keyboard collects **dictation audio** (declared under *Voice or sound recordings*) and, with the cleanup switch on, **the dictated text** (declared under *Other user-generated content*, the optional row). It collects nothing else: see [What the keyboard does not collect](#what-the-keyboard-does-not-collect). There is no Play form field for the enable-time warning; it is answered in onboarding copy and in [`review-notes.md`](review-notes.md), not on this form. |

Rows 1–4 are wording differences that come from the two apps genuinely doing
different things. Row 5 was a gap in the product and is closed. Row 6 is the one row that
changed because of a feature rather than a form: both apps now have a keyboard,
and the two platforms guard it differently enough that the same true story has
to be told in different words.

## URLs

- Privacy policy: `https://parley.tw/privacy/`
- Account deletion: `https://parley.tw/account-deletion/` — see [Deletion](#deletion--settled).
- Contact: `contact@pathors.com`
