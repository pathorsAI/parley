# Parley for Android — Play Store submission packet

The version-controlled source for the Google Play listing, mirroring
[`../../ios/AppStore/`](../../ios/AppStore). It holds copy, answers and specs;
it holds **no credentials and no screenshots of real meeting content**, and
nothing here can push to Play Console — the save/publish action stays with a
human who can see the rendered product page first.

The Play organization account for Pathors (派斯科技股份有限公司) exists;
identity verification is pending. This packet is what gets pasted in the moment
it clears.

## What lives where

| In this repo | In Play Console (manual) |
| --- | --- |
| Every listing field's exact text, both locales | Pasting it, and pressing Save |
| The Data safety answer sheet as a table | Answering the form and publishing it |
| Review notes, App access instructions, the foreground-service justification | Entering them; the reviewer credentials themselves |
| The 512 × 512 icon, and how to make the rest | Uploading graphics to each localization |
| — | Pricing, countries, content rating questionnaire, app signing |

| File | Purpose |
| --- | --- |
| [`listing-en.md`](listing-en.md) | English (US) title, short and full description, release notes |
| [`listing-zh-TW.md`](listing-zh-TW.md) | Chinese (Traditional, Taiwan) — a peer of the English, not a translation |
| [`data-safety.md`](data-safety.md) | Filled-in Data safety answers, derived from the code, cross-checked against the iOS privacy label |
| [`review-notes.md`](review-notes.md) | App access / demo account, notes to the reviewer, the `microphone` foreground-service declaration and its video |
| [`assets/`](assets) | `icon-512.png`, plus the checklist and commands for the graphics still to be produced |

`../RELEASING.md` remains the process document: account setup, signing, tracks,
and the per-release loop. This folder is only the store-facing content.

## Order of operations

1. Play Console app record: name **Parley**, package `com.pathors.parley`
   (fixed forever at first upload), Free, category Productivity.
2. Upload the first `.aab` to **Internal testing** — that unblocks the App
   content forms, which are what actually gate a release.
3. **App content** → Data safety, using [`data-safety.md`](data-safety.md).
   Read its open item first: there is no account-deletion route an Android-only
   user can reach, and Play asks for one.
4. **App content** → Foreground service permissions: paste the justification
   from [`review-notes.md`](review-notes.md) and attach the demo video. The
   declaration is rejected without the video.
5. **App content** → App access: the demo account and the sign-in steps from
   [`review-notes.md`](review-notes.md). Credentials come from the team secret
   manager, never from this repository.
6. **Main store listing**: paste [`listing-en.md`](listing-en.md) into English
   (United States) and [`listing-zh-TW.md`](listing-zh-TW.md) into Chinese
   (Traditional) – Taiwan, then upload the graphics per
   [`assets/README.md`](assets/README.md).
7. Content rating (IARC), ads declaration (none), target audience, privacy
   policy URL `https://parley.tw/privacy/`.
8. Promote to Production only after the release-build checks in
   [`review-notes.md`](review-notes.md) pass.

## Open items before submission

Each is marked `[TODO: confirm with Jack]` where it appears:

- **Account deletion** — no in-app deletion on Android and no web route an
  Android user can reach; Play requires one. [`data-safety.md`](data-safety.md).
- **The review account** — `appreview@pathors.com` is named in the iOS packet;
  its password is in the secret manager, and this repo cannot verify that it is
  still live or what sample meetings it now holds.
  [`review-notes.md`](review-notes.md).
- **No consent prompt on Android** — iOS has one and advertises it; the Android
  copy therefore does not claim it. [`listing-en.md`](listing-en.md).
- **Feature graphic** — 1024 × 500 does not exist yet.
  [`assets/README.md`](assets/README.md).
- **Screenshots** — no demo mode on Android, so they need a seeded account and
  a manual walk. [`assets/README.md`](assets/README.md).

## After approval

`website/index.html` has no Android section at all today — it covers the
desktop app and iPhone, and its `#iphone` section carries the note that the
App Store link lands there on approval. Giving Android the same treatment (a
section and a Play badge) is its own piece of work, and worth queueing before
the listing goes live rather than after.
