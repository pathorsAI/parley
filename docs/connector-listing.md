# Parley Cloud connector — directory submission kit

Everything needed to list Parley Cloud's remote MCP server in **Claude's Connectors Directory** and **ChatGPT's Plugins Directory**. Fields are written to be pasted as-is; anything marked **⚠ TODO** needs a decision or a value before submitting.

| | |
|---|---|
| Server URL | `https://api.parley.tw/mcp` (Streamable HTTP, stateless, JSON responses) |
| Server name | `parley-cloud` 1.0.0 (`serverInfo`) |
| Protocol versions | `2025-06-18`, `2025-03-26`, `2024-11-05` |
| Auth | OAuth 2.0 — authorization code + PKCE, dynamic client registration (Better Auth `mcp` plugin), consent page before any code is issued |
| Tools | `list_orgs`, `list_recordings`, `get_recording`, `search_meetings` — all read-only |
| Source | `apps/cloud/src/mcp.ts` in pathorsAI/parley-internal |

### What the server actually does (ground truth for every claim below)

| Tool | Input | Returns |
|---|---|---|
| `list_orgs` | — | `{ orgs: [{ id, name, role }] }` — organizations the signed-in user belongs to |
| `list_recordings` | `orgId?`, `query?` (title + snippet filter), `folderId?`, `since?` (epoch ms), `limit?` (default 50, max 200) | Newest-first summary cards `{ id, title, source, createdAt, recordedAt, durationMs, speakerCount, findingsCount, actionItemsCount, snippet, folderId }` plus `total` |
| `get_recording` | `id`, `orgId?` | Markdown: title, id, date, length, meeting context, full `[m:ss] Speaker: text` transcript, then Parley's saved brief, findings and action items |
| `search_meetings` | `query`, `orgId?`, `folderId?`, `since?`, `limit?` (default 20), `hitsPerRecording?` (default 5) | `{ results: [{ id, title, recordedAt, hits: [{ in, text, at, speaker }] }], searched, totalInScope }` — case-insensitive substring over title, transcript lines, brief, findings, action items, meeting context; scans the 60 newest recordings in scope |

Scoping rules enforced on every call:

- Without `orgId`, a tool only sees the caller's **personal** recordings (`userId = caller AND orgId IS NULL`). Another user's recording id is reported as not found.
- With `orgId`, the server first checks membership; a non-member gets `You are not a member of that organization. Use list_orgs for the ones you belong to.` as a tool error.
- Deleted (tombstoned) recordings never appear.
- Nothing in the server writes, edits, deletes or sends.

---

## 1. Claude Connectors Directory

Portal: **claude.ai/directory/manage → Add → MCP connector**.

### Name (≤100)

```
Parley
```

### One-liner (≤200)

```
Ask Claude about your meetings. Search and read the transcripts, findings and action items Parley recorded and synced to Parley Cloud.
```

### Description (≤2,000) — English

```
Parley is a desktop and mobile meeting recorder that transcribes conversations in real time, labels who said what, and analyses each meeting into a brief, timestamped findings and action items. The Parley connector gives Claude read-only access to the recordings you have synced to Parley Cloud, so you can ask questions across meetings instead of scrolling through transcripts.

What you can do:
• "What did we promise the customer in last week's call?" — Claude searches every transcript line and finds the moment, with a timestamp and speaker.
• "Summarise Tuesday's planning meeting and list the open decisions." — Claude reads the full transcript plus Parley's own analysis and forms its own view.
• "When did pricing come up across my meetings this month?" — one search spans many recordings.
• Read recordings your team shared into a Parley organization, alongside your personal ones.

Tools:
• list_orgs — the organizations you belong to
• list_recordings — your recordings (or an organization's), newest first, filterable by text, folder and date
• get_recording — one recording's full timestamped transcript, brief, findings and action items
• search_meetings — find what was said or concluded across recordings

The connector is read-only: it cannot record, edit, move, share or delete anything. You sign in with your Parley account and approve the connection on a consent page; Claude only sees recordings your own devices synced to the cloud and recordings shared into organizations you are a member of.

Requires a Parley Cloud account with cloud sync turned on in the Parley app.
```

