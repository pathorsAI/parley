# Onboarding — getting started by doing

- **Status**: Approved (option A), in implementation on `ob/*` branches
- **Date**: 2026-09-26, against Parley v0.31.3 (desktop) and iOS 1.18
- **One line**: a new user should finish one full lap — record, see the transcript, file it, replay it, hand it to their own AI — within five minutes, inside the real interface, instead of clicking through ten setup screens and landing on an empty Home.

---

## Context

Parley's product story is now "Record the meeting. Then hand it to the AI you already use." (`website/index.html`, `README.md`). The first-run experience still tells an older story and teaches none of it. A read of the desktop wizard, the iOS onboarding, every empty state and `docs/design/` found seven problems:

| # | Problem | Evidence |
|---|---|---|
| 1 | The onboarding is a **setup wizard, not a lesson**. Ten steps (language, welcome, sign-in, LLM key, STT key, permissions, profile, diarization model, voice typing, done) are all keys and permissions; none shows how the product is used. The final "start your first meeting" button just closes the window. | `src/components/Onboarding.tsx:53-64`, `:121-123` |
| 2 | **Every step can be skipped, and skipping ends in a fake demo.** The default STT provider is Soniox with no key, so "Start meeting" falls through to a mock English negotiation that is never saved. New users conclude the app is broken, or English-only. | `src/lib/meeting/start.ts:38-53`, `src/lib/mockStream.ts` |
| 3 | **Positioning copy is stale.** The wizard says "Your realtime meeting copilot … runs AI evaluations in the background"; the website and README moved on. | `src/i18n/messages.ts` `onboarding.welcome.*` |
| 4 | **Filing, replay, copy and MCP are left to discovery.** "A folder is a customer" is never said; click-to-seek in replay is never mentioned; MCP is absent from onboarding; empty states are a single line with no call to action. | `src/components/library/LibraryScreen.tsx`, `src/components/home/HomeScreen.tsx`, `src/components/replay/ReplayScreen.tsx` |
| 5 | **"Hand it to GPT / Claude" has no action to teach.** The copy menu offers three transcript formats (with speakers, plain, with timestamps) and nothing else: no analysis prompt, no report export, no share-to-AI entry. | `src/components/TranscriptCopyMenu.tsx:67-82` |
| 6 | **iOS has a single sign-in pitch page** with three hard-coded English selling points. Mic permission and the recording-consent sheet correctly wait for the first recording, but filing, replay and copy are not taught either. | `ios/App/Parley/OnboardingView.swift`, `ios/App/Parley/LiveView.swift` |
| 7 | **Sign-in copy disagrees across platforms.** The Mac button says "Sign in with Google", but the hosted page it opens offers email, Google and Apple. Someone who signed up on iPhone with Apple assumes they cannot get in on the Mac. | `messages.ts` sign-in keys; `parley-internal` `apps/cloud/src/signin.ts` |

Smaller copy bugs found on the way, fixed alongside: `welcome.point3` asks for *screen recording* permission when the app needs *system audio recording*; the empty-folder hint says "drag recording cards here" but card drag-and-drop is not implemented (`LibraryCards.tsx`); the Replay empty state says "Upload recording" while the Home button is "Import recording"; the import-without-key error in `src/lib/replay/ingest.ts` is hard-coded English; Settings › MCP still says the server "only reads and writes evaluation and TODO templates" when it exposes 50+ tools.

## Principles

1. **First value in five minutes.** Setup is the toll, not the product. The wizard asks only what is needed for the first recording to produce a transcript; everything else waits.
2. **Teach in context.** A lesson appears where the action is — one line above the thing it explains, once — not in a slide deck before the user has seen the screen.
3. **A step counts only when the user did it.** Checklist items tick from real product events. There is no "I've read this", and clicking a checklist row never ticks it.
4. **One narrative, two native UIs.** Desktop and iOS teach the same four beats. Each uses its own platform's idioms (MCP on the Mac, the share sheet on iPhone) rather than a lowest common denominator.

