# en-US Play Store listing

Copy each field into the **English (United States)** listing in Play Console
(Grow → Store presence → Main store listing). English and Traditional Chinese
are Parley's two markets: this copy is a peer of
[`listing-zh-TW.md`](listing-zh-TW.md), not its source.

Character limits below are Google Play's, and every field is under them (title
28/30, short description 72/80, full description ~3,530/4,000, release notes
430/500). Keep the punctuation as written — the em dashes are deliberate.

The full description is hard-wrapped here so it diffs cleanly. **Play renders
line breaks literally**, so let paragraphs reflow when you paste: keep the blank
line between paragraphs and the one-per-line bullets, drop the wrap inside a
paragraph.

| Field | Limit | Value |
| --- | --- | --- |
| App name (title) | 30 | `Parley: Dictation & Meetings` |
| Short description | 80 | `Type by talking in any app. Live transcripts of the meetings you sit in.` |
| Full description | 4,000 | below |
| Category | — | Productivity |
| Contact email | — | contact@pathors.com |
| Website | — | https://parley.tw |
| Privacy policy | — | https://parley.tw/privacy/ |
| Support URL | — | https://parley.tw/support/ |

## Full description

The meeting is still going and you can already read it.

Put your phone on the table and hit record. What people say becomes text as they
say it, labelled by speaker — so what you walk out with is a record you can
quote, not a thirty-minute audio file and a blank memory.

Sign in and you get 20 hours of transcription free. No API keys to bring.

Type by talking, in any app

Switch to the Parley keyboard in any text field — a message, an email, a note —
and tap the microphone. Your words appear in the field as you say them, and when
you stop, Parley tidies them into written text: filler gone, punctuation in, a
spoken list laid out as a list. The keyboard is one microphone key; one tap hands
typing back to your usual keyboard. It never reads what is already in the field,
and it switches itself off in password fields.

Record the room

A phone on the table is the whole setup. The transcript grows as the
conversation does, speakers kept apart, and it keeps recording when you switch
apps — with a timer in your notification shade the entire time, so a live
microphone is never a surprise.

Import audio you already have

Already holding the file? Pick an audio file from your phone and Parley turns it
into text in the background — you don't have to sit through it at playback
speed — filed next to the meetings you recorded live. An interview a colleague
captured, a voice memo, something a client sent you. This one is Android's own:
the iPhone app records; this one records and imports.

A bad connection doesn't cost you the meeting

The recording is written to your phone before it goes anywhere. If it can't
upload, it waits in a queue you can see and goes up when you're back online. If
transcription drops mid-meeting, the microphone doesn't stop with it: the audio
stays whole, and the app tells you what happened instead of pretending nothing
did.

Your phone catches the room, the desktop goes deep

Once it syncs to your Parley account, the desktop app takes over: a report with
a clickable timeline, what each side actually committed to, action items, deal
intel, and a read on how you handled it. Parley is a meeting copilot built for
sales, negotiation and interviews.

Also in the app

• Full English and Traditional Chinese, following your system language
• Light and dark, and your wallpaper's colours on Android 12+
• Transcription and analysis usage for the current period, always visible
• Apache-2.0 open source; on desktop you choose the transcription vendor and
  model provider yourself

What it records, and what it doesn't

It records the room you are in, and what you dictate into the Parley keyboard,
through your phone's own microphone — not phone calls, and not audio from other
apps. For online meetings use the desktop app,
which captures system audio properly. There is no player in this version yet:
opening a recording shows you the transcript. Folders and organisation sharing
live on desktop and iPhone for now.

Your data

Nothing is recorded until you press record or the keyboard's microphone key —
dictation is typed into your field and not kept as a recording — and Parley is built for meetings
everyone in the room knows about — it is a note-taker, not a bug. Audio and
transcripts travel over an encrypted connection to your account and are used to
transcribe and sync; they are not sold and not advertised against. You can
delete your account and everything in it yourself:
https://parley.tw/account-deletion/

Parley is Apache-2.0 licensed. Source: github.com/pathorsAI/parley

## Release notes — 0.1.0 (≤ 500 chars)

First release of Parley for Android. Record an in-person meeting and watch the
transcript arrive as people speak, or import an audio file you already have and
have it transcribed. Everything syncs to your Parley account, so a meeting
caught on the phone opens on the desktop app for the report, action items and
analysis. Finished recordings survive a dead network: they queue on the phone
and upload themselves once you are back.

## Notes on the choices here

- **The title is the iOS name.** `Parley: Dictation & Meetings` — Android
  now ships the voice-typing keyboard (`ime/ParleyInputMethodService`), so
  dictation is a claim the app backs, and the two stores can carry one name.
  Until the keyboard shipped the title was `Parley: Meeting Recorder`, because
  promising dictation without one would have been a false claim in the one
  field a store user always reads. The keyboard is voice-only (one microphone
  key, no letter layouts), and the copy says so rather than implying a full
  keyboard like the iPhone's.
- **The import section is deliberately prominent.** It is the one thing this
  app does that the iPhone app does not (`android/README.md`,
  `ImportSession`), and it is the reason someone with an existing pile of audio
  installs it.
- **No consent-prompt claim.** Neither app asks "has everyone agreed?" before
  recording (both dropped it on 2026-09-29): getting the room's permission is
  the user's call, as with any recorder. The copy frames consent as how the app
  is meant to be used, not as a feature. See
  [`review-notes.md`](review-notes.md).
- **"What it does not do" is deliberate**, exactly as on iOS: naming the
  missing player, folders, and call recording up front costs nothing with the
  buyer who wants a meeting recorder and heads off the one-star review from
  someone who expected a call recorder.
- **The account-deletion URL is settled.** Play requires a working
  account-deletion route when an app supports account creation, and
  `https://parley.tw/account-deletion/` is now that route: it documents the
  in-app path on both platforms and an email path for someone who cannot open
  the app. The full description points there rather than at the privacy policy.
