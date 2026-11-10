import { beforeEach, describe, expect, it, vi } from "vitest";

// The main window stays fully usable while a meeting runs: the meeting lives in
// its own store (useLiveStore), so nothing done in the main window (useStore)
// reaches it, and nothing the meeting does lands on what the main window shows.
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  analyze: vi.fn(),
  cloudFetch: vi.fn(),
}));

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../ipc/events", async (orig) => ({
  ...(await orig<typeof import("../ipc/events")>()),
  listenIfTauri: (name: string, handler: (e: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return Promise.resolve(() => {});
  },
}));
vi.mock("../textNormalize", () => ({ normalizeTranscriptText: async (t: string) => t }));
vi.mock("../ai/settings", async (orig) => ({
  ...(await orig<typeof import("../ai/settings")>()),
  hasProviderKey: () => true,
}));
vi.mock("../ai/timeline", () => ({ analyzeTimeline: (...a: unknown[]) => mocks.analyze(...a) }));
vi.mock("../ai/meetingKind", () => ({ detectMeetingKind: async () => null }));
vi.mock("../history/history", () => ({ persistStageOutputs: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFocus: async () => {} }) }));
vi.mock("../cloud/client", async (orig) => ({
  ...(await orig<typeof import("../cloud/client")>()),
  cloudFetch: (...a: unknown[]) => mocks.cloudFetch(...a),
  cloudToken: () => null,
}));

import { useLiveStore, useStore } from "../store";
import { listenForTranscript } from "../tauriEvents";
import { runAnalysis } from "../analysis/engine";
import { loadOrgEntry } from "../history/open";
import { beginLiveSession } from "./liveSession";
import { replaySession, seg } from "../test/fixtures";
import type { TimelineEvent } from "../types";

const INITIAL = useStore.getState();
const INITIAL_LIVE = useLiveStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useLiveStore.setState(INITIAL_LIVE, true);
  mocks.handlers.clear();
  mocks.analyze.mockReset();
  mocks.cloudFetch.mockReset();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

const finding = (id: string): TimelineEvent => ({
  id,
  atMs: 0,
  side: "them",
  severity: "info",
  source: "extra",
  title: id,
  detail: id,
});

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("transcript events", () => {
  it("land in the live store whatever the main window shows, and never in useStore", async () => {
    await listenForTranscript();
    useLiveStore.getState().startMeeting();
    for (const appMode of ["study", "home", "library"] as const) {
      useStore.setState({ appMode, replay: replaySession([seg({ id: "r1" })]), segments: [seg({ id: "r1" })] });
      mocks.handlers.get("transcript://segment")!({
        payload: { id: `seg-${appMode}`, source: "mix", speaker: 1, text: "hello", is_final: true, start_ms: 0, end_ms: 10 },
      });
      await flush();
    }
    expect(useLiveStore.getState().segments.map((x) => x.id)).toEqual(["seg-study", "seg-home", "seg-library"]);
    expect(useStore.getState().segments.map((x) => x.id)).toEqual(["r1"]);
  });
});

describe("live vs replay analysis", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("run side by side with separate locks, each writing only its own store", async () => {
    // The main window has a recording loaded (kind already known: no detection).
    useStore.setState({
      appMode: "study",
      replay: replaySession([seg({ id: "r1", text: "replay words" })]),
      segments: [seg({ id: "r1", text: "replay words" })],
      meetingKind: "sales" as never,
    });
    useLiveStore.getState().startMeeting();
    useLiveStore.getState().upsertSegment(seg({ id: "l1", text: "live words" }));

    const replayRun = deferred<TimelineEvent[]>();
    const liveRun = deferred<TimelineEvent[]>();
    mocks.analyze.mockImplementation((opts: { mode: string }) =>
      opts.mode === "live" ? liveRun.promise : replayRun.promise,
    );

    const replay = runAnalysis({ mode: "replay", force: true });
    expect(useStore.getState().analysisStatus).toBe("running");
    // The replay pass holding its lock does not block the live one…
    const live = runAnalysis({ mode: "live" });
    expect(useLiveStore.getState().analysisStatus).toBe("running");
    await flush();
    expect(mocks.analyze).toHaveBeenCalledTimes(2);

    liveRun.resolve([finding("live-f")]);
    await live;
    expect(useLiveStore.getState().findings.map((f) => f.id)).toEqual(["live-f"]);
    expect(useLiveStore.getState().analysisStatus).toBe("done");
    // …and its result never lands on the recording.
    expect(useStore.getState().findings).toEqual([]);
    expect(useStore.getState().analysisStatus).toBe("running");

    replayRun.resolve([finding("replay-f")]);
    await replay;
    expect(useStore.getState().findings.map((f) => f.id)).toEqual(["replay-f"]);
    expect(useStore.getState().meetingKind).toBe("sales");
    expect(useLiveStore.getState().findings.map((f) => f.id)).toEqual(["live-f"]);
  });

  it("a live pass in flight refuses a second live pass but not a replay one", async () => {
    useStore.setState({
      appMode: "study",
      replay: replaySession([seg({ id: "r1", text: "replay words" })]),
      segments: [seg({ id: "r1", text: "replay words" })],
      meetingKind: "sales" as never,
    });
    useLiveStore.getState().startMeeting();
    useLiveStore.getState().upsertSegment(seg({ id: "l1", text: "live words" }));
    const hold = deferred<TimelineEvent[]>();
    mocks.analyze.mockImplementation(() => hold.promise);

    const first = runAnalysis({ mode: "live" });
    await runAnalysis({ mode: "live" });
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
    const replay = runAnalysis({ mode: "replay", force: true });
    await flush();
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
    hold.resolve([]);
    await Promise.all([first, replay]);
  });
});

