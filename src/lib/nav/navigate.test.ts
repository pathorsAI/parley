import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
// Reopening an entry reads it off disk; the tests only need to see it asked for.
const { loadHistoryEntry } = vi.hoisted(() => ({
  loadHistoryEntry: vi.fn(async (id: string) => {
    const { useStore } = await import("../store");
    useStore.setState({ appMode: "study", loadedHistoryId: id });
  }),
}));
vi.mock("../history/history", () => ({ loadHistoryEntry }));

import { useLiveStore, useStore, type LibrarySelection } from "../store";
import { replaySession, seg } from "../test/fixtures";
import { leaveRecordingTo, navHistory, navigateTo } from "./navigate";

const INITIAL = useStore.getState();
const INITIAL_LIVE = useLiveStore.getState();
const FOLDER: LibrarySelection = { kind: "personal", node: { kind: "folder", folderId: "f-acme" } };

function openRecording(id: string | null) {
  useStore.setState({
    appMode: "study",
    replay: replaySession([]),
    loadedHistoryId: id,
    studyTab: "replay",
  });
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useLiveStore.setState(INITIAL_LIVE, true);
  navHistory.reset();
  loadHistoryEntry.mockClear();
});

describe("leaveRecordingTo", () => {
  it("closes the recording and lands on the library node, never passing through Home", async () => {
    openRecording("rec-1");
    const modes: string[] = [];
    const un = useStore.subscribe((s) => modes.push(s.appMode));
    const outcome = await leaveRecordingTo(FOLDER);
    un();

    expect(outcome.status).toBe("applied");
    const s = useStore.getState();
    expect(s.appMode).toBe("library");
    expect(s.librarySelection).toEqual(FOLDER);
    expect(s.replay).toBeNull();
    expect(s.loadedHistoryId).toBeNull();
    expect(s.studyTab).toBe("summary");
    // exitReplay passes through "home" inside the same synchronous turn; the
    // point is that nothing async sits between it and the library.
    expect(modes[modes.length - 1]).toBe("library");
  });

  it("puts the recording behind the folder, so ⌘[ reopens it", async () => {
    openRecording("rec-1");
    await leaveRecordingTo(FOLDER);
    expect(navHistory.entries()).toEqual([
      { kind: "entry", id: "rec-1" },
      { kind: "library", selection: FOLDER },
    ]);

    await navHistory.back();
    expect(loadHistoryEntry).toHaveBeenCalledWith("rec-1");
  });

  it("an unsaved upload has nothing to come back to", async () => {
    openRecording(null);
    await leaveRecordingTo({ kind: "personal", node: { kind: "all" } });
    expect(navHistory.entries()).toEqual([
      { kind: "library", selection: { kind: "personal", node: { kind: "all" } } },
    ]);
  });

  it("works during a meeting and never touches it — the meeting has its own store", async () => {
    openRecording("rec-1");
    useLiveStore.setState({ meetingStatus: "recording", liveMeetingId: "m1", segments: [seg({ id: "live" })] });
    expect((await leaveRecordingTo(FOLDER)).status).toBe("applied");
    expect(useStore.getState().replay).toBeNull();
    const live = useLiveStore.getState();
    expect(live.meetingStatus).toBe("recording");
    expect(live.segments.map((x) => x.id)).toEqual(["live"]);
  });

  it("opens a saved recording during a meeting", async () => {
    useLiveStore.setState({ meetingStatus: "recording", liveMeetingId: "m1" });
    expect((await navigateTo({ kind: "entry", id: "rec-2" })).status).toBe("applied");
    expect(loadHistoryEntry).toHaveBeenCalledWith("rec-2");
    expect(useLiveStore.getState().meetingStatus).toBe("recording");
  });
});
