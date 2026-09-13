# Parley iOS App Store submission packet

This folder is the version-controlled source for the App Store Connect entry.
It does **not** contain reviewer credentials or screenshots of real meeting
content. Part of it is pushed to Connect by CI — the release notes, the
screenshots, the build, the submission — and part of it is copy for a human to
enter and then keep in sync whenever product data practices change. Which is
which is the table below, and the reasoning is
[at the bottom](#what-is-automated-and-what-is-not).

## What lives where

| In this repo | Who puts it into App Store Connect |
| --- | --- |
| Every field's exact text, both locales | **What's New**: the submit workflow. Description, subtitle, keywords, promotional text: you, in Connect |
| Both screenshot sets, at slot dimensions | The submit workflow, into the 6.9-inch slot of both localizations |
| The privacy-label answers as a table | You — answering the questionnaire and publishing the label |
| Review notes and the Full Access rationale | You — App Review Information, and the reviewer credentials, which are not in this repo |
| — | You: **primary language**, pricing, availability |
| — | The submit workflow: the build attachment, export compliance, and the submission itself |

Some of this can now be pushed from CI, and some deliberately cannot — see
[the last section](#what-is-automated-and-what-is-not).

## Submission order — 1.1

1. **Switch the primary language to English (U.S.)** in App Information, before
   anything else. This is the one step with real blast radius: primary language
   is what every region without its own localization sees, so today a buyer in
   Tokyo or Berlin reads Chinese. Connect restricts when this can be changed, so
   do it while 1.1 is still editable and confirm it took before step 3.
2. In **Distribution**, create iOS version `1.1` and select build `1.1 (5)` once
   it finishes processing. A dry run of the submit workflow now does both — see
   [the last section](#what-is-automated-and-what-is-not).
3. Apply [`metadata/en-US.md`](metadata/en-US.md) to English (U.S.) and
   [`metadata/zh-Hant.md`](metadata/zh-Hant.md) to Traditional Chinese. The
   workflow pushes **What's New** for you; the rest of the fields are yours to
   paste. The English file also records why the name, subtitle, and "what it does
   not do" section read the way they do — worth reading before overriding any of
   them.
4. The screenshots are pushed by the workflow: `screenshots/en-US/` to the
   English localization and `screenshots/zh-Hant/` to the Chinese one, in
   filename order, into the 6.9-inch slot. Both sets are 1320×2868. Regenerate
   with [`capture-screenshots.sh`](capture-screenshots.sh) if the UI has moved —
   and note that the workflow *replaces* the slot's whole set, so anything
   uploaded by hand is gone on the next run.
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
8. Re-run the device test list in `ios/RELEASING.md`. Then dispatch the submit
   workflow with `dry_run=true`, read the version it leaves in Connect, and only
   then dispatch it again with `dry_run=false` — the second run is what sends the
   version to App Review.

## After approval

Replace the placeholder in `website/index.html` (`#iphone` section) with the
real App Store link. The exact `<a>` to paste is in an HTML comment directly
above that section.

## What is automated, and what is not

This folder used to be a packet nothing could push from. It still holds the
canonical copy, but the mechanical half of a submission now runs in CI:
[`ios-store-submit.yml`](../../.github/workflows/ios-store-submit.yml) →
[`asc_submit.py`](../../.github/scripts/asc_submit.py), documented in
[`../RELEASING.md`](../RELEASING.md).

```bash
gh workflow run "iOS store submission" -f version=1.12 -f build=23 -f dry_run=true
```

**The workflow pushes:**

- **What's New**, both locales, from the `## What's New — {version}` section of
  `metadata/en-US.md` and `metadata/zh-Hant.md`. It refuses to run if either
  section is missing, so a version cannot go to review carrying the previous
  release's notes.
- **The 6.9-inch screenshot set**, both locales, from `screenshots/{locale}/` in
  filename order. It deletes and rebuilds the slot rather than adding to it,
  because a screenshot cannot be swapped in place.
- **The build attachment** — the TestFlight `CFBundleVersion` you name, once
  Apple reports it `VALID`.
- **Export compliance** on that build: `usesNonExemptEncryption = false`, which
  is true because the app speaks only HTTPS and ships no cryptography of its own.
- **The review submission itself** — and only when `dry_run=false`. A dry run
  does everything else, so the version sits in Connect exactly as it would be
  submitted, for a human to read first.

**It still leaves you:**

- **Description, subtitle, keywords, promotional text.** The script has a
  `--sync-metadata` flag that would push them and the workflow does not pass it.
  This is the copy people argue about, and it is reviewed against the rendered
  product page rather than pushed blind from a Markdown table.
- **The App Privacy label** — [`privacy-label.md`](privacy-label.md) is the
  answer key, not a payload; the questionnaire is answered and published by hand.
- **Pricing, availability, and primary language.**
- **App Review Information**, including the reviewer account, whose credentials
  are deliberately not in this repository — see
  [`review-notes.md`](review-notes.md).

The split is not arbitrary: what the workflow pushes is text and images this
repository already reviews in a diff, and what it leaves alone is either a
judgement about a rendered page or a secret that must not be here.
