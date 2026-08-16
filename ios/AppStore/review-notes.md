# App Review information

Current target: **1.3 (build 9)** — the Parley Voice keyboard gains a full
English typing layout, and the app is restyled.

## Contact

Use the release owner’s current name, `contact@pathors.com`, and an actively
monitored phone number in App Review Information. Do not enter a personal phone
number in this repository.

## Sign-in required

Create a non-expiring email/password review account in the hosted Parley auth
service. Enter its email and password directly in App Store Connect; store the
credentials only in the approved secret manager.

The account **`appreview@pathors.com`** already exists in production and holds
two clearly-labelled sample meetings so Library and the transcript view can be
reviewed without recording anything. Its password lives in the team secret
manager, never in this repository.

> **Refresh the sample meetings before submitting 1.1.** They are titled in
> Chinese (`示範會議…`) from the 1.0 pass, and English is now the primary
> locale — a reviewer on an English device should not land in a library of
> Chinese titles. Re-seed them with English titles, or one of each.

The app opens the hosted first-party sign-in page in an Apple authentication
session. That page offers email/password, Google, and Sign in with Apple. The
review account must use email/password so review does not depend on a personal
Google or Apple identity.

## Notes to App Review

> Parley is a microphone-based recorder for in-person meetings, plus a voice
> keyboard that dictates into other apps. It does not record phone calls,
> FaceTime, or other apps’ audio — iOS provides no such API and the app does not
> attempt it. Recording begins only after the reviewer taps Start Recording and
> confirms they have consent from participants. The app sends microphone audio
> to the signed-in account’s hosted transcription relay for live transcription,
> then syncs the completed recording and transcript to that account.
>
> **To test recording:** the app opens on a welcome screen with a single "Sign in
> or create an account" button. Tap it, sign in with the supplied email/password
> account on the page that opens, and the app goes to the Record tab. Tap "Start
> recording", confirm the consent message, and allow microphone access. Speak
> near the device, then tap "End meeting". Open Library to see the saved
> recording and tap it for the transcript.
>
> **To test the voice keyboard:** Settings › General › Keyboard › Keyboards ›
> Add New Keyboard › Parley Voice, then tap it and enable "Allow Full Access".
> In any app with a text field (Notes works), switch to the Parley keyboard with
> the globe key and tap the microphone button. Parley opens, records, and the
> transcript types into the field you started from.
>
> The keyboard has two panes, chosen with the toggle at the top right or by
> swiping left and right across it: voice dictation, and a full English QWERTY
> layout with number and symbol planes. **Without Full Access the keyboard opens
> on the English pane and types normally** — dictation is the only thing that
> needs Full Access, and the keyboard says so in place of the microphone.
>
> The globe key is present on every device and in both panes. Tap it to move to
> the next keyboard, hold it for the system keyboard picker. Parley ships no
> Chinese input layout of its own, so this is how a Chinese-language reviewer
> reaches the system's 注音 keyboard.
>
> **Settings** verifies System/Light/Dark appearance, sync status, hosted usage,
> the app’s Language setting, privacy/support links, and account deletion.
> Account deletion is at Settings → Account → Delete Account.
>
> If the test network is unavailable, the completed recording remains in an
> on-device pending-upload queue and can be retried from Settings → Sync.

## Why the keyboard requests Full Access (guideline 4.4.1)

Expect this to be asked; answer it in the notes rather than waiting.

- **What Full Access is used for.** Exactly two things: reaching the App Group
  container shared with the containing app, and letting the containing app’s
  network request run. The keyboard itself never opens a socket, and it never
  transmits, stores, or logs anything the user types.
- **Why it cannot work without it.** Dictation audio has to reach the account’s
  transcription relay. A keyboard extension cannot record audio at all, so the
  keyboard hands off to the containing app, which records; the transcript comes
  back through the App Group. Both halves of that handoff are gated on Full
  Access.
- **What happens when it is denied.** The keyboard degrades instead of breaking:
  it opens on its English typing pane, which is fully functional — letters,
  numbers, symbols, shift, delete, space, return, globe — and it explains what
  Full Access would buy in place of the microphone. It is never a dead
  rectangle.
- **Keystroke handling.** The keyboard inserts text and deletes backwards. It
  builds no typing history, transmits nothing, and has no analytics. It reads
  the document context in exactly one place — a single
  `documentContextBeforeInput` call on the space bar, of which it inspects only
  the last two characters, to decide whether a second tap should become ". ",
  the same shortcut the system keyboard has. Nothing from that read is stored,
  and it never leaves the process.

## Responses to previous review feedback

Submission 9ebcfa58 (version 1.0 build 3) was rejected under guideline 2.1(a)
for two bugs. Both were fixed in build 4 and remain fixed in build 5:

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
