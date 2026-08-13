# Parley iOS App Store submission packet

This folder is the version-controlled source for the App Store Connect entry.
It does **not** contain reviewer credentials or screenshots of real meeting
content. Enter the supplied copy in App Store Connect, then keep the Connect
record in sync whenever product data practices change.

## What lives where

| In this repo | In App Store Connect (manual) |
| --- | --- |
| Every field's exact text, both locales | Pasting it, and pressing Save |
| Both screenshot sets, at slot dimensions | Uploading them to the right localization |
| The privacy-label answers as a table | Answering the questionnaire, publishing the label |
| Review notes and the Full Access rationale | App Review Information, reviewer credentials |
| — | **Primary language**, pricing, availability, export compliance |

Nothing here can push to Connect, and that is on purpose — see the last section.

## Submission order — 1.1

1. **Switch the primary language to English (U.S.)** in App Information, before
   anything else. This is the one step with real blast radius: primary language
   is what every region without its own localization sees, so today a buyer in
   Tokyo or Berlin reads Chinese. Connect restricts when this can be changed, so
   do it while 1.1 is still editable and confirm it took before step 3.
2. In **Distribution**, create iOS version `1.1` and select build `1.1 (5)` once
   it finishes processing.
3. Apply [`metadata/en-US.md`](metadata/en-US.md) to English (U.S.) and
   [`metadata/zh-Hant.md`](metadata/zh-Hant.md) to Traditional Chinese. The
   English file also records why the name, subtitle, and "what it does not do"
   section read the way they do — worth reading before overriding any of them.
4. Upload the screenshots: `screenshots/en-US/` to the English localization and
   `screenshots/zh-Hant/` to the Chinese one. Both sets are 1320×2868, the
   6.9-inch slot. Regenerate with
   [`capture-screenshots.sh`](capture-screenshots.sh) if the UI has moved.
5. Apply [`privacy-label.md`](privacy-label.md) in **App Privacy**, including
   the privacy-policy URL. The keyboard extension adds no data type; the file
   explains why, which is worth having to hand. Publish the label before
   submission.
6. Add the non-expiring reviewer account to App Review Information, and re-seed
   its sample meetings in English — see the warning in
   [`review-notes.md`](review-notes.md). Store credentials in the approved
   secret manager, never this repository.
7. Paste the notes from [`review-notes.md`](review-notes.md), including the
   guideline 4.4.1 answer about why the keyboard needs Full Access. Expect that
   question; answering it up front is cheaper than a rejection round trip.
8. Re-run the device test list in `ios/RELEASING.md`, select the build, and
   submit only when every state is verified.

## After approval

Replace the placeholder in `website/index.html` (`#iphone` section) with the
real App Store link. The exact `<a>` to paste is in an HTML comment directly
above that section.

## Why this is a packet, not an automation

App Store Connect fields and reviewer credentials are external state. The copy
is maintained here for reviewability; the final save/publish action stays in
App Store Connect so the team can verify the rendered product page and data
label before it becomes public.
