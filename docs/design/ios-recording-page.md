# iOS recording page — Summary | Transcript

- **Status**: Approved, implemented on `ob/w9`
- **Date**: 2026-09-27, iOS 1.20
- **One line**: a recording opens as two faces under one pinned player — what the meeting came to, and what was said — instead of one scroll that mixed the two.

## Context

`RecordingDetailView` was one column: the pinned player, a line of facts (duration, speakers, finding count), the analysis's "Highlights" paragraphs, then the transcript turns. The owner's read: "the record mixes several highlight paragraphs with the transcript; two different kinds of content should be shown apart." A reader looking for the conclusion had to skip turns; a reader following the audio had to scroll past analysis first. The brief and action items — which the desktop already syncs — were not shown at all.

## Decisions

### D1 — One player, two faces

The player stays pinned under the navigation bar and is shared. Under it, a system segmented control: 摘要 / 逐字稿, "Summary" / "Transcript". The control is pinned too, so switching never needs a scroll back to the top. The faces are stacked (only one visible and hit-testable) rather than swapped, so each keeps its own scroll position — returning to the summary after a jump lands where the reader left it, and the transcript keeps following the audio while hidden.

### D2 — The summary face

Top to bottom, in the order someone back from a meeting asks: **brief** (markdown-lite: `**bold**` and `[m:ss]` timestamps as links, parsed by `BriefMarkup` in ParleyKit), **Action items** 後續行動 (check rows; the sample keeps its ticks locally, a cloud recording shows the ticks it has and takes none — the phone has no write path for them), **Highlights {n}** 重點 (the existing finding rows, each with a tappable `m:ss →`), **Speakers** 講者 (plain names). Section labels are small sentence-case `secondaryLabel` text; no cards.

With no analysis the face is never blank: 還沒有摘要。/ "No summary yet." and 用 AI 產生摘要 / "Generate a summary with AI", which opens the existing share-to-AI sheet (prompt + transcript). Speakers still show below it.

### D3 — The transcript face

Only the transcript. Search (the magnifier) lives here and is removed from the toolbar on the summary face; leaving the face closes the field. Follow-along, the 2× edge hold and tap-to-seek are unchanged. The analysis appears only as a margin note: a turn in which a finding starts gets a `lightbulb` line in `secondaryLabel` with the finding's title, tappable to seek. Findings are also dots along the top of the waveform; tapping one seeks.

### D4 — Timestamps are a way into the transcript

Every timestamp on the summary (brief links, action items, highlights) switches to the transcript, seeks, scrolls the turn to the upper third and washes it in the tint at 12% for ~2 s, fading out. The target turn is resolved by `TranscriptAnchor`: a brief writes `[0:08]` for a turn starting at 8.9 s, so a turn that starts within 999 ms after the moment counts, and playback goes to the turn's own start. A recording whose audio is not on the phone still scrolls and lights; it just does not seek.

### D5 — Default face

Summary when the recording has any analysis (brief, findings or action items — `RecordingMeta.hasAnalysis`), transcript otherwise. Chosen once on first load; a reload (e.g. a re-transcription landing) never flips it.

### D6 — What stays the same on both faces

The share/copy menu and the "…" menu are identical on both faces. A pending filing suggestion (onboarding v2) sits above the segmented control, because it is about the whole recording, not either face. The page keeps the visual language: white page, no cards, hairlines and whitespace, blue only on what is happening now or can be tapped.

## Rejected

- **Tabs in the navigation bar or a swipe pager.** A pager fights the transcript's own horizontal gestures (the 2× edge hold), and a nav-bar control has no room beside four toolbar buttons.
- **Summary as a collapsible block above the transcript.** That is the old layout with a disclosure triangle; the two kinds of content still share one scroll.
- **`AttributedString(markdown:)` for the brief.** It does not turn `[1:34]` into anything, and would render headings and tables the face has no room for.

## Screenshots

DEBUG routes (`ScreenshotDemo`): `summary` (analysed recording, summary face), `jump` (a highlight tapped: transcript with the turn lit and 💡 notes), `nosummary` (unanalysed recording forced to the summary face). `transcript` stays the transcript face for the App Store frame.