The four beats are *record* (live, import, or the sample) → *file* (a folder is a customer) → *replay* (click a line to jump) → *hand off* (to the user's own AI). "Record" and "see the transcript and speakers" are one beat, so the checklist has four items.

## Decisions

### D1 — The wizard shrinks to four steps

`intro` (language + welcome) → `account` → `perms` → `done`. The counter reads "n / 4". The closing screen offers two ways out: **Walk through the sample** (loads the sample recording, D4) and **Start a meeting**.

- *Language + welcome* are one screen. The welcome copy carries the current positioning ("Record it, then hand it to the AI you already use") instead of "realtime meeting copilot".
- *Permissions* stays on both platforms: macOS walks the TCC prompts (microphone, system audio recording); Windows has no runtime prompt but this is still the only place that shows whether the mic is allowed and links to `ms-settings:privacy-microphone`.
- *Profile*, *diarization model* and *voice typing* are removed from the wizard (D6).

### D2 — The account step leads with sign-in and gates progress

The step's job is to make sure the first recording can be transcribed.

- The primary action is sign-in. The copy says that signed-in users get Parley's hosted transcription and AI models **free within a monthly allowance**, with no keys to bring.
- The Mac button reads **登入或建立帳號 / Sign in or create an account**, because the hosted page offers email, Google and Apple (context #7). It no longer says "with Google" anywhere.
- **Bring your own keys** (我要自備金鑰 / I'll bring my own keys) is a collapsed, secondary path. Expanded, it shows a transcription provider + key (required, with "Test connection") and an AI provider + key (optional, "you can add this later").
- **Next and Skip are both disabled** until the user is signed in or an STT key is present. An LLM key is never required to proceed.
- In builds with `CLOUD_ENABLED` false (`src/lib/flags.ts`) there is no sign-in half; the key form is shown expanded and the same STT-key gate applies.

Accepted cost: someone who wants neither an account nor a key is stopped at step 2. That is better than today, where they get through and then meet a fake transcript.

### D3 — The production build has no mock transcript

`startMockStream()` runs only under `import.meta.env.DEV`. In a production build, starting a meeting with no usable transcription (no key, or hosted STT without a session) backs out of "recording" and shows a toast with an **Open settings** action, the same way the hosted-without-session branch in `start.ts` already does. D2 makes this path rare; D3 makes it honest when it happens.

### D4 — A bundled sample recording

A new user can finish all four beats without holding a real meeting.

**What ships.** One ~90-second two-person sales call per language in `public/sample/` — `sample-zh-TW.ogg` / `sample-en.ogg` (Ogg/Opus, the app's storage format) plus a pre-transcribed transcript JSON with speakers and timestamps. Loading it (`loadSampleRecording()` in `src/lib/onboarding/sample.ts`) creates a **real library entry** in *Unfiled*, titled 範例：與泓昇科技的第一次通話 / Sample: first call with Hongsheng Technology, meeting kind `sales`, with the script's `context` pre-filled. Sample entries are recognised by the `sample-` id prefix (`sample-hongsheng-{lang}-v1`). The entry goes through the normal pipeline, so a user with a model configured sees a real filing suggestion and a real analysis. It can be deleted; deleting it does not un-tick "recorded".

**How the audio is made.** The scripts are the source of truth: `scripts/sample/script.zh-TW.json` and `script.en.json`. `scripts/sample/render.ts` renders each line with a macOS system `say` voice (`Meijia` / `Reed (Chinese (Taiwan))` for zh-TW, `Samantha` / `Reed (English (US))` for en, at the script's `rate`), joins the lines with a `gapMs` (650 ms) pause, encodes the result, and writes the transcript JSON from the rendered line timings, so audio and transcript agree by construction. `say` was chosen because the build machine has no TTS API key; it is free, offline and reproducible. Voice quality is the trade-off (see Open questions).

**The scene.** A first discovery call between "you" and Mr. Lin (林經理), procurement manager at Hongsheng Technology (泓昇科技). Their support line misses most calls after 8 pm; about 60% of calls are repetitive order-status questions. In seventeen lines:

- **A failed competitor.** They trialled another vendor's voice system last year and shut it down because callers hung up on hearing a machine. "You" answers that the human hand-off is announced up front and only ~15% of callers ask for it, and offers to send the data.
- **A price objection.** Setup ≈ 150k, then 30k/month. Mr. Lin: last year's vendor was 18k. "You" counters with an evenings-only start at ≈ 22k/month.
- **Three commitments with dates**: email the deployment data and the quote before end of day; a demo next Wednesday at 3 pm, built from their most common questions, with Mr. Wang from IT present; a written answer on hosting location before the demo.
- **One unanswered question**: where is the data stored? Some of their customer data cannot leave the country. "You" does not know and defers.

The scene is written so the analysis has something to find. A bland call produces a bland report and teaches the user that handing a transcript to an AI is pointless. This one has an objection to coach, a history to learn from, dated commitments to extract, and a gap to flag — exactly what the analysis prompt (D10) asks for. The zh-TW and en scripts are the same scene, localised rather than translated line by line.

Each script also carries `questions` (three to paste after the transcript) and `mcpQuestions` (three to ask Claude over MCP), written for this scene — e.g. "What did I commit to in this call, with what deadlines? Did he ask anything I didn't answer?" and "Use Parley to find the call with Hongsheng Technology and list what I committed to, the deadlines, and the questions I left unanswered."

### D5 — The Home checklist

After the wizard, Home shows a four-item checklist above *Recent*: **先跑一輪，5 分鐘 / Run through it once — 5 minutes**, with a `n / 4` count and a **不用了 / No thanks** dismiss. Each unfinished item has one CTA. It disappears for good when all four are done or the user dismisses it; Settings › General gets **Show the checklist again** next to "Re-run setup" (`resetGettingStarted()`).

The component is `src/components/home/GettingStarted.tsx`; it only reads state. All four setters live in one place, `src/lib/onboarding/gettingStarted.ts` (`markGettingStarted(step)`, idempotent), and are called from the code path where the event actually succeeds.

| Item (desktop) | Ticks when (`GettingStartedStep`) | CTA |
|---|---|---|
| 錄第一段 / Record your first one | `recorded`: any library entry appears — a live recording saved, an import completed, or the sample loaded | Start a meeting; secondary: Use the sample |
| 放進一個資料夾 / Put it in a folder — one customer, one folder | `filed`: `setEntryFolder(id, folderId ≠ null)`, accepting a folder chip on the filing-suggestion card, or sharing to an org folder | Opens the latest recording's Report, scrolled to the filing row |
| 回放：點一句跳過去 / Replay: click a line to jump there | `replayed`: a click-to-seek in `ReplayTranscript` or a drag on `Scrubber` | Opens the latest recording's Replay tab |
| 連上 Claude 來問 / Connect Claude and ask | `handedOff`: the first successful copy-with-prompt, or the first successful MCP tool call (`get_mcp_activity` has traffic) | Opens the Report's "Hand off to your AI" section (D8) |

On iOS the fourth item reads **分享給你的 AI / Share it with your AI** (D11). The flag is the same.

### D6 — Contextual hints replace three wizard steps

Each hint is one line of inline text with a close button — no spotlight, no overlay, no tooltip arrow, no card — consistent with `desktop-visual-language.md` (blue is a signal; no card-in-card). It shows once and is recorded in `settings.hintsSeen` when seen or closed (`useHint(id)`).

| `HintId` | When | Where | Replaces |
|---|---|---|---|
| `report.filing` | First visit to a Report whose recording is unfiled | Above the filing-suggestion card, or beside `StudyLinkBar` when there is none | — |
| `replay.seek` | First visit to Replay | A thin line at the top of the transcript: "Click any line to jump there. ⌘F to search." | — |
| `copy.handoff` | First time the copy menu opens | Above the "with analysis prompt" item | — |
| `speakers.whoAmI` | First time the user names speakers | `SpeakerBar` / the speaker list: 哪一位是你？/ Which one is you? — the choice is written to `userName` | the *profile* step |
| `home.voiceTyping` | Once, after the checklist completes | A one-time Home banner: Parley also types by voice in any app, with the configured shortcut | the *voice typing* step |

The *diarization model* step needs no hint: the model already downloads itself on first use. Voice typing remains on by default; it is just not sold on day one.

### D7 — "With analysis prompt" joins the copy menu

Replay's copy menu gains a fourth item, **附分析提示 / With analysis prompt** ("paste straight into ChatGPT or Claude"), below the three existing formats. On success the toast says 已複製，貼到你的 AI 就能分析 / Copied — paste it into your AI to analyse. This is the action the checklist's fourth item and the `copy.handoff` hint teach.

### D8 — Desktop hand-off is MCP-first

The Report page ends with a **交給你的 AI / Hand off to your AI** section in two halves.

**Primary — connect Claude Code.** Claude reading the whole library over MCP is the better experience (no copy-paste, every meeting at once, and it can write analysis back), so it leads:

- the command, with a copy button: `claude mcp add --transport http parley http://127.0.0.1:3011/mcp`
- a copyable Claude Desktop config
- **live connection status**, from the same `get_mcp_activity` source as the titlebar's `McpStatusChip` — "Parley must be running; the plug icon lights up once Claude connects"
- three suggested questions to ask over MCP (D10)

**Secondary — copy.** **Copy transcript with analysis prompt** and **複製這份報告 / Copy this report** (the Report as markdown), plus three suggested questions for the pasted transcript.

Settings › MCP's description is corrected to match what the server exposes.

### D9 — Every copy carries the prompt and questions

A copy-with-prompt, a share on iOS, and the suggested questions in D8 always include both the analysis prompt and a set of three questions — a pasted transcript with no question invites a generic summary. For the sample (`isSampleEntry`) the questions come from the script's `questions` / `mcpQuestions`. For every other recording they are generic:

- *Paste*: "What did each side commit to, and by when?" · "What should I have asked but didn't?" · "Where is the risk or the contradiction? Quote the line."
- *MCP*: "Use Parley to find my latest meeting and list the commitments and open questions." · "Read my latest meeting in Parley and suggest what to follow up on." · "Write the key points and risks of my latest meeting back into Parley's analysis."

### D10 — The prompt template

One i18n template per language, following the interface language; `{…}` is filled from the recording.

```
You are my meeting analyst. Below is the full transcript of a meeting. Please:
1. In five sentences or fewer, say what the meeting covered and what was concluded
2. List what each side committed to, with owner and date
3. Point out what I failed to ask, or should follow up on next time
4. Flag anything risky or contradictory, quoting the original line

Meeting: {title} ({date}, {kind})
Context: {context, or "none"}
Speakers: {speakers}; "{me}" is me

Questions I'd like answered:
- {question 1}
- {question 2}
- {question 3}

--- Transcript ---
[0:00] {me}: …
```

Assembling the text is a pure function with unit tests (empty context, unnamed speakers, sample vs generic questions).

### D11 — iOS

- **Sign-in page**: structure unchanged, copy rewritten and moved into `Localizable` (today hard-coded English). Headline 錄下來，交給你已經在用的 AI / Record it, then hand it to the AI you already use. Three points: recording and live transcription that continue on the lock screen; one folder per customer, synced with the Mac; one tap to share with ChatGPT or Claude. The button is **Sign in or create an account**, matching the Mac.
- **Library empty state is the checklist**, same four beats, with **Share it with your AI** as the fourth ("ChatGPT and Claude are in the share sheet").
- **Recording detail**: a new first item, **分享給 AI（附分析提示）/ Share with AI (with analysis prompt)**, opens `UIActivityViewController` with the prompt, the questions and the transcript (D9, D10); the three copy formats stay below it. iOS has no MCP, so hand-off is copy/share-first; Settings' footer adds one line: on the Mac, Claude Code can read the whole library directly.
- **Checklist events**: `MeetingRecorder` save success or sample load → `recorded`; `SaveDestination` / `FilingSuggestionCard` accepted → `filed`; first `PlaybackController` seek → `replayed`; share-sheet completion with `completed == true` → `handedOff`. State lives in `UserDefaults`.
- The mic prompt and the "everyone agrees to be recorded" sheet stay at the first recording; they do not move to the sign-in page (as `docs/design/ios-app-store-readiness.html` also recommends).

### D12 — State, persistence and migration (desktop)

- `settings.gettingStarted: GettingStartedState` — `{ recorded, filed, replayed, handedOff, dismissedAt }` (`src/lib/types.ts`). Visible while `dismissedAt === null` and any flag is false (`isGettingStartedVisible`).
- `settings.hintsSeen: HintId[]` — the five ids in D6 (`ALL_HINT_IDS` in `src/lib/store.ts`).
- Both live in the existing `parley-settings` zustand persist and reach secondary windows through the usual settings sync (`settingsSync.ts`). They are **per device and not synced to the cloud**: the fourth item differs by platform anyway, and a Mac user who finished on iPhone has still not seen the Mac UI.
- `PERSIST_VERSION` goes 3 → 4. `migratePersistedState` gives v3 users with `onboarded === true` a checklist already dismissed and every hint marked seen, so existing users are not re-onboarded. New and not-yet-onboarded users get the defaults. The signal is `onboarded` rather than "has ≥ 1 recording" (the proposal's wording) because the library is not part of the persisted store the synchronous migrate sees. `mergePersistedState` backfills either field from any malformed shape. Both paths are covered by `store.migrate.test.ts` and `gettingStarted.test.ts`.

## Rejected alternatives

**B — Fix the wizard only** (≈ 1–2 days macOS, 0.5 day iOS). Rewrite the copy, add a picture-and-text step on "how to hand it to your AI", block the skip-to-mock path, add CTAs to empty states, fix the small bugs. Cheap, but it is still slides before the product: read once, forgotten, and "hand it to your AI" still has no action behind it. iOS barely changes. Everything in B is included in A.

**C — Spotlight tour** (≈ 4–5 days macOS, 3 days iOS). After the wizard, a five-step overlay highlighting Start meeting → sidebar folders → filing card → replay → copy menu, targeting the sample. It looks the most like teaching, but it is one-shot (interrupt it and it is gone), keeping highlight coordinates correct across the three-column layout is ongoing maintenance, overlay tours feel foreign on iOS, and it still needs the hand-off capability built. C does not conflict with A; it can be reconsidered once there is data on where users stall.

Also rejected:

- **A de-identified real recording as the sample.** More authentic, but it needs consent and de-identification, and it cannot be regenerated or localised. A script can.
- **Ticking items on "I've read this" or on clicking the checklist row.** Violates principle 3; the list would measure attention, not ability.
- **Keeping the mock stream as a zero-setup demo.** It is what makes the app look broken today. The sample replaces its only legitimate use.

## Acceptance checklist

- [ ] Fresh install: on the account step, with no sign-in and no STT key, Next and Skip are disabled; an STT key alone enables them; an LLM key is not required.
- [ ] The Mac sign-in button reads "Sign in or create an account"; no copy says "with Google".
- [ ] A production build with no usable transcription does not play a fake conversation on "Start meeting"; it shows a toast with "Open settings".
- [ ] After the wizard, Home shows the checklist; loading the sample ticks item 1 and creates a real, deletable entry in Unfiled, in the interface language.
- [ ] Accepting a folder chip on the filing card ticks item 2; clicking a Replay line ticks item 3; copying "with analysis prompt" ticks item 4; with all four done the list disappears.
- [ ] Running `claude mcp add …` and making one tool call also ticks item 4; the Report's connection status and the titlebar plug light up.
- [ ] The Report's "Hand off to your AI" section shows the MCP half first, then copy transcript-with-prompt and "Copy this report".
- [ ] Every copied/shared prompt contains the prompt, three questions and the transcript; the sample gets its scene questions, other recordings the generic ones.
- [ ] Existing users (onboarded before v4) do not see the checklist or any hint after upgrading.
- [ ] Each of the five hints appears once and never again after restart; "Show the checklist again" brings the list back.
- [ ] The small copy bugs in Context are fixed; Settings › MCP describes the real tool set.
- [ ] iOS: the sign-in page is localised with three points; the Library empty state is the checklist; the detail page's share item puts prompt + questions + transcript into the Claude app, and ticks item 4.
- [ ] Every new string has `zh-TW` and `en` entries; `bunx tsc --noEmit` and `bunx vitest run` pass.

## Open questions

1. **Should checklist state sync via `/me` later?** Per-device is deliberate for now (D12). If users routinely start on iPhone and continue on the Mac, syncing items 1–3 (not 4) may be worth it.
2. **Sample voice quality.** `say` voices are serviceable but recognisably synthetic. The upgrade path is to swap the renderer in `render.ts` for a hosted TTS once a key is available on the build machine; the scripts stay the source of truth, and the entry id bumps to `-v2` so existing sample entries are not confused with the new audio.
3. **"Copy this report" on iOS.** iOS shows a read-only report; whether it gets the same export in this round is undecided.
4. **Measuring the funnel.** Nothing today reports where users stall between items. Without it, the decision on C (and on the BYOK gate in D2) rests on anecdote.
