// Fictional demo data for the Parley desktop screenshots. No real customers,
// no real people: companies are invented (北風工業 / Northwind, 晴光實驗室 /
// Halcyon Labs, 子午線 / Meridian) and speakers keep the app's own default
// labels (你 / 遠端 1 — You / Remote 1). Kept consistent with the iOS App
// Store screenshots' renewal conversation.
import type { ActionItem, DeliveryAssessment, TimelineEvent, TodoItem, TranscriptSegment } from "@repo/lib/types";
import type { HistoryEntry, HistoryEntrySummary } from "@repo/lib/history/types";

export type Lang = "zh" | "en";

const MIN = 60_000;
const SEC = 1000;
const at = (m: number, s: number) => m * MIN + s * SEC;

// ── Folders ───────────────────────────────────────────────────────────────
export function folders(lang: Lang) {
  const base = Date.UTC(2026, 5, 1);
  const zh = lang === "zh";
  return [
    { id: "f-renewals", name: zh ? "續約" : "Renewals", createdAt: base },
    { id: "f-newbiz", name: zh ? "新客戶" : "New business", createdAt: base + 1 },
    { id: "f-internal", name: zh ? "內部" : "Internal", createdAt: base + 2 },
  ];
}

// ── The renewal conversation (speaker A = client = remote 1, B = you/mic) ──
interface Line {
  who: "A" | "B";
  atMs: number;
  zh: string;
  en: string;
}

const RENEWAL: Line[] = [
  {
    who: "A",
    atMs: at(0, 12),
    zh: "平台整體我們用得很滿意，卡住的是席次——我們編了四十席，但報價回來是八十席。",
    en: "We're happy with the platform overall. The blocker is the seat count — we budgeted for forty and the quote came back at eighty.",
  },
  {
    who: "B",
    atMs: at(0, 27),
    zh: "四十席是企業版的最低門檻，我沒辦法再往下。我能做的是把今年的價格鎖到下一次續約。",
    en: "Forty is the floor on the enterprise tier, so I can't go under it. What I can do is hold this year's price through the next renewal.",
  },
  {
    who: "A",
    atMs: at(0, 44),
    zh: "鎖價有幫助。那你上週提到的導入時間呢，你說兩週？",
    en: "A price hold helps. What about the onboarding time you mentioned last week — you said two weeks?",
  },
  {
    who: "B",
    atMs: at(0, 58),
    zh: "兩週的前提是你們的 SSO 已經接在 Okta 上。如果還沒有，要多一週做身分對應。",
    en: "Two weeks assumes your SSO is already on Okta. If it isn't, add a week for the identity mapping.",
  },
  {
    who: "A",
    atMs: at(1, 16),
    zh: "已經接了。那請把含鎖價的新報價用書面寄給我，我週四拿去給財務。",
    en: "It is. Send the revised quote with the price hold in writing and I'll take it to finance on Thursday.",
  },
  {
    who: "B",
    atMs: at(1, 32),
    zh: "我明天早上寄給你，也會附上你們團隊要的資安問卷。",
    en: "I'll have it to you tomorrow morning, and I'll include the security questionnaire your team asked for.",
  },
];

function toSegment(line: Line, i: number, lang: Lang, offsetMs: number, next?: Line): TranscriptSegment {
  const text = lang === "zh" ? line.zh : line.en;
  const startMs = line.atMs + offsetMs;
  const endMs = next ? next.atMs + offsetMs - 1200 : startMs + 9000;
  return {
    id: `seg-${i}`,
    // The mic is "me" (speaker 0 → 你 / You); the far end is system audio,
    // diarized speaker 1 → 遠端 1 / Remote 1. Both are the app's defaults.
    source: line.who === "B" ? "me" : "them",
    speaker: line.who === "B" ? 0 : 1,
    text,
    isFinal: true,
    startMs,
    endMs,
  };
}

/** The finished meeting's full transcript (report scene). */
export function renewalSegments(lang: Lang): TranscriptSegment[] {
  return RENEWAL.map((l, i) => toSegment(l, i, lang, 0, RENEWAL[i + 1]));
}

