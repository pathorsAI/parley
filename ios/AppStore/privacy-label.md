# App Privacy answers

Use these answers in **App Privacy**. They describe the official cloud edition
as it ships on iOS, including the hosted transcription service. Do not mark any
data as used for tracking.

| App Store data type | Collected | Linked to identity | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | App Functionality | Account display name from registration or social sign-in. |
| Contact Info → Email Address | Yes | Yes | App Functionality | Account login and support contact. |
| User Content → Audio Data | Yes | Yes | App Functionality | User-initiated meeting recordings, and audio files the user chooses to import for transcription; retained for synced history. |
| User Content → Other User Content | Yes | Yes | App Functionality | Transcripts, titles, folders, meeting metadata, and organization placement. |
| Identifiers → User ID | Yes | Yes | App Functionality | Account and session association for cloud sync and authorization. |
| Usage Data → Product Interaction | Yes | Yes | App Functionality | Hosted STT/LLM usage counters used to enforce included quotas. |
| Diagnostics → Other Diagnostic Data | Yes, if server logs retain it | Yes | App Functionality | Request/error information used to diagnose service failures. Remove this row only after confirming logs are neither retained nor linkable. |

For every row select **No** for Tracking. For data use, select only **App
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

## URLs

- Privacy Policy: `https://parley.tw/privacy/`
- User Privacy Choices (optional but recommended): `https://parley.tw/privacy/`

## Privacy manifest

`ios/App/Parley/PrivacyInfo.xcprivacy` declares the app’s UserDefaults access
with Apple’s `CA92.1` reason. It intentionally does not duplicate the App
Store privacy label: the manifest reports required-reason APIs, while the
App Privacy questionnaire reports the data practices above.