### Description — zh-TW variant

```
Parley 是桌面與手機上的會議錄音工具：即時逐字稿、標出誰說了什麼，並把每場會議整理成摘要、有時間戳的重點發現與待辦事項。Parley 連接器讓 Claude 以唯讀方式讀取你同步到 Parley Cloud 的錄音，你可以直接跨會議提問，不必再一段段翻逐字稿。

可以這樣用：
•「上週那通電話我們答應了客戶什麼？」——Claude 搜尋每一行逐字稿，找到那一刻，附上時間與講者。
•「幫我整理週二的規劃會議，列出還沒定案的事。」——Claude 讀完整逐字稿與 Parley 的分析，形成自己的判斷。
•「這個月哪幾場會議談到價格？」——一次搜尋涵蓋多場錄音。
• 除了個人錄音，也能讀取團隊分享到 Parley 組織的錄音。

工具：
• list_orgs — 你所屬的組織
• list_recordings — 你（或組織）的錄音，新的在前，可依文字、資料夾、日期篩選
• get_recording — 單場錄音的完整逐字稿（含時間戳）、摘要、重點發現與待辦
• search_meetings — 跨錄音搜尋說過的話與分析結論

連接器是唯讀的：不能錄音、編輯、移動、分享或刪除任何東西。你用 Parley 帳號登入，並在授權頁按下允許；Claude 只看得到你的裝置同步到雲端的錄音，以及你所屬組織分享的錄音。

需要 Parley Cloud 帳號，並在 Parley app 開啟雲端同步。
```

### Categories (1–5)

Pick from the portal's list; in priority order:

1. Productivity
2. Communication
3. Business / Sales *(if offered)*

### Listing slug (permanent once published)

```
parley
```

Fallback if taken: `parley-meetings`. **⚠ Decide before publishing — the slug cannot be changed.**

### URLs

| Field | Value |
|---|---|
| Server URL | `https://api.parley.tw/mcp` |
| Documentation | `https://parley.tw/guides/connect-claude-chatgpt/` **⚠ placeholder slug — confirm against the connector guide being written in parallel** |
| Privacy policy | `https://parley.tw/privacy/` |
| Support | `https://parley.tw/support/` |
| Website | `https://parley.tw/` |

### Use cases

```
1. Cross-meeting recall — find when a topic, price, name or commitment came up across many meetings, with the speaker and timestamp.
2. Meeting follow-up — read one meeting's full transcript and Parley's analysis, then draft a recap, follow-up email or list of open decisions.
3. Account review before a call — read every recording in one customer's folder to prepare for the next conversation.
4. Team knowledge — read recordings a teammate shared into a Parley organization.
```

### Prerequisites

```
A Parley Cloud account (sign in from the Parley desktop or mobile app) with cloud sync turned on, and at least one recording synced to the cloud. Recordings that only exist on a device, with sync off, are not visible to the connector. Organization recordings require membership of that organization.
```

### Reads vs writes

```
Read-only. All four tools only read. The connector cannot create, modify, move, share or delete recordings, folders, organizations or accounts.
```

Tool annotations: every tool should carry `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, plus a `title`. **⚠ A parallel session is adding these to `TOOLS` in `mcp.ts`; confirm they are live (`tools/list`) before submitting.**

### Company

| Field | Value |
|---|---|
| Legal name | Pathors Technology Co., Ltd. |
| Website | `https://pathors.com` |
| Contact email | **⚠ TODO** (support address shown on `parley.tw/support/`) |

### Authentication

```
OAuth 2.0 (required). Authorization code flow with PKCE and dynamic client registration (RFC 7591). Discovery metadata is served at /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource (also /.well-known/oauth-protected-resource/mcp). Users sign in with their Parley account (email, Google, or Apple) and approve the client on a consent page that names the client and lists what it can read; no authorization code is issued without that approval. Access tokens are bearer tokens sent on every POST to /mcp; the server is stateless.
```

