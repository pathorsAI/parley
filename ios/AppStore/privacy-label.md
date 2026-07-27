# App Privacy answers

Use these answers in **App Privacy**. They describe the official cloud edition
as it ships on iOS, including the hosted transcription service. Do not mark any
data as used for tracking.

| App Store data type | Collected | Linked to identity | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | App Functionality | Account display name from registration or social sign-in. |
| Contact Info → Email Address | Yes | Yes | App Functionality | Account login and support contact. |
| User Content → Audio Data | Yes | Yes | App Functionality | User-initiated meeting recordings, retained for synced history. |
| User Content → Other User Content | Yes | Yes | App Functionality | Transcripts, titles, folders, meeting metadata, and organization placement. |
| Identifiers → User ID | Yes | Yes | App Functionality | Account and session association for cloud sync and authorization. |
| Usage Data → Product Interaction | Yes | Yes | App Functionality | Hosted STT/LLM usage counters used to enforce included quotas. |
| Diagnostics → Other Diagnostic Data | Yes, if server logs retain it | Yes | App Functionality | Request/error information used to diagnose service failures. Remove this row only after confirming logs are neither retained nor linkable. |

For every row select **No** for Tracking. For data use, select only **App
Functionality** unless the implementation begins using data for analytics,
advertising, or personalization outside the service the user requested.

## URLs

- Privacy Policy: `https://parley.tw/privacy/`
- User Privacy Choices (optional but recommended): `https://parley.tw/privacy/`

## Privacy manifest

`ios/App/Parley/PrivacyInfo.xcprivacy` declares the app’s UserDefaults access
with Apple’s `CA92.1` reason. It intentionally does not duplicate the App
Store privacy label: the manifest reports required-reason APIs, while the
App Privacy questionnaire reports the data practices above.
