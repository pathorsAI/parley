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
  });
}

afterEach(() => {
  suggestFiling.mockReset();
  landStage.mockClear();
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
  });
});