### Data handling

| Question | Answer |
|---|---|
| Whose API? | Our own — Parley Cloud (Cloudflare Workers, D1, R2), operated by Pathors |
| Data returned | Meeting titles, dates, durations, speaker-labelled transcripts, Parley's saved analysis (brief, findings, action items), organization names and the user's role |
| Health data | No — Parley does not collect or process health data |
| Sponsored / promotional content | No — tool results contain only the user's own data |
| Payments / purchases | None |
| Third-party data sharing via the connector | None; results go only to the client the user approved |
| Audio | Never returned by the connector |

### Reviewer test account — instructions template

Fill in the blanks, paste into the portal's reviewer-notes field.

```
Test account
  Email:    ____________________
  Password: ____________________
  (Sign-in method: email + password. No 2FA on this account.)

How to connect
  1. Add the connector with URL https://api.parley.tw/mcp.
  2. You will be sent to Parley's sign-in page. Sign in with the credentials above.
  3. A consent page appears. It is in Traditional Chinese: the heading says the client wants to read your Parley recordings, the grey box lists "list synced recordings and organization-shared recordings" and "read transcripts and Parley's analysis", and states it cannot modify or delete anything. Press the dark button on the RIGHT, labelled 允許 ("Allow"). The left button 拒絕 is "Deny".
  4. You are returned to the client, connected.

What is in the account
  • 5 personal recordings (fictional demo meetings, English) from the last two weeks
  • 1 organization, "Northwind Demo Team", with 1 shared recording
  All names and companies are fictional.

Prompts to try
  • "List my Parley recordings."
  • "What did Lumen Freight push back on in the pricing call?"
  • "Search my meetings for 'onboarding' and tell me when it came up."
  • "Which Parley organizations am I in? Show that team's shared recording."
  • "Summarise the hiring debrief and list its action items."

Notes
  • The connector is read-only; there is nothing to clean up after testing.
  • Please do not change the password — other reviewers use this account.
```

---

## 2. ChatGPT Plugins Directory

Portal: **platform.openai.com/plugins → Create → With MCP**, server URL `https://api.parley.tw/mcp`, auth **OAuth** (dynamic client registration).

### Listing fields (`plugin.json` style)

```json
{
  "displayName": "Parley",
  "shortDescription": "Search and read your meeting transcripts, findings and action items from Parley.",
  "longDescription": "Parley records and transcribes your meetings, labels who said what, and turns each one into a brief, timestamped findings and action items. Connect Parley to ChatGPT to ask questions across the recordings you synced to Parley Cloud: find when a topic or commitment came up, read a meeting's full transcript, prepare for a customer call from past conversations, or read recordings your team shared into a Parley organization. The connector is read-only — it cannot record, edit, share or delete anything — and you approve it once on Parley's consent page. Requires a Parley Cloud account with cloud sync on.",
  "developerName": "Pathors Technology Co., Ltd.",
  "category": "Productivity",
  "defaultPrompt": "What did we decide in my most recent Parley meeting?"
}
```

### URLs

| Field | Value |
|---|---|
| Website | `https://parley.tw/` |
| Support | `https://parley.tw/support/` |
| Privacy policy | `https://parley.tw/privacy/` |
| Terms of service | `https://parley.tw/terms/` **⚠ page being drafted in parallel — confirm it is live** |

### Release notes (v1.0.0)

```
First release. Connect ChatGPT to the meetings you recorded with Parley.
• Search across meetings for what was said or concluded, with speaker and timestamp.
• Read a meeting's full transcript together with Parley's brief, findings and action items.
• List and filter recordings by text, folder and date.
• Read recordings shared into Parley organizations you belong to.
Read-only. Sign in with your Parley account and approve the connection once.
```

### Positive test cases (exactly 5)

Run against the demo account (§3). Recording ids are assigned when the seed is synced — copy them in after seeding.

