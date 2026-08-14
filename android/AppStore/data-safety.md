# Data safety answers (Play Console → App content → Data safety)

Every answer below is derived from what the Android app actually does, with the
file that proves it. Play holds the developer to this form, not to the iOS
privacy label, so where the two differ the difference is stated rather than
smoothed over — see [Cross-check against the iOS label](#cross-check-against-the-ios-privacy-label).

Scope: `com.pathors.parley`, the cloud edition as it ships. Base URL
`https://api.parley.tw`, STT relay `wss://api.parley.tw/stt/stream`
(`android/docs/api-cloud.md`, `android/docs/api-parleykit.md`).

## The three top-level questions

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | Account identity, recorded audio and transcripts all leave the device. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Everything is HTTPS or WSS to `api.parley.tw` (`CloudClient.DEFAULT_BASE_URL`, `SttRelayClient.DEFAULT_RELAY_URL`), and the manifest sets `android:usesCleartextTraffic="false"`, so a plaintext request cannot be made even by mistake. |
| Do you provide a way for users to request that their data is deleted? | **See [Deletion](#deletion-the-open-item)** — the honest answer today is "request by other means", and Play also wants a deletion URL. This is the one answer that is not yet true-and-complete. |

## Data types

"Collected" in Play's sense means transmitted off the device. "Shared" means
transferred to a third party — Play's definition excludes a service provider
processing on the developer's behalf, which is what the hosted STT vendor is
(`android/docs/api-parleykit.md`: relay → Soniox). So **no row is shared.**

Nothing here is used for advertising, analytics, personalization, or fraud
prevention: the app has no analytics, ads, or crash-reporting dependency at all
(`android/app/build.gradle.kts` — Compose, DataStore, Browser, OkHttp,
coroutines, serialization, and the local `:parleykit`, nothing else).

| Data type (Play taxonomy) | Collected | Shared | Optional? | Purposes | Evidence |
| --- | --- | --- | --- | --- | --- |
| Personal info → **Name** | Yes | No | Required | App functionality, Account management | `CloudUser.name` from `GET /me` (`cloud/Models.kt`); set during hosted sign-in. |
| Personal info → **Email address** | Yes | No | Required | App functionality, Account management | `CloudUser.email`, shown in the account sheet (`ui/AccountSheet.kt`). |
| Personal info → **User IDs** | Yes | No | Required | App functionality, Account management | `CloudUser.id`; the session token stored in DataStore and sent as `Authorization: Bearer` (`auth/AuthManager.kt`, `cloud/CloudClient.kt`). |
| Audio → **Voice or sound recordings** | Yes | No | Required | App functionality | Live mic (`audio/MicCapture.kt`) and imported files (`audio/AudioFileDecoder.kt`) are streamed to the STT relay, and the finished Ogg/Opus file is uploaded with `PUT /recordings/{id}/audio` (`upload/MeetingUploader.kt`). |
| App activity → **Other user-generated content** | Yes | No | Required | App functionality | Transcript segments, title, duration, speaker indexes and timings pushed by `POST /recordings/{id}` (`android/docs/api-cloud.md`, "meta"). |

Everything else in Play's taxonomy is **not collected**: Location, Financial
info, Health and fitness, Messages, Photos and videos, Contacts, Calendar,
Files and docs, Web browsing history, In-app search history, Installed apps,
Device or other IDs, App interactions, Crash logs, Diagnostics, Other app
performance data. Two of those deserve a sentence because a reviewer may
reasonably ask:

- **Files and docs — No.** Importing a recording opens the SAF picker and reads
  one user-chosen file, but the file itself is never uploaded: it is decoded to
  16 kHz PCM, streamed to the relay, and re-encoded to Ogg/Opus
  (`meeting/ImportSession.kt`). What leaves the device is audio, declared
  above. The picked file's **name** does leave the device, because it becomes
  the recording title (`ImportSession.title`) — that is covered by
  *Other user-generated content*.
- **Device or other IDs — No.** No advertising ID, no Play Services, no
  `ANDROID_ID` read, no device fingerprint. The only identifier is the account
  session token.

### Required, not optional

Every row is marked "Data collection is required" rather than "Users can choose
whether this data is collected": the app is behind a sign-in wall
(`ui/ParleyRoot.kt`) and a recording is transcribed by the hosted relay, so
there is no configuration of the app in which it functions without sending
these. Recording is of course still user-initiated — `RECORD_AUDIO` is a
runtime permission and a meeting starts only when the user taps record.

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

## Deletion — the open item

**`[TODO: confirm with Jack]` — this must be resolved before the form is
submitted.** The facts:

- The Android app has **no in-app account deletion**. `DELETE /me` is listed
  under "Not implemented" in `android/docs/api-cloud.md` and appears nowhere in
  `android/app/src/main/kotlin/`.
- The Android app also has **no in-app deletion of a single recording**.
  `CloudClient.deleteRecording` exists but has no caller outside the client
  itself — the library screen offers no delete action.
- The iOS app *does* ship account deletion (`ios/App/Parley/SettingsView.swift`
  → `AppState.deleteAccount()` → `DELETE /me`), and `ios/AppStore/review-notes.md`
  tells Apple it is at Settings → Account → Delete Account.
- `website/privacy/index.html` says, verbatim, that an account can be deleted
  "from Settings in the iOS app", and points privacy requests at
  `contact@pathors.com`.

Play requires an account-deletion route — a **web URL** — for any app that
supports account creation, and it must let the user request deletion of the
account *and* of the associated data. An Android-only user who never installs
the iPhone app currently has no self-serve route at all. Three ways out, in
increasing order of effort:

1. **A deletion page on parley.tw** that authenticates and calls `DELETE /me`,
   or that at minimum documents the request path and an SLA. Cheapest thing
   that satisfies Play; the listing copy already points at
   `https://parley.tw/privacy/`, so the page it lands on has to grow that
   section.
2. **Wire `DELETE /me` into the Android account sheet**, matching iOS. One
   endpoint, one confirm dialog; also the answer that stops this being asked
   again at every release.
3. Email-only (`contact@pathors.com`). Accepted by Play as the *request*
   mechanism only if a URL describing it exists — an address in a privacy
   policy paragraph has been rejected before.

Until one of these lands, answer "Users can request that their data is deleted:
**Yes**" only if option 1 or 3 is genuinely live at the URL entered — do not
answer Yes against the iOS Settings screen, which an Android user cannot reach.

## Cross-check against the iOS privacy label

Compared line by line with `ios/AppStore/privacy-label.md`. Same product, same
backend, so the story has to match; where it does not, the reason is here.

| # | iOS label says | Android reality | What to do |
| --- | --- | --- | --- |
| 1 | `Usage Data → Product Interaction` collected — "hosted STT/LLM usage counters used to enforce included quotas" | The Android app **reads** those counters (`GET /me/usage`, `ui/AccountSheet.kt`); it never sends interaction data. Metering happens server-side, by the byte, from the audio already declared above (`android/README.md`). | Answer **App activity → App interactions: No**. Reading a counter back is not collection. `[TODO: confirm with Jack]` if you would rather mirror iOS and answer Yes for consistency — that is over-declaring, which is safe with Play but makes the two stores say different things about the same server. |
| 2 | `Diagnostics → Other Diagnostic Data` — "Yes, if server logs retain it" | The app ships **no** crash reporter, analytics SDK, or diagnostic upload. Any request/error logging is the backend's, not the app's. | Answer **Crash logs: No**, **Diagnostics: No**, **Other app performance data: No**. Play's form scopes to data the app collects or transmits; server-side request logs belong in the privacy policy. `[TODO: confirm with Jack]` whether `api.parley.tw` retains request logs linked to an account, so the policy says the true thing. |
| 3 | `User Content → Other User Content` includes "folders … and organization placement" | Android surfaces neither. Folders and organizations are explicitly out of scope (`android/docs/app-structure.md`, "Known gaps"; `api-cloud.md`, "Not implemented"). `folderId` exists in the wire shape but nothing sets it. | Nothing to fix — Android collects a strict subset. Do not copy the words "folders" or "organization" into the Play form. |
| 4 | The label covers recordings the user makes | Android also transmits the audio of **files the user imports** — a source iOS does not have (`ImportSession`, `source: "upload"`). | Covered by *Voice or sound recordings*; just do not describe the row as "recordings made in the app". |
| 5 | Deletion is in-app (iOS Settings → Account → Delete Account) | No in-app deletion on Android, of an account or of a recording. | The blocker above. **This is the one real contradiction between the two stores.** |
| 6 | Keyboard extension section (Full Access, no extra data type) | No Android equivalent exists — there is no Parley keyboard in this app. | Ignore that section entirely; it is iOS-only. |

Rows 1–4 are wording differences that come from the two apps genuinely doing
different things. Row 5 is a gap in the product.

## URLs

- Privacy policy: `https://parley.tw/privacy/`
- Account deletion: `[TODO: confirm with Jack]` — see [Deletion](#deletion-the-open-item).
- Contact: `contact@pathors.com`
