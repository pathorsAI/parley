import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { McpActivityInfo } from "../../lib/mcp/activity";
import type { HandoffState } from "../../lib/onboarding/useHandoff";

// The section's two data sources are mocked: SSR can't poll the MCP server, and
// zustand renders its initial state on the server, so the session is faked too.
const activity = vi.hoisted(() => ({ info: null as McpActivityInfo | null }));
const handoff = vi.hoisted(() => ({ canCopy: true }));

vi.mock("../../lib/mcp/activity", async (orig) => ({
  ...(await orig<typeof import("../../lib/mcp/activity")>()),
  useMcpActivity: () => ({ info: activity.info, now: Date.now() }),
}));

vi.mock("../../lib/onboarding/useHandoff", () => ({
  useHandoff: (): HandoffState => ({
    questions: ["Q-copy-1", "Q-copy-2", "Q-copy-3"],
    mcpQuestions: ["Q-mcp-1", "Q-mcp-2", "Q-mcp-3"],
    canCopy: handoff.canCopy,
    copyPrompt: async () => true,
    reportMarkdown: () => "# report",
  }),
}));

import { HandoffSection } from "./HandoffSection";

const render = () => renderToStaticMarkup(createElement(HandoffSection));

beforeEach(() => {
  activity.info = null;
  handoff.canCopy = true;
});

describe("HandoffSection", () => {
  it("renders the MCP half (command, config link, questions) before the copy half", () => {
    const html = render();
    const mcp = html.indexOf('data-handoff="mcp"');
    const copy = html.indexOf('data-handoff="copy"');
    expect(mcp).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(mcp);
    expect(html).toContain("讓 Claude Code 直接讀你的錄音資料庫，不用複製貼上。");
    expect(html).toContain("claude mcp add --transport http parley http://127.0.0.1:3011/mcp");
    expect(html).toContain("Claude Desktop 用這段設定");
    expect(html).toContain("試試這樣問");
    for (const q of ["Q-mcp-1", "Q-mcp-2", "Q-mcp-3"]) expect(html.indexOf(q)).toBeLessThan(copy);
    expect(html).toContain("複製逐字稿（附分析提示）");
    expect(html).toContain("複製這份報告");
    for (const q of ["Q-copy-1", "Q-copy-2", "Q-copy-3"]) expect(html.indexOf(q)).toBeGreaterThan(copy);
  });

  it("waits for a connection until a client has introduced itself", () => {
    const html = render();
    expect(html).toContain('data-mcp-status="waiting"');
    expect(html).toContain("等待連線… Parley 要保持開啟");
  });

  it("names the connected client", () => {
    activity.info = { client: { name: "claude-code", version: "2.1" }, lastRequestAt: Date.now(), recent: [] };
    const html = render();
    expect(html).toContain('data-mcp-status="connected"');
    expect(html).toContain("已連線：claude-code v2.1");
  });

  it("disables both copy buttons when there is nothing it may copy", () => {
    handoff.canCopy = false;
    const html = render();
    const copyHalf = html.slice(html.indexOf('data-handoff="copy"'));
    expect(copyHalf.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    // The MCP half stays usable.
    const mcpHalf = html.slice(0, html.indexOf('data-handoff="copy"'));
    expect(mcpHalf).not.toContain('disabled=""');
  });
});
