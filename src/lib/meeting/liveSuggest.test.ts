import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import {
  buildRequest,
  CARD_TTL_MS,
  cardExpired,
  finalTurns,
  LULL_MS,
  MIN_REQUEST_GAP_MS,
  nextTrigger,
  parseSuggestions,
  speechPending,
  stillCurrent,
  TURN_SETTLE_MS,
  type ShownCard,
  type Turn,
  type TriggerFacts,
} from "./liveSuggest";
import { emptyPlaybook } from "./playbook";
import { containment } from "./suggestMatch";

const turn = (who: "me" | "them", text: string, endMs: number): Turn => ({ who, text, endMs });

function facts(over: Partial<TriggerFacts>): TriggerFacts {
  return {
    nowMs: 60_000,
    turns: [turn("me", "你好", 50_000), turn("them", "我們晚上有三成電話沒人接", 58_000)],
    pending: false,
    inFlight: false,
    lastRequestAtMs: null,
    lastTurnEndMs: 0,
    lastLullEndMs: 0,
    ...over,
  };
}

describe("nextTrigger", () => {
  it("asks once the other side's line has settled", () => {
    expect(nextTrigger(facts({ nowMs: 58_000 + TURN_SETTLE_MS - 1 }))).toBeNull();
    expect(nextTrigger(facts({ nowMs: 58_000 + TURN_SETTLE_MS }))).toBe("turn");
  });

  it("asks once per line", () => {
    expect(nextTrigger(facts({ lastTurnEndMs: 58_000 }))).toBeNull();
  });

  it("does not answer the user's own line", () => {
    const turns = [turn("them", "嗯", 50_000), turn("me", "我們的方案是…", 58_000)];
    expect(nextTrigger(facts({ turns }))).toBeNull();
  });

  it("waits while someone is mid-sentence, a request is out, or the last one was recent", () => {
    expect(nextTrigger(facts({ pending: true }))).toBeNull();
    expect(nextTrigger(facts({ inFlight: true }))).toBeNull();
    expect(nextTrigger(facts({ lastRequestAtMs: 60_000 - MIN_REQUEST_GAP_MS + 1 }))).toBeNull();
    expect(nextTrigger(facts({ lastRequestAtMs: 60_000 - MIN_REQUEST_GAP_MS }))).toBe("turn");
  });

  it("calls a long silence a lull, once", () => {
    const nowMs = 58_000 + LULL_MS;
    expect(nextTrigger(facts({ nowMs, lastTurnEndMs: 58_000 }))).toBe("lull");
    expect(nextTrigger(facts({ nowMs, lastTurnEndMs: 58_000, lastLullEndMs: 58_000 }))).toBeNull();
  });

  it("a turn not yet asked about past the lull mark is a lull, not a stale turn", () => {
    expect(nextTrigger(facts({ nowMs: 58_000 + LULL_MS }))).toBe("lull");
  });

  it("needs a conversation before it can lull", () => {
    expect(nextTrigger(facts({ nowMs: 100_000, turns: [turn("them", "喂？", 50_000)] }))).toBeNull();
    expect(nextTrigger(facts({ turns: [] }))).toBeNull();
  });
});

describe("stillCurrent", () => {
  const sent = [turn("them", "預算用完了", 10_000)];
  it("drops a turn answer once the other side has said more", () => {
    expect(stillCurrent("turn", sent, sent)).toBe(true);
    expect(stillCurrent("turn", sent, [...sent, turn("me", "了解", 12_000)])).toBe(true);
    expect(stillCurrent("turn", sent, [...sent, turn("them", "而且老闆不在", 12_000)])).toBe(false);
  });
  it("drops a lull answer once anyone speaks", () => {
    expect(stillCurrent("lull", sent, [...sent, turn("me", "那我們…", 20_000)])).toBe(false);
  });
});

