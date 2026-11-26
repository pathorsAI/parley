import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { suggestFiling, keys } = vi.hoisted(() => ({
  suggestFiling: vi.fn(),
  keys: { realtime: true },
}));
vi.mock("../ai/filing", () => ({ suggestFiling }));
vi.mock("../ai/settings", () => ({ hasProviderKey: (_s: unknown, lane: "realtime") => keys[lane] }));
vi.mock("../history/folders", () => ({ filingChoices: (f: unknown[]) => f, listLocalFolders: () => [] }));

// The saved entries on "disk", and the writes the pass makes to them.
const { disk, renameHistoryEntry, persistStageOutputs } = vi.hoisted(() => {
  const disk = new Map<string, Record<string, unknown>>();
  return {
    disk,
    renameHistoryEntry: vi.fn(async (id: string, title: string) => {
      const meta = disk.get(id);
      if (meta) disk.set(id, { ...meta, title });
    }),
    persistStageOutputs: vi.fn(async (target: { entryId: string | null }, patch: Record<string, unknown>) => {
      const meta = target.entryId ? disk.get(target.entryId) : undefined;
      if (meta && target.entryId) disk.set(target.entryId, { ...meta, ...patch });
    }),
  };
});
vi.mock("../history/history", () => ({ renameHistoryEntry, persistStageOutputs }));
vi.mock("../history/entryStore", () => ({
  readEntry: vi.fn(async (id: string) => {
    const meta = disk.get(id);
    if (!meta) throw new Error(`no entry ${id}`);
    return { meta: structuredClone(meta), audioPath: null };
  }),
  entryWritesSettled: async () => {},
  listHistory: async () =>
    [...disk.values()]
      .map((m) => ({ id: m.id as string, createdAt: m.createdAt as number }))
      .sort((a, b) => b.createdAt - a.createdAt),
}));

import { runFilingForEntry, runFilingSuggestion, backgroundFilingInFlight } from "./filingRun";
import {
  CATCH_UP_WINDOW_MS,
  backgroundFilingSettled,
  catchUpBackgroundFiling,
  needsCatchUp,
  queueBackgroundFiling,
} from "./filingQueue";
import { inFlightStagesFor } from "./runRegistry";
import { useStore } from "../store";
import { replaySession, seg } from "../test/fixtures";
import type { HistoryEntry } from "../history/types";

const NOW = 1_800_000_000_000;
const DEFAULT_TITLE = "即時會議 · 2026/11/25 下午4:01:02";
const INITIAL = useStore.getState();

function entry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    title: DEFAULT_TITLE,
    source: "live",
    createdAt: NOW - 60_000,
    durationMs: 60_000,
    segments: [seg({ text: "let's talk pricing" })],
    speakerNames: {},
    findings: [],
    actionItems: [],
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: "audio.ogg",
    ...over,
  };
}

function save(e: HistoryEntry): void {
  disk.set(e.id, e as unknown as Record<string, unknown>);
}

/** A suggestFiling call the test resolves by hand. */
function deferredSuggestion() {
  let resolve!: (v: unknown) => void;
  suggestFiling.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  return (v: unknown) => resolve(v);
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useStore.setState({ settings: { ...INITIAL.settings, autoStudyAnalysis: true } });
  keys.realtime = true;
});

afterEach(async () => {
  await backgroundFilingSettled();
  suggestFiling.mockReset();
  renameHistoryEntry.mockClear();
  persistStageOutputs.mockClear();
  disk.clear();
});

