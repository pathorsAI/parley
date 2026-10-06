import { afterEach, describe, expect, it, vi } from "vitest";

// renameHistoryEntry is Tauri-gated and writes through IPC; stand both in so the
// store side of a rename can be observed without a webview.
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../tauriEvents", async (orig) => ({
  ...(await orig<typeof import("../tauriEvents")>()),
  isTauri: () => true,
}));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn() }));
vi.mock("../cloud/syncState", () => ({ markDirty: vi.fn() }));
vi.mock("../cloud/client", async (orig) => ({
  ...(await orig<typeof import("../cloud/client")>()),
  syncEnabled: () => false,
}));

import { clearSuggestedTitle, renameHistoryEntry } from "./history";
import { useStore } from "../store";
import type { FilingSuggestion } from "../types";

const folders = [{ folderId: "f-a", name: "Acme", reason: "customer" }];
const pending: FilingSuggestion = { title: "Acme 需求訪談", folders };

afterEach(() => {
  useStore.setState({ filingSuggestion: null, loadedHistoryId: null });
  invoke.mockClear();
});

describe("clearSuggestedTitle (the store twin of history.rs apply_rename)", () => {
  it("keeps the unanswered folders and drops the title", () => {
    expect(clearSuggestedTitle(pending)).toEqual({ title: "", folders });
  });

  it("is null once nothing is left", () => {
    expect(clearSuggestedTitle({ title: "x", folders: [] })).toBeNull();
    expect(clearSuggestedTitle(null)).toBeNull();
  });
});

describe("renameHistoryEntry", () => {
  it("retires the loaded recording's suggested title", async () => {
    useStore.setState({ loadedHistoryId: "rec-1", filingSuggestion: pending });
    await renameHistoryEntry("rec-1", "  Acme kickoff ");
    expect(invoke).toHaveBeenCalledWith("rename_history_entry", { id: "rec-1", title: "Acme kickoff" });
    expect(useStore.getState().filingSuggestion).toEqual({ title: "", folders });
  });

  it("clears a title-only suggestion entirely", async () => {
    useStore.setState({ loadedHistoryId: "rec-1", filingSuggestion: { title: "x", folders: [] } });
    await renameHistoryEntry("rec-1", "y");
    expect(useStore.getState().filingSuggestion).toBeNull();
  });

  it("leaves the on-screen suggestion alone when another recording is renamed", async () => {
    useStore.setState({ loadedHistoryId: "rec-1", filingSuggestion: pending });
    await renameHistoryEntry("rec-2", "other");
    expect(useStore.getState().filingSuggestion).toBe(pending);
  });
});