// ── Live scene ────────────────────────────────────────────────────────────
/** Where in the meeting the live excerpt sits: the timer reads ~18:47, so the
 *  exchange is shifted to end there rather than at the 1:32 of the replay. */
export const LIVE_OFFSET_MS = at(17, 40);
export const LIVE_ELAPSED_MS = at(18, 47);

export function liveSegments(lang: Lang): TranscriptSegment[] {
  const settled = RENEWAL.slice(0, 3).map((l, i) => toSegment(l, i, lang, LIVE_OFFSET_MS, RENEWAL[i + 1]));
  const partialLine = RENEWAL[3];
  const partial = toSegment(partialLine, 3, lang, LIVE_OFFSET_MS);
  partial.text = lang === "zh" ? "兩週的前提是你們的 SSO 已經" : "Two weeks assumes your SSO is already";
  partial.isFinal = false;
  partial.endMs = LIVE_ELAPSED_MS - 400;
  return [...settled, partial];
}

export function liveFindings(lang: Lang): TimelineEvent[] {
  const zh = lang === "zh";
  return [
    {
      id: "lf-seats",
      atMs: RENEWAL[0].atMs + LIVE_OFFSET_MS,
      side: "them",
      severity: "warn",
      source: "extra",
      title: zh ? "席次落差：編 40 席、報價 80 席" : "Seat gap: budgeted 40, quoted 80",
      detail: zh
        ? "客戶認可平台，真正卡住的是席次預算，不是單價——談判的槓桿在席次，不在折扣。"
        : "They like the platform; what's stuck is the seat budget, not the unit price — the lever is seats, not discount.",
      quotes: [RENEWAL[0][lang === "zh" ? "zh" : "en"]],
    },
    {
      id: "lf-hold",
      atMs: RENEWAL[1].atMs + LIVE_OFFSET_MS,
      side: "me",
      severity: "info",
      source: "extra",
      title: zh ? "用鎖價換席次" : "Price hold instead of fewer seats",
      detail: zh
        ? "守住 40 席企業版門檻，改以今年價格鎖到下次續約作為讓步；對方回應正面。"
        : "Held the 40-seat enterprise floor and offered this year's price through the next renewal; they took it well.",
    },
    {
      id: "lf-onboard",
      atMs: RENEWAL[2].atMs + LIVE_OFFSET_MS,
      side: "them",
      severity: "info",
      source: "extra",
      title: zh ? "導入時程是下一個顧慮" : "Onboarding time is the next concern",
      detail: zh
        ? "客戶在意兩週能不能上線；答案取決於 SSO 是否已接 Okta，先確認再承諾。"
        : "They care whether two weeks is real; it hinges on SSO already being on Okta — confirm before committing.",
    },
  ];
}

export function liveTodos(lang: Lang): TodoItem[] {
  const zh = lang === "zh";
  return [
    { id: "t1", text: zh ? "確認續約席次" : "Confirm the renewal seat count", done: true },
    { id: "t2", text: zh ? "提出價格鎖定方案" : "Offer a price hold", done: true },
    { id: "t3", text: zh ? "確認 SSO 是否已接 Okta" : "Check whether SSO is on Okta", done: false },
    { id: "t4", text: zh ? "約定書面報價寄出時間" : "Agree when the written quote goes out", done: false },
  ];
}

