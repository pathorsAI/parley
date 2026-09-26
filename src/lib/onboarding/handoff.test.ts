import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";
import type { ActionItem, TimelineEvent } from "../types";
import {
  buildHandoffPrompt,
  buildReportMarkdown,
  findingMarkdownLine,
  resolveMeName,
  speakerDisplayNames,
  type HandoffPromptInput,
} from "./handoff";
import { handoffPromptFromState, reportMarkdownFromState } from "./useHandoff";

const INITIAL = useStore.getState();
beforeEach(() => useStore.setState(INITIAL, true));

function input(patch: Partial<HandoffPromptInput> = {}): HandoffPromptInput {
  return {
    title: "Kickoff",
    dateLabel: "Sep 26, 2026",
    kindLabel: "銷售通話",
    context: "First call",
    speakerNames: ["你", "林經理"],
    meName: "你",
    transcript: "[0:00] [你] 午安\n[0:05] [林經理] 你好",
    questions: ["Q1", "Q2", "Q3"],
    ...patch,
  };
}

describe("buildHandoffPrompt", () => {
  it("renders the zh template: numbered questions, meta, speakers, then the transcript", () => {
    const out = buildHandoffPrompt(input(), "zh-TW");
    expect(out).toBe(
      [
        "你是我的會議分析助理。以下是一場會議的完整逐字稿，請先讀完，再回答：",
        "1. Q1",
        "2. Q2",
        "3. Q3",
        "回答時引用逐字稿原句並標時間。",
        "",
        "會議：Kickoff（Sep 26, 2026，銷售通話）",
        "背景：First call",
        "說話者：你、林經理；「你」是我",
        "",
        "--- 逐字稿 ---",
        "[0:00] [你] 午安",
        "[0:05] [林經理] 你好",
        "",
      ].join("\n")
    );
  });

  it("renders the en template", () => {
    const out = buildHandoffPrompt(
      input({ kindLabel: "Sales call", speakerNames: ["You", "Mr. Lin"], meName: "You" }),
      "en"
    );
    expect(out.startsWith("You're my meeting analyst.")).toBe(true);
    expect(out).toContain("\n1. Q1\n2. Q2\n3. Q3\n");
    expect(out).toContain("Meeting: Kickoff (Sep 26, 2026, Sales call)");
    expect(out).toContain("Speakers: You, Mr. Lin. “You” is me.");
    expect(out).toContain("--- Transcript ---\n[0:00]");
  });

  it("says the context is missing and drops an unknown kind", () => {
    const out = buildHandoffPrompt(input({ context: "  ", kindLabel: "" }), "zh-TW");
    expect(out).toContain("背景：未填");
    expect(out).toContain("會議：Kickoff（Sep 26, 2026）");
  });
});

describe("speaker names", () => {
  const segments = [
    seg({ id: "a", source: "me", speaker: 0, text: "hi", startMs: 0 }),
    seg({ id: "b", source: "them", speaker: 1, text: "hello", startMs: 1000 }),
    seg({ id: "c", source: "me", speaker: 0, text: "again", startMs: 2000 }),
    seg({ id: "d", source: "them", speaker: 2, text: "", startMs: 3000 }),
  ];

  it("lists distinct spoken speakers in order, with custom names", () => {
    expect(speakerDisplayNames(segments, { "them-1": "林經理" })).toEqual(["You", "林經理"]);
  });

  it("resolves me: own name on a speaker > mic speaker > settings name > fallback", () => {
    expect(resolveMeName(segments, { "me-0": "Jack" }, "Jack", "你")).toBe("Jack");
    expect(resolveMeName(segments, { "me-0": "傑克" }, "Jack", "你")).toBe("傑克");
    expect(resolveMeName(segments, {}, "", "你")).toBe("You");
    const mixed = [seg({ source: "mix", speaker: 1, text: "hi" })];
    expect(resolveMeName(mixed, {}, "Jack", "你")).toBe("Jack");
    expect(resolveMeName(mixed, {}, "", "你")).toBe("你");
  });
});

