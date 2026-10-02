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

import { useStore, type LibrarySelection } from "../store";
import { replaySession } from "../test/fixtures";
import { leaveRecordingTo, navHistory } from "./navigate";

const INITIAL = useStore.getState();
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
    expect(s.studyTab).toBe("report");
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

  it("refuses while a meeting is running — exitReplay would reset it to idle", async () => {
    openRecording("rec-1");
    useStore.setState({ meetingStatus: "recording" });
    expect((await leaveRecordingTo(FOLDER)).status).toBe("refused");
    expect(useStore.getState().meetingStatus).toBe("recording");
    expect(useStore.getState().replay).not.toBeNull();
  });
});