// ── Report scene (the finished renewal meeting) ────────────────────────────
function renewalFindings(lang: Lang): TimelineEvent[] {
  const zh = lang === "zh";
  return [
    {
      id: "rf-seats",
      atMs: RENEWAL[0].atMs,
      side: "them",
      severity: "warn",
      source: "extra",
      title: zh ? "席次落差：編 40 席、報價 80 席" : "Seat gap: budgeted 40, quoted 80",
      detail: zh
        ? "客戶認可平台，卡住的是席次預算，不是單價。"
        : "They like the platform; the seat budget is the blocker, not the unit price.",
    },
    {
      id: "rf-hold",
      atMs: RENEWAL[1].atMs,
      side: "me",
      severity: "info",
      source: "extra",
      title: zh ? "用鎖價換席次" : "Price hold instead of fewer seats",
      detail: zh
        ? "守住 40 席門檻，改以今年價格鎖到下次續約作為讓步。"
        : "Held the 40-seat floor; offered this year's price through the next renewal instead.",
    },
    {
      id: "rf-sso",
      atMs: RENEWAL[3].atMs,
      side: "them",
      severity: "info",
      source: "extra",
      title: zh ? "導入兩週的前提：SSO 已接 Okta" : "Two-week onboarding depends on Okta SSO",
      detail: zh ? "客戶確認已接，時程可以照兩週走。" : "They confirmed it is, so two weeks stands.",
    },
    {
      id: "rf-finance",
      atMs: RENEWAL[4].atMs,
      side: "them",
      severity: "info",
      source: "extra",
      title: zh ? "週四交財務" : "Goes to finance on Thursday",
      detail: zh
        ? "客戶要書面報價，週四帶去財務——這是明確的推進訊號。"
        : "They asked for the quote in writing to take to finance Thursday — a clear buying signal.",
    },
  ];
}

function renewalActions(lang: Lang): ActionItem[] {
  const zh = lang === "zh";
  return [
    {
      id: "a1",
      text: zh ? "寄出含價格鎖定的新報價（週四前）" : "Send the revised quote with the price hold (before Thursday)",
      done: false,
      linkedEventId: "rf-finance",
      atMs: RENEWAL[4].atMs,
      severity: "info",
    },
    {
      id: "a2",
      text: zh ? "附上資安問卷" : "Include the security questionnaire",
      done: false,
      linkedEventId: null,
      atMs: RENEWAL[5].atMs,
    },
    {
      id: "a3",
      text: zh ? "追蹤財務審核結果" : "Follow up on finance's review",
      done: false,
      linkedEventId: "rf-finance",
      atMs: RENEWAL[4].atMs,
      severity: "info",
    },
  ];
}

function renewalBrief(lang: Lang): string {
  if (lang === "zh") {
    return `## 談到哪裡
客戶認可平台，卡在席次（編 40 席 vs 報價 80 席）[0:12]。我方守住 40 席企業版門檻，改以今年價格鎖到下次續約作為讓步 [0:27]；導入時程兩週，前提 SSO 已接 Okta（已確認）[0:58] [1:16]。

## 雙方承諾
- **我方**：明早寄出含鎖價的書面報價，並附上資安問卷 [1:32]
- **客戶**：週四把報價交給財務 [1:16]

## 還不清楚的
- 財務審核要多久、最後由誰簽核——寄報價時順手問清楚。
- 八十席的報價是怎麼來的，客戶端是否有人還在用舊的席次估算。`;
  }
  return `## Where this landed
The customer is happy with the platform; the blocker is seats (budgeted 40 vs. quoted 80) [0:12]. We held the 40-seat enterprise floor and offered to hold this year's price through the next renewal instead [0:27]. Onboarding is two weeks, provided SSO is already on Okta — confirmed [0:58] [1:16].

## Commitments
- **Us:** send the revised quote with the price hold in writing tomorrow morning, with the security questionnaire [1:32]
- **Customer:** take the quote to finance on Thursday [1:16]

## Still unknown
- How long finance review takes and who signs off — ask when the quote goes out.
- Where the eighty-seat figure came from, and whether anyone on their side is still working from the old seat estimate.`;
}

function renewalDelivery(lang: Lang): DeliveryAssessment {
  const zh = lang === "zh";
  return {
    tone: "warm",
    toneEvidence: "",
    fillers: { level: "ok", examples: [], note: "" },
    pace: "comfortable",
    summary: zh
      ? "語氣穩定，條件講得清楚；每一次讓步都同時換到了對方的承諾。"
      : "Calm and clear on terms; every concession came with a commitment in return.",
  };
}

