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

One gap remains, and it is not a Play blocker: the Android app still has **no
in-app deletion of a single recording**. `CloudClient.deleteRecording` exists
but has no caller outside the client itself, so the library screen offers no
delete action. Play's form asks about account and account-data deletion, both
of which are covered; per-item deletion is a product gap, not a compliance one.

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
| 2 | `Diagnostics → Other Diagnostic Data` — "Yes, if server logs retain it" | The app ships **no** crash reporter, analytics SDK, or diagnostic upload. Any request/error logging is the backend's, not the app's. | Answer **Crash logs: No**, **Diagnostics: No**, **Other app performance data: No**. Play's form scopes to data the app collects or transmits; server-side request logs belong in the privacy policy. `[TODO: confirm with Jack]` whether `api.parley.tw` retains request logs linked to an account, so the policy says the true thing. |
| 3 | `User Content → Other User Content` includes "folders … and organization placement" | Android surfaces neither. Folders and organizations are explicitly out of scope (`android/docs/app-structure.md`, "Known gaps"; `api-cloud.md`, "Not implemented"). `folderId` exists in the wire shape but nothing sets it. | Nothing to fix — Android collects a strict subset. Do not copy the words "folders" or "organization" into the Play form. |
| 4 | The label covers recordings the user makes | Android also transmits the audio of **files the user imports** — a source iOS does not have (`ImportSession`, `source: "upload"`). | Covered by *Voice or sound recordings*; just do not describe the row as "recordings made in the app". |
| 5 | Deletion is in-app (iOS Settings → Account → Delete Account) | No in-app deletion on Android, of an account or of a recording. | The blocker above. **This is the one real contradiction between the two stores.** |
| 6 | Keyboard extension section (Full Access, no extra data type) | No Android equivalent exists — there is no Parley keyboard in this app. | Ignore that section entirely; it is iOS-only. |

Rows 1–4 are wording differences that come from the two apps genuinely doing
different things. Row 5 is a gap in the product.

## URLs

- Privacy policy: `https://parley.tw/privacy/`
- Account deletion: `https://parley.tw/account-deletion/` — see [Deletion](#deletion--settled).
- Contact: `contact@pathors.com`