describe("runFilingForEntry — an unopened saved entry", () => {
  it("names it and persists the suggestion with filingSuggested", async () => {
    save(entry("m1"));
    const s = { title: "Acme pricing call", folders: [{ id: "f1", name: "Acme" }] };
    suggestFiling.mockResolvedValue(s);

    expect(await runFilingForEntry("m1")).toBe(true);

    expect(suggestFiling.mock.calls[0][0]).toMatchObject({ currentTitle: DEFAULT_TITLE, meetingContext: "" });
    expect(persistStageOutputs).toHaveBeenCalledWith(
      { entryId: "m1", readOnlyId: null },
      { filingSuggestion: s, filingSuggested: true },
      { push: true },
    );
    expect(renameHistoryEntry).toHaveBeenCalledWith("m1", "Acme pricing call");
    expect(useStore.getState().titleAutoApplied).toBe("m1");
    // Not on screen: the store's own filing state is untouched.
    expect(useStore.getState().filingSuggestion).toBeNull();
  });

  it("gives a recovered recording its folders only", async () => {
    save(entry("m2", { recovered: true, title: `${DEFAULT_TITLE}（已復原）` }));
    suggestFiling.mockResolvedValue({ title: "Acme", folders: [{ id: "f1", name: "Acme" }] });
    await runFilingForEntry("m2");
    expect(persistStageOutputs.mock.calls[0][1]).toEqual({
      filingSuggestion: { title: "", folders: [{ id: "f1", name: "Acme" }] },
      filingSuggested: true,
    });
    expect(renameHistoryEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["already answered", entry("m3", { filingSuggested: true })],
    ["a suggestion still pending", entry("m3", { filingSuggestion: { title: "", folders: [] } })],
    ["no speech", entry("m3", { segments: [seg({ text: "   " })] })],
  ])("skips an entry with %s", async (_why, e) => {
    save(e);
    expect(await runFilingForEntry("m3")).toBe(false);
    expect(suggestFiling).not.toHaveBeenCalled();
  });

  it("skips without a realtime key", async () => {
    save(entry("m4"));
    keys.realtime = false;
    expect(await runFilingForEntry("m4")).toBe(false);
    expect(suggestFiling).not.toHaveBeenCalled();
  });

  it("skips a recording that is on screen read-only", async () => {
    save(entry("m5"));
    useStore.setState({ replay: replaySession([seg()], { id: "m5" }), replayReadOnly: true, loadedHistoryId: null });
    expect(await runFilingForEntry("m5")).toBe(false);
    expect(suggestFiling).not.toHaveBeenCalled();
  });

  it("skips when auto-analysis is off (the recording is left for MCP)", async () => {
    save(entry("m6"));
    useStore.setState({ settings: { ...useStore.getState().settings, autoStudyAnalysis: false } });
    expect(await runFilingForEntry("m6")).toBe(false);
  });

  it("lets a rename made during the pass win", async () => {
    save(entry("m7"));
    const resolve = deferredSuggestion();
    const pass = runFilingForEntry("m7");
    await vi.waitFor(() => expect(suggestFiling).toHaveBeenCalled());
    // The user renames it from the library while the model is still answering.
    save({ ...entry("m7"), title: "My own name" });
    resolve({ title: "Acme", folders: [] });
    await pass;
    expect(renameHistoryEntry).not.toHaveBeenCalled();
    expect(disk.get("m7")?.title).toBe("My own name");
    expect(disk.get("m7")?.filingSuggested).toBe(true);
  });
});

describe("background pass vs. the recording being opened", () => {
  it("restores as running, the on-screen pass declines, and the landing fills the store", async () => {
    save(entry("m8"));
    const resolve = deferredSuggestion();
    const pass = runFilingForEntry("m8");
    await vi.waitFor(() => expect(suggestFiling).toHaveBeenCalledTimes(1));
    expect(backgroundFilingInFlight("m8")).toBe(true);
    // loadHistory reads this to restore filing as "running".
    expect(inFlightStagesFor("m8").has("filing")).toBe(true);

    // The user opens it mid-pass; the pipeline's runner must not pay twice.
    useStore.setState({
      appMode: "study",
      replay: replaySession([seg({ text: "let's talk pricing" })], { id: "m8", name: DEFAULT_TITLE }),
      segments: [seg({ text: "let's talk pricing" })],
      loadedHistoryId: "m8",
      replayReadOnly: false,
      filingStatus: "idle",
    });
    await runFilingSuggestion();
    expect(suggestFiling).toHaveBeenCalledTimes(1);
    expect(useStore.getState().filingStatus).toBe("running");

    resolve({ title: "Acme pricing call", folders: [] });
    await pass;
    const s = useStore.getState();
    expect(s.filingStatus).toBe("done");
    expect(s.replay?.name).toBe("Acme pricing call");
    expect(s.titleAutoApplied).toBe("m8");
    expect(renameHistoryEntry).toHaveBeenCalledWith("m8", "Acme pricing call");
    expect(inFlightStagesFor("m8").has("filing")).toBe(false);
  });

  it("does not start for the entry on screen (the study pipeline owns it)", async () => {
    save(entry("m9"));
    useStore.setState({ loadedHistoryId: "m9", replay: replaySession([seg()], { id: "m9" }) });
    expect(await runFilingForEntry("m9")).toBe(false);
  });
});

describe("filing queue", () => {
  it("runs one pass at a time and de-duplicates by entry id", async () => {
    save(entry("q1"));
    save(entry("q2"));
    const first = deferredSuggestion();
    const second = deferredSuggestion();
    queueBackgroundFiling("q1");
    queueBackgroundFiling("q1");
    queueBackgroundFiling("q2");
    await vi.waitFor(() => expect(suggestFiling).toHaveBeenCalledTimes(1));
    // q2 waits for q1 to land.
    await new Promise((r) => setTimeout(r, 10));
    expect(suggestFiling).toHaveBeenCalledTimes(1);
    first({ title: "One", folders: [] });
    await vi.waitFor(() => expect(suggestFiling).toHaveBeenCalledTimes(2));
    queueBackgroundFiling("q2"); // already running: ignored
    second({ title: "Two", folders: [] });
    await backgroundFilingSettled();
    expect(suggestFiling).toHaveBeenCalledTimes(2);
    expect(disk.get("q1")?.title).toBe("One");
    expect(disk.get("q2")?.title).toBe("Two");
  });
});

describe("launch catch-up", () => {
  it("needsCatchUp: only recent, spoken, unanswered, not recovered", () => {
    expect(needsCatchUp(entry("a"), NOW)).toBe(true);
    expect(needsCatchUp(entry("a", { createdAt: NOW - CATCH_UP_WINDOW_MS - 1 }), NOW)).toBe(false);
    expect(needsCatchUp(entry("a", { filingSuggested: true }), NOW)).toBe(false);
    expect(needsCatchUp(entry("a", { filingSuggestion: { title: "x", folders: [] } }), NOW)).toBe(false);
    expect(needsCatchUp(entry("a", { recovered: true }), NOW)).toBe(false);
    expect(needsCatchUp(entry("a", { segments: [] }), NOW)).toBe(false);
  });

  it("queues only the last 7 days' unanswered entries, oldest first", async () => {
    const day = 24 * 60 * 60 * 1000;
    save(entry("new", { createdAt: NOW - day }));
    save(entry("old", { createdAt: NOW - 3 * day }));
    save(entry("ancient", { createdAt: NOW - 8 * day }));
    save(entry("done", { createdAt: NOW - 2 * day, filingSuggested: true }));
    save(entry("recovered", { createdAt: NOW - 2 * day, recovered: true }));
    suggestFiling.mockImplementation(async (a: { currentTitle: string }) => ({ title: `named ${a.currentTitle}`, folders: [] }));

    expect(await catchUpBackgroundFiling(NOW)).toBe(2);
    await backgroundFilingSettled();
    expect(renameHistoryEntry.mock.calls.map((c) => c[0])).toEqual(["old", "new"]);
    expect(disk.get("ancient")?.filingSuggested).toBeUndefined();
  });

  it("does nothing without a realtime key", async () => {
    save(entry("k1"));
    keys.realtime = false;
    expect(await catchUpBackgroundFiling(NOW)).toBe(0);
  });
});
