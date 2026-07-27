# App Review information

## Contact

Use the release owner’s current name, `contact@pathors.com`, and an actively
monitored phone number in App Review Information. Do not enter a personal phone
number in this repository.

## Sign-in required

Create a non-expiring email/password review account in the hosted Parley auth
service. Enter its email and password directly in App Store Connect; store the
credentials only in the approved secret manager.

The account **`appreview@pathors.com`** already exists in production and holds
two clearly-labelled sample meetings (`示範會議…`) so Library and the transcript
view can be reviewed without recording anything. Its password lives in the team
secret manager, never in this repository.

The app opens the hosted first-party sign-in page in an Apple authentication
session. That page offers email/password, Google, and Sign in with Apple. The
review account must use email/password so review does not depend on a personal
Google or Apple identity.

## Notes to App Review

> Parley is a microphone-based recorder for in-person meetings. It does not
> record phone calls, FaceTime, or other apps’ audio. Recording begins only
> after the reviewer taps Start Recording and confirms they have consent from
> participants. The app sends microphone audio to the signed-in account’s
> hosted transcription relay for live transcription, then syncs the completed
> recording and transcript to that account.
>
> To test: sign in with the supplied email/password account, tap Recording,
> confirm the consent message, and allow microphone access. Speak near the
> device, then tap End Meeting. Open Library to view the saved recording. In
> Settings, the reviewer can verify System/Light/Dark appearance, sync status,
> privacy/support links, and account deletion. Account deletion is available in
> Settings → Account → Delete Account.
>
> If the test network is unavailable, the completed recording remains in an
> on-device pending-upload queue and can be retried from Settings → Sync.

## Export compliance

The target sets `ITSAppUsesNonExemptEncryption = false`. Confirm this remains
accurate for the release build before answering export-compliance questions.
