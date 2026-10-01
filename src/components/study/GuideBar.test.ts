import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { McpActivityInfo } from "../../lib/mcp/activity";
import type { HandoffState } from "../../lib/onboarding/useHandoff";

// Boundaries: the logger, starting a meeting (Tauri), the MCP poll (SSR can't
// poll) and the loaded session's hand-off data (zustand renders its initial
// state on the server). The bar's markup per step is what's under test.
vi.mock("../../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../../lib/meeting/start", () => ({ beginMeeting: vi.fn() }));

const activity = vi.hoisted(() => ({ info: null as McpActivityInfo | null }));
vi.mock("../../lib/mcp/activity", async (orig) => ({
  ...(await orig<typeof import("../../lib/mcp/activity")>()),
  useMcpActivity: () => ({ info: activity.info, now: Date.now() }),
}));
vi.mock("../../lib/onboarding/useHandoff", () => ({
  copyHandoffPrompt: vi.fn(async () => true),
  useHandoff: (): HandoffState => ({
    questions: ["Q-copy-1", "Q-copy-2", "Q-copy-3"],
    mcpQuestions: ["Q-mcp-1", "Q-mcp-2", "Q-mcp-3"],
    canCopy: true,
    copyPrompt: async () => true,
    reportMarkdown: () => "# report",
  }),
}));

import { useStore } from "../../lib/store";
import type { Settings } from "../../lib/types";
import { GuideBarView, type GuideBarViewProps } from "./GuideBar";

// A server render reads zustand's INITIAL state object; arrange the language there.
const INITIAL = useStore.getInitialState();
const PRISTINE = INITIAL.settings;
function language(lang: Settings["language"]) {
  (INITIAL as { settings: Settings }).settings = { ...PRISTINE, language: lang };
}

const noop = () => {};
function render(over: Partial<GuideBarViewProps>): string {
  return renderToStaticMarkup(
    createElement(GuideBarView, {
      phase: "filed",
      justCompleted: null,
      tab: "report",
      folderName: null,
      renamed: false,
      onShowSuggestion: noop,
      onOpenReplay: noop,
      onShowHandoff: noop,
      onDismiss: noop,
      onClose: noop,
      onBegin: noop,
      ...over,
    }),
  );
}

/** Filled (primary) buttons: the shadcn default variant carries bg-primary. */
const primaryButtons = (html: string) => html.match(/<button[^>]*bg-primary[^>]*>/g) ?? [];

beforeEach(() => {
  language("zh-TW");
  activity.info = null;
});
afterEach(() => {
  (INITIAL as { settings: Settings }).settings = PRISTINE;
});

describe("GuideBarView", () => {
  it("step 1: what Parley did, one CTA to the suggestion, and a way out", () => {
    const html = render({ phase: "filed" });
    expect(html).toContain('data-lap="filed"');
    expect(html).toContain("1 / 3 · 先看 Parley 幫你做了什麼");
    expect(html).toContain("按「採用建議」或任一個資料夾試試");
    expect(html).toContain("看建議");
    expect(html).toContain("不用了");
    expect(primaryButtons(html)).toHaveLength(1);
  });

  it("confirms step 1 with the folder, naming the rename only when there was one", () => {
    const both = render({ phase: "replayed", justCompleted: "filed", folderName: "泓昇科技", renamed: true });
    expect(both).toContain('data-lap="filed-done"');
    expect(both).toContain("已改名，放進「泓昇科技」。之後每一場錄完都會這樣。");
    expect(both).not.toContain("2 / 3");

    const filed = render({ phase: "replayed", justCompleted: "filed", folderName: "A" });
    expect(filed).toContain("已放進「A」。");
    expect(filed).not.toContain("已改名");
  });

  it("step 2: replay, with the CTA only when not already on the Replay tab", () => {
    const report = render({ phase: "replayed", tab: "report" });
    expect(report).toContain("2 / 3 · 回放");
    expect(report).toContain("點任一句，音訊會跳到那個時間。試試看。");
    expect(report).toContain("開回放");

    const replay = render({ phase: "replayed", tab: "replay" });
    expect(replay).toContain("2 / 3 · 回放");
    expect(replay).not.toContain("開回放");
    expect(primaryButtons(replay)).toHaveLength(0);
  });

  it("confirms step 2 with the search shortcut", () => {
    const html = render({ phase: "handedOff", justCompleted: "replayed" });
    expect(html).toMatch(/就是這樣。(⌘F|Ctrl\+F) 可以搜逐字稿。/);
  });

  it("step 3 on Replay is compact: label, one line, and the way to the full form", () => {
    const html = render({ phase: "handedOff", tab: "replay" });
    expect(html).toContain("3 / 3 · 交給你的 AI");
    expect(html).toContain("讓 Claude Code 直接讀你的錄音資料庫，不用複製貼上。");
    expect(html).toContain("看完整說明");
    expect(html).not.toContain("claude mcp add");
    expect(html).not.toContain("Q-mcp-1");
    expect(html).not.toContain("先複製給 ChatGPT");
  });

  it("step 3 on Report: the command, live status, the questions and the copy fallback", () => {
    const html = render({ phase: "handedOff" });
    expect(html).toContain("3 / 3 · 交給你的 AI");
    expect(html).toContain("讓 Claude Code 直接讀你的錄音資料庫，不用複製貼上。");
    expect(html).toContain("claude mcp add --transport http parley http://127.0.0.1:3011/mcp");
    expect(html).toContain('data-mcp-status="waiting"');
    expect(html).toContain("等待連線…");
    for (const q of ["Q-mcp-1", "Q-mcp-2", "Q-mcp-3"]) expect(html).toContain(q);
    expect(html).toContain("沒有 Claude Code？先複製給 ChatGPT");
    expect(html).toContain("看完整說明");
    expect(primaryButtons(html)).toHaveLength(1);

    activity.info = { client: { name: "claude-code", version: "2.1" }, lastRequestAt: Date.now(), recent: [] };
    expect(render({ phase: "handedOff" })).toContain("已連線：claude-code v2.1");
  });

  it("done: the whole lap in one line, start a real meeting, or close", () => {
    const html = render({ phase: "done" });
    expect(html).toContain('data-lap="done"');
    expect(html).toContain("完成");
    expect(html).toContain("錄 → 自動命名與歸檔 → 回放 → 交給 AI");
    // The three ✓ lines cascade in, 260 ms apart.
    for (const [i, line] of ["自動命名、歸進資料夾", "回放，點一句跳過去", "交給你的 AI"].entries()) {
      expect(html).toMatch(new RegExp(`animation-delay:${i * 260}ms[^>]*>.*?${line}`));
    }
    expect(html).toContain("開始第一場真的會議");
    expect(html).toContain("關閉");
    expect(html).not.toContain("不用了");
    expect(primaryButtons(html)).toHaveLength(1);
  });

  it("speaks English", () => {
    language("en");
    expect(render({ phase: "filed" })).toContain("1 / 3 · See what Parley did for you");
    expect(render({ phase: "done" })).toContain("Start your first real meeting");
  });

  it("is a bar, not a card: a hairline on top and no rounded box", () => {
    const html = render({ phase: "filed" });
    const section = html.match(/<section[^>]*>/)![0];
    expect(section).toContain("border-t");
    expect(section).not.toMatch(/rounded|shadow/);
  });
});
