import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { suggestFiling, landStage } = vi.hoisted(() => ({
  suggestFiling: vi.fn(),
  landStage: vi.fn(async (run: { end(): void }, opts: { apply: () => void; patch: unknown }) => {
    opts.apply();
    run.end();
  }),
}));
vi.mock("../ai/filing", () => ({ suggestFiling }));
// The rename path a user rename takes; the real one clears the suggestion's
// title in the store, which the fake mirrors.
const { renameHistoryEntry, readEntry } = vi.hoisted(() => ({
  renameHistoryEntry: vi.fn(async (_id: string, _title: string) => {}),
  readEntry: vi.fn(async (_id: string) => ({ meta: { title: "" } })),
}));
vi.mock("../history/history", () => ({ renameHistoryEntry }));
vi.mock("../history/entryStore", () => ({ readEntry }));
vi.mock("../ai/settings", () => ({ hasProviderKey: () => true }));
vi.mock("../history/folders", () => ({ filingChoices: (f: unknown[]) => f, listLocalFolders: () => [] }));
vi.mock("./runGuard", async (orig) => ({
  ...(await orig<typeof import("./runGuard")>()),
  landStage,
}));

import { runFilingSuggestion } from "./filingRun";
import { useStore } from "../store";
import { replaySession, seg } from "../test/fixtures";

function arrange(id: string) {
  useStore.setState({
    appMode: "study",
    replay: replaySession([seg({ text: "hi" })], { id }),
    segments: [seg({ text: "hi" })],
    loadedHistoryId: id,
    replayReadOnly: false,
    replayTrim: null,
    filingStatus: "idle",
    filingSuggestion: null,
    titleAutoApplied: null,
  });
}

afterEach(() => {
  suggestFiling.mockReset();
  landStage.mockClear();
  renameHistoryEntry.mockClear();
  readEntry.mockClear();
});

describe("runFilingSuggestion — what gets persisted", () => {
  it("persists a usable suggestion with filingSuggested", async () => {
    arrange("rec-a");
    const s = { title: "Acme", folders: [] };
    suggestFiling.mockResolvedValue(s);
    await runFilingSuggestion();
    expect(landStage.mock.calls[0][1].patch).toEqual({ filingSuggestion: s, filingSuggested: true });
    expect(useStore.getState().filingSuggestion).toEqual(s);
  });

  it("persists NOTHING for an empty pass, marking it done for this session only", async () => {
    arrange("rec-b");
    suggestFiling.mockResolvedValue(null);
    await runFilingSuggestion();
    // No patch → no meta write, no cloud push: another device can still try.
    expect(landStage.mock.calls[0][1].patch).toBeNull();
    expect(useStore.getState().filingStatus).toBe("done");

    // Reopened in the same session (status restores "idle"): no second spend.
    useStore.setState({ filingStatus: "idle" });
    await runFilingSuggestion();
    expect(suggestFiling).toHaveBeenCalledTimes(1);
    expect(useStore.getState().filingStatus).toBe("done");
  });

  it("drops the title when the recording was renamed mid-pass, keeping folders", async () => {
    arrange("rec-c");
    const folders = [{ folderId: "f", name: "F", reason: "" }];
    suggestFiling.mockImplementation(async () => {
      useStore.setState({ replay: { ...useStore.getState().replay!, name: "renamed" } });
      return { title: "Acme", folders };
    });
    await runFilingSuggestion();
    expect(useStore.getState().filingSuggestion).toEqual({ title: "", folders });
    // The user's name stands: nothing is renamed, nothing flagged as auto-named.
    expect(renameHistoryEntry).not.toHaveBeenCalled();
    expect(useStore.getState().titleAutoApplied).toBeNull();
  });
});

describe("runFilingSuggestion — the title is applied, not suggested", () => {
  it("renames the recording through the rename path and flags it as auto-named", async () => {
    arrange("rec-d");
    suggestFiling.mockResolvedValue({ title: "  Acme 需求訪談 ", folders: [] });
    await runFilingSuggestion();
    expect(renameHistoryEntry).toHaveBeenCalledWith("rec-d", "Acme 需求訪談");
    // The suggestion lands (and persists) BEFORE the rename, whose write then
    // clears its title — so the rename's write is the last one.
    expect(landStage.mock.invocationCallOrder[0]).toBeLessThan(renameHistoryEntry.mock.invocationCallOrder[0]);
    expect(useStore.getState().replay?.name).toBe("Acme 需求訪談");
    expect(useStore.getState().titleAutoApplied).toBe("rec-d");
  });

  it("leaves a folders-only suggestion's recording named as it was", async () => {
    arrange("rec-e");
    suggestFiling.mockResolvedValue({ title: "", folders: [{ folderId: "f", name: "F", reason: "" }] });
    await runFilingSuggestion();
    expect(renameHistoryEntry).not.toHaveBeenCalled();
    expect(useStore.getState().titleAutoApplied).toBeNull();
  });

  it("never renames a read-only org recording", async () => {
    arrange("rec-f");
    useStore.setState({ replayReadOnly: true });
    suggestFiling.mockResolvedValue({ title: "Acme", folders: [] });
    await runFilingSuggestion();
    expect(suggestFiling).not.toHaveBeenCalled();
    expect(renameHistoryEntry).not.toHaveBeenCalled();
  });
});