| # | Prompt | Expected tools | Observable result |
|---|---|---|---|
| P1 | "List my recent Parley recordings." | `list_recordings` | A newest-first list of the 5 personal demo meetings with titles and dates ("Lumen Freight — pricing follow-up" first). The shared org recording is **not** in this list. |
| P2 | "What did Lumen Freight push back on in the pricing call?" | `list_recordings` (or `search_meetings`) → `get_recording` | The answer names the per-seat price and the 12-month commitment as objections, and quotes or paraphrases Dana Okafor's lines with `m:ss` timestamps from the transcript. |
| P3 | "Across my meetings, when did we talk about onboarding?" | `search_meetings` with `query` ≈ "onboarding" | Hits from at least two recordings (the pricing call and the customer check-in), each with title, timestamp and speaker. |
| P4 | "Which Parley organizations am I in, and what has that team shared?" | `list_orgs` → `list_recordings` with `orgId` | Names "Northwind Demo Team" with role, then lists its one shared recording, "Weekly product sync — Q4 roadmap". |
| P5 | "Summarise the hiring debrief and list its action items." | `list_recordings` → `get_recording` | A summary of the frontend-engineer debrief (strong system design, concern on testing, decision to do a reference check) plus the saved action items, checked/unchecked as stored. |

### Negative test cases (exactly 3)

| # | Prompt | Expected tools | Observable result |
|---|---|---|---|
| N1 | "Book a meeting with Dana for next Tuesday at 3pm." | **None** | The assistant explains Parley can only read recordings and does not schedule meetings. No Parley tool is called. |
| N2 | "Open Parley recording `rec_00000000-not-mine` and show me the transcript." *(an id belonging to a different account — use a real id from a second test account)* | `get_recording` | Tool returns an error: `No recording rec_… in your recordings. Use list_recordings for valid ids.` No transcript content from the other account appears. |
| N3 | "Show me the recordings in Parley organization `org_not_a_member`." *(an id of an org the demo account is not in)* | `list_recordings` (or `search_meetings`) with that `orgId` | Tool returns an error: `You are not a member of that organization. Use list_orgs for the ones you belong to.` The assistant may then call `list_orgs` and offer Northwind Demo Team instead. |

### Demo video script (≈75 s)

Use only the demo account. Screen recording of ChatGPT (web), 1080p, cursor visible, no real names, no notifications.

| # | Time | Shot | On screen / action | Voice-over (optional) / caption |
|---|---|---|---|---|
| 1 | 0:00–0:06 | Parley desktop, History view | The 5 demo meetings in the list; hover "Lumen Freight — pricing follow-up" | "Parley records and transcribes your meetings." |
| 2 | 0:06–0:16 | ChatGPT → Settings → Apps / connectors | Add Parley; Parley sign-in page appears; sign in with the demo account | "Connect it to ChatGPT with your Parley account." |
| 3 | 0:16–0:22 | Parley consent page | Pause on the page (client name, the read-only list), click 允許 / Allow; back in ChatGPT, connected | Caption: "Read-only. Approve once." |
| 4 | 0:22–0:36 | ChatGPT chat | Type P2: "What did Lumen Freight push back on in the pricing call?" Tool-call chip `get_recording` visible; answer with timestamps | "Ask about one meeting…" |
| 5 | 0:36–0:50 | ChatGPT chat | Type P3: "Across my meetings, when did we talk about onboarding?" `search_meetings` chip; answer cites two meetings with times | "…or search across all of them." |
| 6 | 0:50–1:02 | ChatGPT chat | Type P4; `list_orgs` then `list_recordings`; answer shows Northwind Demo Team's shared roadmap sync | "Includes what your team shared." |
| 7 | 1:02–1:10 | ChatGPT chat | Type "Draft a follow-up email to Dana from that pricing call." Draft appears (no tool needed beyond the earlier read) | "Turn meetings into next steps." |
| 8 | 1:10–1:15 | End card | Parley logo, `parley.tw` | — |

### Domain verification