describe("cardExpired", () => {
  const line: ShownCard = {
    mode: "turn",
    items: [{ key: "q:1", kind: "question", text: "晚上沒接到的電話一個月大概多少通？", source: null, confidence: 0.8 }],
    atMs: 10_000,
    finalsAtShow: 2,
  };
  const before = [turn("me", "a", 1), turn("them", "b", 2)];

  it("goes after its time on screen", () => {
    expect(cardExpired(line, 10_000 + CARD_TTL_MS - 1, before)).toBe(false);
    expect(cardExpired(line, 10_000 + CARD_TTL_MS, before)).toBe(true);
  });

  it("goes once the conversation has moved two lines on", () => {
    expect(cardExpired(line, 12_000, [...before, turn("them", "c", 11_000)])).toBe(false);
    expect(cardExpired(line, 12_000, [...before, turn("them", "c", 11_000), turn("them", "d", 11_500)])).toBe(true);
  });

  it("goes once the user has said it, in their own words", () => {
    const said = turn("me", "對，想請問一下，晚上沒接到的電話，一個月大概有多少通？", 11_000);
    expect(cardExpired(line, 12_000, [...before, said])).toBe(true);
    expect(cardExpired(line, 12_000, [...before, turn("me", "好的我了解", 11_000)])).toBe(false);
  });

  it("puts lull directions away when anyone speaks", () => {
    expect(cardExpired({ ...line, mode: "lull" }, 12_000, [...before, turn("me", "好", 11_000)])).toBe(true);
  });
});

describe("transcript facts", () => {
  const seg = (p: Partial<TranscriptSegment>): TranscriptSegment => ({
    id: crypto.randomUUID(),
    source: "them",
    speaker: 0,
    text: "x",
    isFinal: true,
    startMs: 0,
    endMs: 0,
    ...p,
  });

  it("keeps final non-empty lines in time order, a mixed stream counting as the other side", () => {
    const turns = finalTurns([
      seg({ source: "mix", text: "後", endMs: 3 }),
      seg({ source: "me", text: "先", endMs: 1 }),
      seg({ text: "  ", endMs: 2 }),
      seg({ text: "未完", isFinal: false, endMs: 4 }),
    ]);
    expect(turns).toEqual([turn("me", "先", 1), turn("them", "後", 3)]);
  });

  it("sees speech still being transcribed", () => {
    expect(speechPending([seg({ isFinal: false, text: "我想" })])).toBe(true);
    expect(speechPending([seg({ isFinal: false, text: " " }), seg({})])).toBe(false);
  });
});

describe("buildRequest / parseSuggestions", () => {
  it("sends the tail, the open agenda and recent suggestions", () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? "them" : "me", `line ${i}`, i * 1000));
    const req = buildRequest({
      mode: "turn",
      language: "zh-TW",
      context: "c".repeat(7000),
      agenda: [
        { text: "預算", done: false },
        { text: "時程", done: true },
      ],
      playbook: emptyPlaybook(),
      turns,
      shown: [{ key: "q:1", kind: "question", text: "t", source: null, confidence: 1, mode: "turn", atMs: 5 }],
      nowMs: 20_000.4,
    });
    expect(req.transcript).toHaveLength(16);
    expect(req.transcript[0].text).toBe("line 4");
    expect(req.agenda).toEqual(["預算"]);
    expect(req.context).toHaveLength(6000);
    expect(req.shown).toEqual([{ key: "q:1", text: "t", atMs: 5 }]);
    expect(req.nowMs).toBe(20_000);
  });

  it("keeps well-formed suggestions, one for a turn and three for a lull", () => {
    const body = {
      suggestions: [
        { key: "t:1", kind: "topic", text: " 訂房系統 ", source: null, confidence: 0.4 },
        { key: "t:2", kind: "topic", text: "夜班", confidence: 0.3 },
        { key: "x", kind: "weird", text: "drop" },
        { key: "t:3", kind: "topic", text: "" },
        { key: "t:4", kind: "topic", text: "經驗", source: "  " },
        { key: "t:5", kind: "topic", text: "第四個" },
      ],
    };
    expect(parseSuggestions("lull", body).map((s) => s.text)).toEqual(["訂房系統", "夜班", "經驗"]);
    expect(parseSuggestions("turn", body)).toHaveLength(1);
    expect(parseSuggestions("turn", { suggestions: [], abstained: "none" })).toEqual([]);
    expect(parseSuggestions("turn", null)).toEqual([]);
  });
});

describe("containment", () => {
  it("is high for a paraphrase inside a longer line and low for something else", () => {
    expect(containment("預算可以先從小規模 POC 開始", "那預算的話我們可以先從小規模的 POC 開始做")).toBeGreaterThan(0.6);
    expect(containment("預算可以先從小規模 POC 開始", "今天天氣不錯")).toBeLessThan(0.1);
    expect(containment("What does your night shift look like?", "so what does your night shift look like")).toBe(1);
    expect(containment("", "anything")).toBe(0);
  });
});
