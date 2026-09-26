import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Radix renders menu content into a portal only once opened, which a server
// render never does — so the menu parts are swapped for inline stand-ins that
// render every item in order.
vi.mock("radix-ui", async (orig) => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    ...(await orig<typeof import("radix-ui")>()),
    DropdownMenu: {
      Root: pass,
      Trigger: pass,
      Portal: pass,
      Content: pass,
      Item: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) =>
        createElement("div", { "data-item": "", "data-disabled": disabled ? "" : undefined }, children),
      Separator: () => createElement("hr"),
    },
  };
});

vi.mock("../lib/onboarding/useHandoff", () => ({
  useHandoff: () => ({
    questions: [],
    mcpQuestions: [],
    canCopy: true,
    copyPrompt: async () => true,
    reportMarkdown: () => "",
  }),
}));

import { TranscriptCopyMenu } from "./TranscriptCopyMenu";

describe("TranscriptCopyMenu", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptCopyMenu, { segments: [], speakerNames: {} })
  );

  it("offers the analysis-prompt copy first, above a hairline and the three formats", () => {
    const items = html.split("data-item").slice(1);
    expect(items).toHaveLength(4);
    expect(items[0]).toContain("附分析提示");
    expect(items[0]).toContain("整段可直接貼到 ChatGPT 或 Claude");
    expect(items[1]).toContain("含講者");
    expect(items[2]).toContain("純文字");
    expect(items[3]).toContain("含講者與時間");
    const hr = html.indexOf("<hr");
    expect(hr).toBeGreaterThan(html.indexOf("附分析提示"));
    expect(hr).toBeLessThan(html.indexOf("每句標上說話者"));
  });

  it("explains the new item the first time the menu opens", () => {
    const explainer = html.indexOf("要給 ChatGPT 或 Claude 分析？選「附分析提示」，貼上就能問。");
    expect(explainer).toBeGreaterThan(-1);
    expect(explainer).toBeLessThan(html.indexOf("data-item"));
  });
});