1. In the plugin portal, start domain verification for `api.parley.tw`; copy the token it shows.
2. Store it as a Worker secret (from `apps/cloud` in parley-internal):
   ```bash
   wrangler secret put OPENAI_APPS_CHALLENGE
   ```
   Paste the token when prompted.
3. Confirm the challenge route serves it (route being added by a parallel session; **⚠ confirm the exact path the portal checks**, e.g. `/.well-known/openai-apps-challenge`):
   ```bash
   curl -s https://api.parley.tw/.well-known/openai-apps-challenge
   ```
4. Press **Verify** in the portal.

---

## 3. Demo account seed plan

Goal: a reviewer (and the demo video) sees a populated account — 5 personal recordings plus 1 organization with 1 shared recording. Everything is fictional. No real customer, person or company names.

### Account

| | |
|---|---|
| Email | **⚠ TODO** — a dedicated mailbox, e.g. `parley-review@` on a domain we control |
| Display name | Alex Morgan |
| Organization | **Northwind Demo Team** (Alex = owner) |
| Cloud sync | On |

### How to load it

**Option A (recommended, produces audio too).** Two or three people read each script aloud in a quiet room while Parley records (mix source with diarization). Rename speakers in the app to the names below, let analysis run, then file into folders. The transcript will differ slightly from the script; that is fine.

**Option B.** Drop each script, as a transcript file, onto the Parley window to import it. **⚠ Verify the accepted transcript formats first**; then rename speakers and run analysis the same way.

