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
> To test: the app opens on a welcome screen with a single 登入或註冊 (Sign in
> or register) button. Tap it, sign in with the supplied email/password account
> on the page that opens, and the app goes straight to the Recording tab. Tap
> 開始錄音 (Start Recording), confirm the consent message, and allow microphone
> access. Speak near the device, then tap 結束會議 (End Meeting). Open Library to
> view the saved recording. In Settings, the reviewer can verify System/Light/Dark
> appearance, sync status, privacy/support links, and account deletion. Account
> deletion is available in Settings → Account → Delete Account.
>
> If the test network is unavailable, the completed recording remains in an
> on-device pending-upload queue and can be retried from Settings → Sync.

## Responses to previous review feedback

Submission 9ebcfa58 (version 1.0 build 3) was rejected under guideline 2.1(a)
for two bugs. Both are fixed in build 4:

- **"An error occurred when we tapped the login button."** The hosted sign-in
  page the app opens returned HTTP 404. The three `/sign-in*` routes had been
  deleted from the backend as collateral in an unrelated refactor; nothing in
  the app had changed. The routes are restored, covered by an automated test,
  and verified in production before resubmitting.
- **"開始錄音 was disabled and not functional."** The Start Recording button was
  disabled whenever no account was signed in — which, because of the bug above,
  was every reviewer. The app now opens on a sign-in screen that explains why an
  account is needed, so the tab bar is only reached with a usable account, and
  the record button is never disabled: if a session expires while the app is
  open, pressing it reopens sign-in instead of doing nothing.

Before resubmitting, confirm `https://api.parley.tw/sign-in` returns HTTP 200.

## Export compliance

The target sets `ITSAppUsesNonExemptEncryption = false`. Confirm this remains
accurate for the release build before answering export-compliance questions.