describe("buildReportMarkdown", () => {
  const finding: TimelineEvent = {
    id: "f1",
    atMs: 65_000,
    side: "them",
    severity: "warn",
    source: "extra",
    title: "Price objection",
    detail: "30k vs 18k.",
  };
  const actions: ActionItem[] = [
    { id: "a1", text: "Send the quote", done: false, linkedEventId: null, atMs: 125_000 },
    { id: "a2", text: "Book the demo", done: true, linkedEventId: null, atMs: null },
  ];

  it("writes meta, brief, action items, findings and the footer", () => {
    const md = buildReportMarkdown(
      {
        title: "First call",
        createdAt: Date.UTC(2026, 8, 26, 6, 0),
        meetingKind: "sales",
        meetingContext: "Night calls go unanswered",
        folderName: "泓昇科技",
        brief: "- They need night coverage",
        actionItems: actions,
        findings: [finding],
      },
      "zh-TW"
    );
    expect(md.startsWith("# First call\n")).toBe(true);
    expect(md).toContain("- 日期: ");
    expect(md).toContain("- 會議類型: 銷售通話");
    expect(md).toContain("- 資料夾: 泓昇科技");
    expect(md).toContain("- 會議背景: Night calls go unanswered");
    expect(md).toContain("## 重點\n\n- They need night coverage");
    expect(md).toContain("## 後續行動\n\n- [ ] Send the quote [2:05]\n- [x] Book the demo");
    expect(md).toContain("## 關鍵時刻\n\n- [1:05] **Price objection** (them, warn): 30k vs 18k.");
    expect(md.trimEnd().endsWith("_由 Parley 產生_")).toBe(true);
    expect(md).not.toMatch(/https?:\/\//);
  });

  it("skips empty sections and uses English labels", () => {
    const md = buildReportMarkdown(
      { title: "Sync", createdAt: 0, actionItems: [], findings: [] },
      "en"
    );
    expect(md).not.toContain("## ");
    expect(md).not.toContain("Folder");
    expect(md).toContain("- Date: ");
    expect(md.trimEnd().endsWith("_Generated by Parley_")).toBe(true);
  });

  it("formats a finding like the live meeting's markdown copy", () => {
    expect(findingMarkdownLine({ ...finding, side: undefined, category: "decision", severity: "info" })).toBe(
      "- [1:05] **Price objection** (decision, info): 30k vs 18k."
    );
  });
});

describe("store-fed builders", () => {
  it("builds the prompt from the loaded session, with sample questions for the sample", () => {
    const segments = [
      seg({ id: "a", source: "me", speaker: 0, text: "林經理午安", startMs: 0 }),
      seg({ id: "b", source: "them", speaker: 1, text: "午安", startMs: 3000 }),
    ];
    useStore.setState({
      replay: replaySession(segments, { id: "sample-hongsheng-zh-TW-v1", name: "範例通話" }),
      segments,
      speakerNames: { "me-0": "你", "them-1": "林經理" },
      meetingKind: "sales",
      meetingContext: "泓昇科技",
    });
    const out = handoffPromptFromState(useStore.getState(), "zh-TW");
    expect(out).toContain("1. 林經理對價格的疑慮是什麼？");
    expect(out).toContain("會議：範例通話（");
    expect(out).toContain("，銷售通話）");
    expect(out).toContain("背景：泓昇科技");
    expect(out).toContain("說話者：你、林經理；「你」是我");
    expect(out).toContain("[0:00] [你] 林經理午安\n[0:03] [林經理] 午安");
  });

  it("builds the report from the loaded session", () => {
    useStore.setState({
      replay: replaySession([], { name: "Weekly sync" }),
      brief: "- shipped",
      settings: { ...INITIAL.settings, language: "en" },
    });
    const md = reportMarkdownFromState(useStore.getState());
    expect(md).toContain("# Weekly sync");
    expect(md).toContain("## Brief\n\n- shipped");
  });
});
