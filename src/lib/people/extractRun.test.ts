import { beforeEach, describe, expect, it, vi } from "vitest";

const { extract, entry } = vi.hoisted(() => ({
  extract: vi.fn(),
  entry: {
    id: "r1",
    createdAt: 1_790_000_000_000,
    meetingContext: "與會者：王小明（Acme）",
    speakerNames: { "them-1": "王小明" },
    selfSpeaker: null,
    segments: [{ id: "s1", source: "them", speaker: 1, text: "我們十二月要去北海道滑雪", startMs: 15_000, endMs: 18_000, isFinal: true }],
  },
}));

vi.mock("../ai/peopleNotes", () => ({ extractPeopleNotes: extract }));
vi.mock("../ai/settings", () => ({ hasProviderKey: () => true }));
vi.mock("../history/entryStore", () => ({
  entryWritesSettled: () => Promise.resolve(),
  readEntry: () => Promise.resolve({ meta: entry }),
}));

import { useStore } from "../store";
import { candidatesFor, knownPeople } from "./notes";
import { loadPeople, resetPeopleForTests } from "./store";
import { runPeopleNotesForEntry } from "./extractRun";

beforeEach(() => {
  resetPeopleForTests();
  extract.mockReset();
  useStore.getState().updateSettings({ autoStudyAnalysis: true });
});

describe("runPeopleNotesForEntry", () => {
  it("files what it finds as candidates tied to the recording, and reads a recording once", async () => {
    extract.mockResolvedValue([{ name: "王小明", org: "Acme", text: "十二月要去北海道滑雪", quote: "我們十二月要去北海道滑雪", atMs: 15_000 }]);
    expect(await runPeopleNotesForEntry("r1")).toBe(1);
    const doc = await loadPeople();
    expect(candidatesFor(doc, "r1")).toMatchObject([
      { person: { name: "王小明", org: "Acme" }, note: { saidAt: entry.createdAt, recordingId: "r1", atMs: 15_000, status: "candidate" } },
    ]);
    // Nothing is known outside the report until the user keeps it.
    expect(knownPeople(doc)).toEqual([]);
    expect(await runPeopleNotesForEntry("r1")).toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("remembers a recording with nothing in it, but not a failed pass", async () => {
    extract.mockResolvedValueOnce(null);
    expect(await runPeopleNotesForEntry("r1")).toBeNull();
    expect((await loadPeople()).extracted).toEqual([]);
    extract.mockResolvedValueOnce([]);
    expect(await runPeopleNotesForEntry("r1")).toBe(0);
    expect((await loadPeople()).extracted).toEqual(["r1"]);
  });

  it("does not run with auto-analysis off", async () => {
    useStore.getState().updateSettings({ autoStudyAnalysis: false });
    expect(await runPeopleNotesForEntry("r1")).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });
});
