import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../../lib/store";
import type { FilingSuggestion, Settings } from "../../lib/types";
import { FilingSuggestionCard } from "./FilingSuggestionCard";

// A server render reads zustand's INITIAL state object; arrange it there.
const INITIAL = useStore.getInitialState();
const PRISTINE = { ...INITIAL };

function arrange(suggestion: FilingSuggestion | null, over: Partial<typeof INITIAL> = {}) {
  Object.assign(INITIAL, {
    settings: { ...PRISTINE.settings, language: "zh-TW" } as Settings,
    filingSuggestion: suggestion,
    loadedHistoryId: "rec-1",
    replayReadOnly: false,
    replayFolderId: null,
    replay: { id: "rec-1", name: "即時會議 · 9/27" },
    ...over,
  });
}

const suggestion: FilingSuggestion = {
  title: "泓昇科技 · 需求訪談",
  folders: [
    { folderId: null, name: "泓昇科技", reason: "對方公司名" },
    { folderId: "f-a", name: "既有 A", reason: "既有資料夾" },
  ],
};

const render = (withPicker = true) =>
  renderToStaticMarkup(createElement(FilingSuggestionCard, withPicker ? { onPickAnother: () => {} } : {}));

beforeEach(() => arrange(suggestion));
afterEach(() => {
  Object.assign(INITIAL, PRISTINE);
});

describe("FilingSuggestionCard", () => {
  it("offers the whole suggestion as one 採用建議, the editable title, the folders and 選其他資料夾…", () => {
    const html = render();
    expect(html).toContain('id="filing-suggestion"');
    expect(html.match(/採用建議/g)).toHaveLength(1);
    // 採用建議 sits in the header, before the title row — it accepts both halves.
    expect(html.indexOf("採用建議")).toBeLessThan(html.indexOf("泓昇科技 · 需求訪談"));
    expect(html).toContain('aria-label="點一下可以改標題"');
    expect(html).toContain("新增「泓昇科技」");
    expect(html).toContain("既有 A");
    expect(html).toContain("選其他資料夾…");
  });

  it("drops the title row once the recording already carries the name", () => {
    arrange(suggestion, { replay: { id: "rec-1", name: "泓昇科技 · 需求訪談" } } as never);
    const html = render();
    expect(html).not.toContain("點一下可以改標題");
    expect(html).toContain("新增「泓昇科技」");
  });

  it("shows nothing on a read-only org copy", () => {
    arrange(suggestion, { replayReadOnly: true });
    expect(render()).toBe("");
  });

  it("has no 'Choose another…' without a picker to open", () => {
    expect(render(false)).not.toContain("選其他資料夾…");
  });
});