describe("drafts during a meeting", () => {
  it("editing, saving, discarding and resetting a draft leaves the meeting's prep alone", () => {
    useStore.getState().setMeetingContext("meeting A context");
    useStore.getState().addTodo("A's agenda");
    beginLiveSession();
    const prep = () => {
      const s = useLiveStore.getState();
      return { context: s.meetingContext, todos: s.todos, folder: s.meetingFolderId, title: s.meetingTitle };
    };
    const before = prep();

    const main = useStore.getState();
    main.setDraftOpen(true);
    expect(useStore.getState().draftOpen).toBe(true);
    main.setMeetingTitle("next week");
    main.setMeetingContext("draft context");
    main.addTodo("draft agenda");
    main.setMeetingFolder("draft-folder");
    const saved = useStore.getState().saveDraft();
    expect(saved?.meetingContext).toBe("draft context");
    useStore.getState().editDraft(saved!.id);
    useStore.getState().setMeetingContext("edited");
    useStore.getState().discardDraftEdit();
    useStore.getState().resetPrep();

    expect(prep()).toEqual(before);
    expect(prep().context).toBe("meeting A context");
  });

  it("taking a draft is refused while the meeting runs (one meeting at a time)", () => {
    beginLiveSession();
    useStore.setState({ meetingContext: "draft ctx" });
    const draft = useStore.getState().saveDraft()!;
    const before = useLiveStore.getState().meetingContext;

    expect(useStore.getState().takeDraft(draft.id)).toBe(false);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual([draft.id]);
    expect(useLiveStore.getState().meetingContext).toBe(before);
  });
});

describe("imports and org recordings during a meeting", () => {
  function runningMeeting() {
    useStore.getState().setMeetingContext("live prep");
    beginLiveSession();
    useLiveStore.getState().upsertSegment(seg({ id: "l1", text: "live words" }));
    useLiveStore.getState().setFindings([finding("lf")]);
    return useLiveStore.getState();
  }

  it("an import (enterReplay) loads into the main window without touching the live store", () => {
    const before = runningMeeting();
    const session = replaySession([seg({ id: "u1", text: "uploaded" })]);

    useStore.getState().openIngestWizard("/x.m4a");
    useStore.getState().setMeetingFolder("import-folder");
    useStore.getState().enterReplay(session);

    expect(useStore.getState().appMode).toBe("study");
    expect(useStore.getState().segments.map((x) => x.id)).toEqual(["u1"]);
    const after = useLiveStore.getState();
    expect(after.meetingStatus).toBe("recording");
    expect(after.segments).toBe(before.segments);
    expect(after.findings).toBe(before.findings);
    expect(after.meetingContext).toBe("live prep");
    expect(after.meetingFolderId).toBeNull();
  });

  it("loadOrgEntry loads read-only into the main window and leaves the meeting alone", async () => {
    const before = runningMeeting();
    mocks.cloudFetch.mockResolvedValue({
      json: async () => ({
        id: "org-rec",
        title: "Shared",
        source: "upload",
        createdAt: 1,
        durationMs: 1000,
        segments: [seg({ id: "o1", text: "org words" })],
        speakerNames: {},
        findings: [],
        actionItems: [],
        meetingContext: "org ctx",
        meetingBatna: "",
        meetingTarget: "",
        meetingFloor: "",
        audio: null,
      }),
    });

    await loadOrgEntry("org-1", "org-rec");

    const main = useStore.getState();
    expect(main.appMode).toBe("study");
    expect(main.replayReadOnly).toBe(true);
    expect(main.segments.map((x) => x.id)).toEqual(["o1"]);
    const after = useLiveStore.getState();
    expect(after.segments).toBe(before.segments);
    expect(after.findings).toBe(before.findings);
    expect(after.meetingContext).toBe("live prep");
    expect(after.meetingStatus).toBe("recording");
  });
});

describe("starting a meeting while a recording is open", () => {
  it("keeps the recording's context on screen and does not hand it to the new meeting", () => {
    useStore.getState().enterReplay(replaySession([seg({ id: "r1", text: "old" })]));
    useStore.getState().setMeetingContext("old recording's background");
    beginLiveSession();
    expect(useStore.getState().meetingContext).toBe("old recording's background");
    expect(useLiveStore.getState().meetingContext).toBe("");
  });
});
