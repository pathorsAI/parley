# App Privacy answers

> **Before the next submission (1.25 or whichever build first ships crash
> reports and in-app feedback):** App Store Connect's App Privacy answers do
> not update themselves from this file. Someone has to open App Store Connect ›
> App Privacy and, by hand:
>
> - [ ] add **Diagnostics → Crash Data** — Linked to identity: Yes; Tracking:
>       No; Purpose: App Functionality
> - [ ] edit **Diagnostics → Other Diagnostic Data** so it covers in-app
>       reports, not only server logs — same answers
> - [ ] add **User Content → Customer Support** — Linked: Yes; Tracking: No;
>       Purpose: App Functionality
> - [ ] publish the answers, and only then submit the build
>
> Shipping the build first would put a binary that sends crash reports under a
> label that says it does not — the kind of mismatch App Review rejects for,
> and the kind a user is right to be upset about.

Use these answers in **App Privacy**. They describe the official cloud edition
as it ships on iOS, including the hosted transcription service. Do not mark any
data as used for tracking.

| App Store data type | Collected | Linked to identity | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | App Functionality | Account display name from registration or social sign-in. |
| Contact Info → Email Address | Yes | Yes | App Functionality | Account login and support contact. |
| User Content → Audio Data | Yes | Yes | App Functionality | User-initiated meeting recordings, and audio files the user chooses to import for transcription; retained for synced history. |
| User Content → Other User Content | Yes | Yes | App Functionality | Transcripts, titles, folders, meeting metadata, and organization placement; and, while signed in, the personal dictionary (terms the user added and corrections confirmed twice — see below). |
| Identifiers → User ID | Yes | Yes | App Functionality | Account and session association for cloud sync and authorization. |
| Usage Data → Product Interaction | Yes | Yes | App Functionality | Hosted STT/LLM usage counters used to enforce included quotas. |
| Diagnostics → Crash Data | Yes | Yes | App Functionality | MetricKit crash and hang diagnostics (call stacks, exception or signal, app and OS version, device model), sent **automatically by default** on the launch after a crash. The user can turn this off in Settings › Feedback & diagnostics; it is then asked about once per crash. Linked to the account when the user is signed in (the report carries the session token); sent anonymously otherwise. |
| Diagnostics → Other Diagnostic Data | Yes | Yes | App Functionality | Two sources. (1) Server request/error logs used to diagnose service failures, including the `X-Parley-Client: ios/<version> (<build>)` header every request carries. (2) In-app reports, **collected only when the user taps to send one**: app version and build, OS version, device model, locale, time zone, audio route, microphone permission, sync queue length and last error code, recent error codes, and a scrubbed app log (email addresses, tokens and credentials removed; transcript and typed text are never logged in the reported categories). Linked to the account when signed in. |
| User Content → Customer Support | Yes | Yes | App Functionality | What the user writes in the Report a problem sheet, the chips they pick after a re-transcription, and a screenshot of the app's own screen **only if the user sends a report and leaves the screenshot attached**. Collected only when the user sends a report. The screenshot is drawn by the app from its own window; the photo library is never read. |

For every row select **No** for Tracking — crash reports and in-app reports
included: they are used to fix the app and are never combined with data from
other companies or used for advertising. For data use, select only **App
Functionality** unless the implementation begins using data for analytics,
advertising, or personalization outside the service the user requested.

## The keyboard extension does not add a row

The Parley Voice keyboard (1.1) requests Full Access, which reviewers and
privacy-conscious buyers both read as "this keyboard can phone home". The label
still needs no extra data type, and the reason is worth being able to state:

- The keyboard never opens a network connection. It writes a session handle into
  the App Group and opens the containing app; the app records and transcribes.
- It does not read the document context, retain what the user types, or keep any
  typing history — including dictation history, which only the app keeps (see
  below). Its only writes to the text field are the finished transcript,
  a space, a newline, and backspace.
- The dictation audio and its transcript are already covered above under
  **User Content → Audio Data** and **Other User Content**: same account, same
  hosted transcription relay, same retention.

Full Access is a capability grant, not a data type. If the keyboard ever gains
its own network path or any keystroke persistence, this section stops being true
and the label has to change with it.

## Voice typing history does not add a row

Since 1.21 the app keeps what the user dictated (Library › Voice typing), so a
dictation that never landed in its field can be copied again. It adds no
collected data type, because none of it is collected:

- It is stored **on the device only**: one JSON file in the app's own sandbox
  (Application Support), excluded from iCloud backup. It is **never** written to
  the App Group, so the keyboard extension cannot read it, and it is **never**
  sent anywhere — no upload, no sync, no server copy.
- The hosted relay does not store it either. It meters seconds per feature and
  relays transcript frames; it keeps no transcript text.
- Retention is local: the most recent 200 entries, nothing older than 30 days.
  Settings › Voice typing history turns it off and clears it.

Data that never leaves the device is not "collected" in App Store terms. The
dictation audio and transcript *in transit* are already covered above. If this
history ever syncs to the account, it becomes **User Content → Other User
Content** and this section has to go.

## The personal dictionary syncs with the account

Signed in, the app keeps the personal dictionary in step with the account
(`GET`/`PUT /v1/dictionary`), so the desktop and the phone spell the same words.
That is covered by **User Content → Other User Content** above; it adds no row.
Exactly what goes up, and what never does:

- **Sent:** the terms the user typed into the dictionary screen, and corrections
  that are confirmed — seen twice, or entered by hand. Each as the right spelling
  plus the misheard forms that get rewritten into it.
- **Never sent:** corrections still being learned (seen once), and the names
  and phrases the keyboard reads from Contacts and Text Replacement
  (`Lexicon.systemTerms`) — contacts do not leave the phone.
- Only the app syncs. The keyboard extension still opens no network connection;
  what it learns goes up on the app's next sync.
- Logs carry counts, never words. Deleting the account deletes the server copy.

## Crash reports and in-app feedback

Since the feedback release the app is no longer "no telemetry" without
qualification, and the two exceptions are worth being able to state exactly:

- **Crash reports** go automatically by default (Settings › Feedback &
  diagnostics › Send crash reports automatically). With the switch off, the
  next launch after a crash shows a banner asking whether to send it, with a
  tick box to turn automatic sending back on. A hang on its own does not raise
  that banner and is dropped unsent while the switch is off.
- **Everything else is sent only on a tap**: 「傳診斷給我們」 on an empty or
  cut-short transcript, a recording that keeps failing to sync, a meeting whose
  microphone kept dropping, the chips after a re-transcription, the toast after
  deleting a failed recording, the screenshot toast, and Settings › Report a
  problem.
- **Never sent**, by any of these paths: audio recordings, transcript text, and
  anything typed with the keyboard. The keyboard extension still opens no
  network connection of its own, and its process's log is out of reach of the
  app's report builder (`OSLogStore(scope: .currentProcessIdentifier)`).

Reports that cannot be sent right away wait in the app's own Application
Support directory (at most 20) and are retried on the next launch, when the
network returns, or after sign-in. Deleting the app deletes them.

## URLs

- Privacy Policy: `https://parley.tw/privacy/`
- User Privacy Choices (optional but recommended): `https://parley.tw/privacy/`

## Privacy manifest

`ios/App/Parley/PrivacyInfo.xcprivacy` declares the app’s UserDefaults access
with Apple’s `CA92.1` reason. It intentionally does not duplicate the App
Store privacy label: the manifest reports required-reason APIs, while the
App Privacy questionnaire reports the data practices above.
