# en-US App Store metadata (primary locale)

Copy each field into the English (U.S.) localization in App Store Connect.
English is the **primary** language: it is what every region without its own
localization sees, so this file is the listing most of the world reads.

Character limits below are Apple's. Keep the punctuation as written — the em
dashes and curly quotes are deliberate.

| Field | Value |
| --- | --- |
| Name (≤ 30) | Parley: Meeting Recorder |
| Subtitle (≤ 30) | Transcribe the room you're in |
| Promotional text (≤ 170) | Put the phone on the table and the transcript arrives as people talk. Then keep the same voice for typing — tap the mic in any app and your words land at the cursor. |
| Keywords (≤ 100 bytes) | meeting,transcript,recorder,voice typing,dictation,speech to text,minutes,interview,notes |
| Support URL | https://parley.tw/support/ |
| Marketing URL | https://parley.tw |
| Privacy Policy URL | https://parley.tw/privacy/ |
| Copyright | © 2026 Pathors AI |

## Description (≤ 4,000 chars)

Parley turns your iPhone into a recorder and a live transcript for the meetings
you have in person — the coffee shop, the customer's office, the table where
nobody is going to open a laptop.

Put the phone down and the transcript arrives while people are still talking.
Speakers are separated automatically, so what you keep is a record you can read,
search, and quote from — not a wall of undifferentiated text.

WHAT IT DOES

• Records in-person meetings through the microphone, with a consent prompt before every single session
• Live transcript with automatic speaker separation while the meeting is still running
• Voice typing anywhere: switch to the Parley keyboard in any app, tap the mic, and your words type themselves in — or put it on the Action Button and skip the keyboard entirely
• A library of your recordings to browse, search, and file into folders
• Personal and organization spaces, with sharing and moving between them
• Finished recordings survive a dead network: they queue on the phone and sync themselves once you are back
• English and Traditional Chinese throughout, following your iPhone's language
• System, light, and dark appearance

BRING YOUR OWN STACK

Parley is open source, and the point is that the meeting layer stays yours. On
the desktop you pick the transcription vendor and the model provider that fit
your cost, privacy, language, and latency requirements — Parley is the interface,
not another closed AI bundle. On iPhone, signing in gets you hosted
transcription with no API key to manage and a free tier that covers everyday use.

ONE ACCOUNT, TWO DEVICES

Recordings and transcripts sync to your Parley account, so a meeting you caught
on the phone opens on the Mac app — where the deeper work happens: the report
with clickable timestamps, what each side committed to, action items, deal
intelligence, and a scorecard on how you delivered.

WHAT IT DOES NOT DO

Parley for iPhone is honest about the platform. iOS gives no third-party app
access to system audio, so this app does not record phone calls, FaceTime, or
sound from other apps, and it never pretends otherwise. Online meetings belong
on the Mac app, which can capture system audio properly. The phone owns the room
you are sitting in.

YOUR DATA

Recording never starts until you confirm that everyone present has agreed to it.
You can delete your account and personal data permanently from Settings →
Account → Delete Account. The privacy policy has the full detail.

Parley is Apache-2.0 licensed. Source: github.com/pathorsAI/parley

## What's New — 1.1

Voice typing comes to the phone. Add the Parley keyboard and dictate into any
app — Messages, Mail, Notes, anything with a text field — using the same
transcription that runs your meetings. Put it on the Action Button and it starts
without a keyboard switch at all.

Also in this release: the app now speaks English as well as Traditional Chinese
and follows your iPhone's language; a welcome screen explains what an account
gets you before asking for one; and the record button is never dead — if a
session expires it opens sign-in instead of doing nothing.

## What's New — 1.0 (superseded, kept for history)

First release of Parley for iPhone: in-person meeting recording, live
transcription, cloud sync, personal and organization libraries, offline retry,
and account management.

## Notes on the choices here

- **The name carries two search terms.** "Parley" alone tells the App Store
  nothing about what the app is; "Parley: Meeting Recorder" keeps the brand
  first and buys the two words people actually search. If the team would rather
  ship the bare wordmark, use `Parley` and move "meeting recorder" to the front
  of the keyword list.
- **The subtitle does not mention voice typing.** Thirty characters only buys
  one idea, and the recorder is the one the screenshots open on. Voice typing
  leads the promotional text and the What's New instead, where it has room.
- **"What it does not do" is deliberate.** Saying plainly that the app cannot
  record calls costs nothing with buyers who want a meeting recorder, and heads
  off the one-star reviews from people who install it expecting a call recorder.
