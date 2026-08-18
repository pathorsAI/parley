# en-US Play Store listing

Copy each field into the **English (United States)** listing in Play Console
(Grow → Store presence → Main store listing). English and Traditional Chinese
are Parley's two markets: this copy is a peer of
[`listing-zh-TW.md`](listing-zh-TW.md), not its source.

Character limits below are Google Play's, and every field is under them (title
24/30, short description 71/80, full description ~3,430/4,000, release notes
430/500). Keep the punctuation as written — the em dashes are deliberate.

The full description is hard-wrapped here so it diffs cleanly. **Play renders
line breaks literally**, so let paragraphs reflow when you paste: keep the blank
line between paragraphs and the one-per-line bullets, drop the wrap inside a
paragraph.

| Field | Limit | Value |
| --- | --- | --- |
| App name (title) | 30 | `Parley: Meeting Recorder` |
| Short description | 80 | `Record meetings as a live transcript, or import audio you already have.` |
| Full description | 4,000 | below |
| Category | — | Productivity |
| Contact email | — | contact@pathors.com |
| Website | — | https://parley.tw |
| Privacy policy | — | https://parley.tw/privacy/ |
| Support URL | — | https://parley.tw/support/ |

## Full description

Parley records the meetings you have in person and turns them into a transcript
you can read — while people are still talking.

RECORD THE ROOM

Put the phone on the table and tap record. A live transcript arrives as people
speak, with different speakers kept apart, so what you end up with is something
you can read and quote from instead of a wall of undifferentiated text.
Recording continues while you are in another app, with an ongoing notification
and a running clock so it is never a surprise that the microphone is on.

IMPORT A RECORDING YOU ALREADY HAVE

Already have the audio? Pick any audio file on the phone and Parley transcribes
it — faster than real time — into the same library as the meetings you recorded
live. An interview a colleague captured, a voice memo, a file someone sent you.
This is the Android app's own feature: the iPhone app records, this one records
and imports.

ONE ACCOUNT, EVERY DEVICE

Recordings and transcripts sync to your Parley account, so a meeting you caught
on the phone opens on the desktop app — where the deeper work happens: the
report with clickable timestamps, what each side committed to, action items, a
scorecard on how you delivered, and full-text search across every meeting you
have ever recorded. The phone is the capture end; the desktop is where the
reading happens.

A BAD NETWORK DOES NOT COST YOU THE MEETING

A finished recording is written to the phone before anything is sent anywhere.
If the upload cannot go through, it waits in a queue you can see, and goes up
by itself once you are back on a network. If transcription drops out mid-meeting
the microphone keeps running: you get the audio, and the app says plainly what
happened rather than pretending.

ALSO IN THE APP

• English and Traditional Chinese throughout, following your phone's language
• Light and dark, and your wallpaper's colors on Android 12 and later
• Your plan's transcription and analysis usage for the current period
• A transcript that shows who spoke, in order, with the meeting's length

BRING YOUR OWN STACK

Parley is open source, and the point is that the meeting layer stays yours. On
the desktop you pick the transcription vendor and the model provider that fit
your cost, privacy, language, and latency requirements — Parley is the
interface, not another closed AI bundle. On Android, signing in gets you hosted
transcription with no API key to manage and a free tier that covers everyday
use.

WHAT IT DOES NOT DO

Parley for Android is honest about what is in the box. It records the room
through the phone's own microphone: it does not record phone calls and it does
not capture the audio of other apps. Playback is not in this version — a saved
recording opens as a transcript, not a player. Folders and organization sharing
live in the desktop and iPhone apps for now. Online meetings belong on the
desktop app, which can capture system audio properly. The phone owns the room
you are sitting in.

YOUR DATA

Recording starts only when you tap record, and it is for meetings the people in
the room know about — Parley is a note-taker, not a covert recorder. Audio and
transcripts go to your Parley account over an encrypted connection so they can
be transcribed and synced; they are not sold and not used for advertising. The
privacy policy has the full detail, and account deletion is at
https://parley.tw/account-deletion/.

Parley is Apache-2.0 licensed. Source: github.com/pathorsAI/parley

## Release notes — 0.1.0 (≤ 500 chars)

First release of Parley for Android. Record an in-person meeting and watch the
transcript arrive as people speak, or import an audio file you already have and
have it transcribed. Everything syncs to your Parley account, so a meeting
caught on the phone opens on the desktop app for the report, action items and
analysis. Finished recordings survive a dead network: they queue on the phone
and upload themselves once you are back.

## Notes on the choices here

- **The title is not the iOS name.** iOS ships as `Parley: Dictation &
  Meetings` because it has the Parley Voice keyboard. Android has no keyboard
  extension, so promising dictation here would be a false claim in the one
  field a store user always reads. `Parley: Meeting Recorder` keeps the brand
  first and buys the two words people search.
- **The import section is deliberately prominent.** It is the one thing this
  app does that the iPhone app does not (`android/README.md`,
  `ImportSession`), and it is the reason someone with an existing pile of audio
  installs it.
- **No consent-prompt claim.** The iOS listing advertises "a consent prompt
  before every single recording session". The Android app has no such prompt —
  there is no consent string in either `strings.xml`. The copy therefore frames
  consent as how the app is meant to be used, not as a feature. See
  [`review-notes.md`](review-notes.md); if the prompt is added to Android, this
  paragraph can be upgraded to the iOS wording.
- **"What it does not do" is deliberate**, exactly as on iOS: naming the
  missing player, folders, and call recording up front costs nothing with the
  buyer who wants a meeting recorder and heads off the one-star review from
  someone who expected a call recorder.
- **The account-deletion URL is settled.** Play requires a working
  account-deletion route when an app supports account creation, and
  `https://parley.tw/account-deletion/` is now that route: it documents the
  in-app path on both platforms and an email path for someone who cannot open
  the app. The full description points there rather than at the privacy policy.