// ── The library ───────────────────────────────────────────────────────────
interface Rec {
  id: string;
  zh: string;
  en: string;
  folderId: string | null;
  source: "live" | "upload";
  agoMs: number;
  durationMs: number;
  speakers: number;
  findings: number;
  actions: number;
  snippetZh: string;
  snippetEn: string;
}

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const RECORDINGS: Rec[] = [
  {
    id: "rec-northwind",
    zh: "續約條件討論 — 北風工業",
    en: "Renewal terms — Northwind",
    folderId: "f-renewals",
    source: "live",
    agoMs: 2 * HOUR,
    durationMs: at(24, 36),
    speakers: 2,
    findings: 4,
    actions: 3,
    snippetZh: RENEWAL[0].zh,
    snippetEn: RENEWAL[0].en,
  },
  {
    id: "rec-halcyon",
    zh: "新客戶需求訪談 — 晴光實驗室",
    en: "Discovery call — Halcyon Labs",
    folderId: "f-newbiz",
    source: "live",
    agoMs: DAY + 3 * HOUR,
    durationMs: at(32, 5),
    speakers: 3,
    findings: 5,
    actions: 4,
    snippetZh: "我們客服一天大概三百通電話，一半都在問出貨進度。",
    snippetEn: "Our support line takes about three hundred calls a day, and half of them ask where an order is.",
  },
  {
    id: "rec-sync",
    zh: "每週產品同步",
    en: "Weekly product sync",
    folderId: "f-internal",
    source: "live",
    agoMs: 2 * DAY + 5 * HOUR,
    durationMs: at(28, 40),
    speakers: 4,
    findings: 3,
    actions: 4,
    snippetZh: "這週的重點是把匯出功能收尾，週五前要能進測試。",
    snippetEn: "The main thing this week is finishing export so it can go to QA by Friday.",
  },
  {
    id: "rec-meridian",
    zh: "季度檢討 — 子午線",
    en: "Quarterly review — Meridian",
    folderId: null,
    source: "upload",
    agoMs: 3 * DAY + 2 * HOUR,
    durationMs: at(47, 11),
    speakers: 4,
    findings: 6,
    actions: 5,
    snippetZh: "先從上一季的續約率看起，整體九成一，比目標低兩個點。",
    snippetEn: "Let's start with last quarter's renewal rate — ninety-one percent, two points under target.",
  },
  {
    id: "rec-halcyon-plan",
    zh: "導入規劃 — 晴光實驗室",
    en: "Onboarding plan — Halcyon Labs",
    folderId: "f-newbiz",
    source: "live",
    agoMs: 6 * DAY + 4 * HOUR,
    durationMs: at(21, 30),
    speakers: 2,
    findings: 2,
    actions: 3,
    snippetZh: "第一階段先接客服信箱，電話等下個月再上。",
    snippetEn: "Phase one is the support inbox; the phone line comes on next month.",
  },
];

export function summaries(lang: Lang, now: number): HistoryEntrySummary[] {
  return RECORDINGS.map((r) => ({
    id: r.id,
    title: lang === "zh" ? r.zh : r.en,
    source: r.source,
    createdAt: now - r.agoMs,
    durationMs: r.durationMs,
    speakerCount: r.speakers,
    findingsCount: r.findings,
    actionItemsCount: r.actions,
    hasAudio: true,
    analyzed: true,
    snippet: lang === "zh" ? r.snippetZh : r.snippetEn,
    folderId: r.folderId,
  }));
}

/** Full entry for `read_history_entry`. Only the renewal meeting is ever opened
 *  by a scene; the others get a minimal but valid entry. */
export function entry(id: string, lang: Lang, now: number): HistoryEntry {
  const r = RECORDINGS.find((x) => x.id === id) ?? RECORDINGS[0];
  const base: HistoryEntry = {
    id: r.id,
    title: lang === "zh" ? r.zh : r.en,
    source: r.source,
    createdAt: now - r.agoMs,
    durationMs: r.durationMs,
    segments: [],
    speakerNames: {},
    findings: [],
    actionItems: [],
    analyzed: true,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: null,
    folderId: r.folderId,
    filingSuggestion: null,
    filingSuggested: true,
  };
  if (r.id !== "rec-northwind") return base;
  return {
    ...base,
    segments: renewalSegments(lang),
    findings: renewalFindings(lang),
    actionItems: renewalActions(lang),
    brief: renewalBrief(lang),
    deliveryAssessment: renewalDelivery(lang),
    speechRateHz: 3.3,
    meetingKind: "sales",
  };
}