After loading: share recording 6 into Northwind Demo Team (move it to the team's folder), wait for sync, then run P1 and P4 to copy the real recording ids into the test cases.

Each transcript line maps to a `TranscriptSegment` (`src/lib/types.ts`):

```json
{ "id": "s1", "source": "mix", "speaker": 1, "text": "…", "isFinal": true, "startMs": 0, "endMs": 6000 }
```

Speaker names live in `HistoryEntry.speakerNames`, keyed `"<source>-<speaker>"`, e.g. `{ "mix-1": "Alex Morgan", "mix-2": "Dana Okafor" }`. The server renders each line as `[m:ss] <name>: <text>`.

### Folders

- `Lumen Freight` — recordings 1 and 4
- `Hiring` — recording 3
- (no folder) — recordings 2 and 5

### Recordings

Dates are relative to the seeding day (D). Times are `startMs` as m:ss.

#### 1. Lumen Freight — pricing follow-up · D−1 · ~18 min · folder Lumen Freight

`mix-1` Alex Morgan (us) · `mix-2` Dana Okafor (Head of Operations, Lumen Freight) · `mix-3` Sam Reyes (Finance, Lumen Freight)

```
[0:05]  Alex:  Thanks for making time again. Last week you asked for a revised quote, so I'd like to walk through it.
[0:42]  Dana:  Sure. Honestly, the per-seat price is still the sticking point. Forty dollars a seat for sixty dispatchers adds up.
[1:30]  Alex:  Understood. If we move to an annual plan, we can bring it to thirty-four.
[2:10]  Sam:   Annual means a twelve-month commitment up front. We'd rather start with a quarter and see adoption.
[3:05]  Dana:  The other thing is onboarding. Our dispatchers work shifts, so a single training day doesn't work for us.
[3:48]  Alex:  We can split onboarding into three short sessions across shifts at no extra cost.
[5:20]  Sam:   If onboarding is included, a six-month term could work. Twelve is a hard no from finance right now.
[7:02]  Alex:  Six months at thirty-six a seat, onboarding included. I'll put that in writing.
[9:40]  Dana:  Send it by Friday and I'll take it to our ops review on the twentieth.
[10:15] Alex:  Friday it is. I'll also include the uptime numbers you asked about.
```

Saved analysis — findings: `[0:42]` Price objection on per-seat cost · `[2:10]` Customer refuses 12-month commitment · `[3:05]` Shift-based onboarding requirement. Action items: ☐ Send revised quote (6 months, $36/seat, onboarding included) by Friday · ☐ Attach uptime numbers.

#### 2. Weekly team standup · D−2 · ~12 min · no folder

`mix-1` Alex Morgan · `mix-2` Priya Natarajan (engineering) · `mix-3` Leo Fischer (design)

```
[0:03]  Alex:  Quick round. Priya, where are we on the export fix?
[0:20]  Priya: Merged yesterday. It's on staging; I want one more day before it ships.
[1:02]  Leo:   The new settings screens are ready for review. I left the empty states for last.
[1:40]  Alex:  Can we get those reviewed before Thursday's customer check-in?
[2:05]  Leo:   Yes, if Priya can look tomorrow morning.
[2:30]  Priya: Tomorrow at ten works.
[3:15]  Alex:  One blocker from me: the analytics vendor hasn't sent the contract back.
[4:00]  Priya: Do we need it before the dashboard work starts?
[4:22]  Alex:  No, but we need it before launch. I'll chase them today.
[5:10]  Leo:   Last thing: I'm out Friday afternoon.
```

Findings: `[0:20]` Export fix on staging, ships after one more day · `[3:15]` Analytics vendor contract outstanding. Action items: ☐ Priya reviews settings screens Wed 10:00 · ☐ Alex chases analytics vendor contract.

#### 3. Hiring debrief — frontend engineer · D−4 · ~15 min · folder Hiring

`mix-1` Alex Morgan · `mix-2` Priya Natarajan · `mix-3` Jordan Lee (engineering manager)

```
[0:04]  Jordan: Let's go round. Overall impression of the candidate first.
[0:25]  Priya:  Strong on system design. She explained the caching trade-offs better than most seniors.
[1:10]  Alex:   I liked how she asked about our users before proposing anything.
[1:52]  Jordan: My concern is testing. When I asked how she'd test the sync logic, it stayed vague.
[2:40]  Priya:  Agreed, that was the weakest part. Could be nerves, could be a gap.
[3:30]  Alex:   Is that coachable, or a reason to pass?
[4:05]  Jordan: Coachable, if everything else holds. I'd want a reference check focused on it.
[5:00]  Priya:  I'm a yes, conditional on the reference.
[5:35]  Alex:   Same. Let's not lose her to a slow process, though.
[6:10]  Jordan: I'll call the references this week and we decide by Monday.
```

Findings: `[0:25]` Strong system design · `[1:52]` Testing answers weak · `[4:05]` Decision: proceed pending reference check. Action items: ☐ Jordan calls references this week · ☐ Final decision by Monday.

#### 4. Lumen Freight — customer check-in · D−9 · ~22 min · folder Lumen Freight

`mix-1` Alex Morgan · `mix-2` Dana Okafor

```
[0:06]  Alex:  How has the pilot gone with the two depots?
[0:30]  Dana:  Mostly well. Dispatchers like the call summaries. The north depot uses it every shift.
[1:45]  Dana:  The south depot barely touched it. Onboarding happened on a day half of them were off.
[2:20]  Alex:  That's on us. We should have scheduled around the rota.
[3:10]  Dana:  Also, they want the summaries in Spanish for a few drivers.
[3:55]  Alex:  Spanish output is supported; I'll turn it on for the south depot.
[5:30]  Dana:  If south catches up, I can make the case for all six depots.
[6:15]  Alex:  What would you need to see to make that case?
[6:50]  Dana:  Usage numbers from both depots, and a price that works for sixty seats.
[7:40]  Alex:  I'll prepare both for our next call.
```

Findings: `[1:45]` South depot under-adopted due to onboarding timing · `[3:10]` Request for Spanish summaries · `[6:50]` Expansion criteria: usage data and 60-seat pricing. Action items: ☐ Enable Spanish summaries for south depot · ☐ Prepare usage report and 60-seat quote.

#### 5. 1:1 with Leo · D−11 · ~25 min · no folder

`mix-1` Alex Morgan · `mix-2` Leo Fischer

```
[0:02]  Alex:  How's the workload feeling this sprint?
[0:18]  Leo:   Busy but fine. The settings redesign is bigger than we scoped.
[1:05]  Alex:  Bigger how?
[1:20]  Leo:   Every screen has three states we didn't draw: loading, empty and error.
[2:30]  Alex:  Should we cut scope or move the date?
[3:00]  Leo:   I'd rather ship the main screens first and do the rest in a second pass.
[4:12]  Alex:  That works. Let's tell the team in standup.
[6:40]  Leo:   I'd also like to run a usability session with two customers.
[7:15]  Alex:  Good idea. I can ask Dana at Lumen Freight if her team would join.
[8:00]  Leo:   Great. Two thirty-minute slots would be enough.
```

Findings: `[1:20]` Settings redesign under-scoped · `[3:00]` Decision: ship main screens first. Action items: ☐ Announce phased settings rollout at standup · ☐ Ask Lumen Freight about usability session.

#### 6. Weekly product sync — Q4 roadmap · D−3 · ~30 min · **shared into Northwind Demo Team**

`mix-1` Alex Morgan · `mix-2` Jordan Lee · `mix-3` Priya Natarajan · `mix-4` Leo Fischer

```
[0:05]  Jordan: Three candidates for Q4: offline mode, the team dashboard, and Spanish summaries everywhere.
[0:48]  Alex:   Customers ask about the dashboard most. Lumen Freight mentioned it twice.
[1:35]  Priya:  Offline mode is the most work. Probably the whole quarter on its own.
[2:20]  Leo:    The dashboard design is half done from the settings work.
[3:10]  Jordan: Spanish is mostly config at this point. Could ship in two weeks.
[4:00]  Alex:   Then Spanish first, dashboard as the main project, offline mode in Q1.
[4:45]  Priya:  I'm fine with that if we freeze the dashboard scope by next Friday.
[5:30]  Jordan: Agreed. Leo, can you have the dashboard spec ready by then?
[6:05]  Leo:    Yes, a first draft by Wednesday, final by Friday.
[6:50]  Jordan: Decision recorded: Spanish, then dashboard; offline moves to Q1.
```

Findings: `[4:00]` Decision: Q4 order — Spanish, dashboard; offline to Q1 · `[4:45]` Dashboard scope freeze by next Friday. Action items: ☐ Leo drafts dashboard spec by Wednesday · ☐ Final dashboard scope by Friday.

### Second account (for N2)

Create a second throwaway account with one recording of its own ("Private test note"). Copy that recording's id from its `list_recordings` into N2. Do not add it to Northwind Demo Team — its org id is also the non-member org for N3 if you create one there (`Other Demo Org`).

---

## 4. Brandon's checklist (in order)

1. **Confirm the parallel pieces are live**: `tools/list` shows read-only annotations and titles; `parley.tw/privacy/`, `/terms/`, `/support/` and the connector guide all load. Replace the guide placeholder slug in this doc if it differs.
2. **Create the demo account** (§3) on a mailbox we control, turn on cloud sync, create Northwind Demo Team.
3. **Seed the 6 recordings**, rename speakers, run analysis, file into folders, share recording 6 into the org. Wait for sync.
4. **Create the second account** and `Other Demo Org` for N2 and N3; note the recording id and org id.
5. **Run all 8 test cases** in both Claude and ChatGPT; fill the real ids into N2/N3; fix anything that fails before submitting.
6. **Prepare the icon**: square PNG, at least 512×512, transparent or solid background, the Parley mark only (no text). **⚠ Check each portal's exact size rule at upload.**
7. **Record the demo video** (§2 script) on the demo account; keep it under 90 s; upload unlisted.
8. **Fill the reviewer test-account template** with the demo credentials (no 2FA).
9. **Submit to Claude**: claude.ai/directory/manage → MCP connector; paste §1 fields; decide the slug (permanent).
10. **Submit to ChatGPT**: platform.openai.com/plugins → With MCP; paste §2 fields, test cases, video link.
11. **Verify the domain**: `wrangler secret put OPENAI_APPS_CHALLENGE` with the portal's token, confirm the route, press Verify.
12. **Don't touch the demo account** while reviews are pending — no password changes, no deletions.
