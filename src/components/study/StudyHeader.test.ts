import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../../lib/store";
import type { StudyTab } from "../../lib/store/study";
import type { ActionItem, FilingSuggestion, Settings } from "../../lib/types";
import { StudyHeader } from "./StudyHeader";

// A server render reads zustand's INITIAL state object; arrange it there.
const INITIAL = useStore.getInitialState();
const PRISTINE = { ...INITIAL };

function arrange(over: Partial<typeof INITIAL> = {}) {
  Object.assign(INITIAL, {
    settings: { ...PRISTINE.settings, language: "zh-TW" } as Settings,
    filingSuggestion: null,
    loadedHistoryId: "rec-1",
    replayReadOnly: false,
    replayFolderId: null,
    replay: { id: "rec-1", name: "泓昇科技 · 需求訪談" },
    actionItems: [],
    titleAutoApplied: null,
    ...over,
  });
}

const suggestion: FilingSuggestion = {
  title: "",
  folders: [
    { folderId: null, name: "泓昇科技", reason: "對方公司名" },
    { folderId: "f-a", name: "既有 A", reason: "既有資料夾" },
  ],
};

const render = (tab: StudyTab = "summary", notesCount = 0) =>
  renderToStaticMarkup(
    createElement(StudyHeader, { tab, notesCount, pickerOpen: false, onPickerOpenChange: () => {} })
  );

beforeEach(() => arrange());
afterEach(() => {
  Object.assign(INITIAL, PRISTINE);
});

describe("StudyHeader — title", () => {
  it("shows the name as a rename button, with the copy menu", () => {
    const html = render();
    expect(html).toContain('title="點一下可以改標題"');
    expect(html).toContain("泓昇科技 · 需求訪談");
    expect(html).toContain("複製");
    expect(html).not.toContain("自動命名");
  });

  it("tags a name the filing pass gave this recording", () => {
    arrange({ titleAutoApplied: "rec-1" });
    expect(render()).toContain("自動命名");
    // Another recording's flag says nothing about this one.
    arrange({ titleAutoApplied: "rec-2" });
    expect(render()).not.toContain("自動命名");
  });

  it("shows a read-only org recording's name without a rename affordance", () => {
    arrange({ replayReadOnly: true });
    const html = render();
    expect(html).toContain("泓昇科技 · 需求訪談");
    expect(html).not.toContain("點一下可以改標題");
  });
});

describe("StudyHeader — filing row", () => {
  it("offers the suggested folders, the first one emphasized, plus 選其他資料夾… and 先不歸檔", () => {
    arrange({ filingSuggestion: suggestion });
    const html = render();
    expect(html).toContain('id="filing-suggestion"');
    expect(html).toContain("建議放進");
    expect(html).toContain("新增「泓昇科技」");
    expect(html).toContain("既有 A");
    expect(html).toContain("選其他資料夾…");
    expect(html).toContain("先不歸檔");
    // First chip filled, the new-folder chip dashed.
    expect(html).toMatch(/<button[^>]*bg-primary\/10[^>]*border-dashed[^>]*>.*?新增「泓昇科技」/);
    expect(html).not.toContain("還沒歸檔");
  });

  it("says 還沒歸檔 with 放進資料夾 when nothing is suggested", () => {
    const html = render();
    expect(html).toContain("還沒歸檔");
    expect(html).toContain("放進資料夾");
    expect(html).not.toContain('id="filing-suggestion"');
  });

  it("has no filing actions on a read-only org recording", () => {
    arrange({ replayReadOnly: true, filingSuggestion: suggestion });
    const html = render();
    expect(html).not.toContain("建議放進");
    expect(html).not.toContain("放進資料夾");
    expect(html).toContain("還沒歸檔");
  });
});

describe("StudyHeader — tabs", () => {
  const items: ActionItem[] = [
    { id: "a1", text: "Send the quote", done: false, linkedEventId: null, atMs: null },
    { id: "a2", text: "Book the demo", done: true, linkedEventId: null, atMs: null },
  ];

  it("lists the tabs in order, the notes tab only when there are notes", () => {
    const without = render();
    expect(without).toContain('role="tablist"');
    expect(without.match(/role="tab"/g)).toHaveLength(4);
    expect(without).not.toContain(">筆記<");

    const withNotes = render("summary", 3);
    expect(withNotes.match(/role="tab"/g)).toHaveLength(5);
    const order = ["總結", "後續行動", "筆記", "評分", "回放"].map((l) => withNotes.indexOf(l));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("marks the open tab and counts the action items", () => {
    arrange({ actionItems: items });
    const html = render("actions");
    expect(html).toMatch(/aria-selected="true"[^>]*>後續行動<span[^>]*>2<\/span>/);
    // No count badge when there is nothing to count.
    arrange({ actionItems: [] });
    expect(render("actions")).toMatch(/aria-selected="true"[^>]*>後續行動<span class="absolute/);
  });
});
