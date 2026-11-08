import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every history flow, as the exact IPC traffic it produces: which commands run
// in what order with which argument objects (meta/summary JSON included,
// byte for byte), which events go out, which toasts show. Pinned by snapshot so
// restructuring history.ts — one payload builder, storage access split from
// the flows — can be shown not to change a single wire payload.

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../platform", async (orig) => ({
  ...(await orig<typeof import("../platform")>()),
  isTauri: () => true,
}));

const calls = vi.hoisted(() => [] as unknown[]);
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
const disk = vi.hoisted(() => new Map<string, unknown>());

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(["invoke", cmd, args]);
    switch (cmd) {
      case "read_history_entry": {
        const meta = disk.get(args!.id as string);
        if (!meta) throw new Error(`missing ${String(args!.id)}`);
        return { meta: structuredClone(meta), audioPath: `/entries/${String(args!.id)}/audio.ogg` };
      }
      case "save_history_entry":
        disk.set(args!.id as string, JSON.parse(args!.metaJson as string));
        return undefined;
      case "list_history":
        return [...disk.values()].map((m) => JSON.stringify({ id: (m as { id: string }).id, folderId: (m as { folderId?: string }).folderId ?? null, createdAt: 1 })).concat(["{corrupt"]);
      case "measure_audio_speech_rate":
        return 2.5;
      default:
        return undefined;
    }
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (...args: unknown[]) => { calls.push(["emit", ...args]); }),
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFocus: async () => {
      calls.push(["focus"]);
    },
  }),
}));
vi.mock("../cloud/syncState", () => ({
  markDirty: (id: string) => {
    calls.push(["markDirty", id]);
  },
}));
vi.mock("../cloud/client", async (orig) => ({
  ...(await orig<typeof import("../cloud/client")>()),
  syncEnabled: () => false,
}));
vi.mock("../cloud/folders", () => ({ deleteCloudFolder: vi.fn(async () => {}) }));
vi.mock("./studyCache", () => ({
  readStudyCache: () => null,
  writeStudyCache: (...a: unknown[]) => { calls.push(["writeStudyCache", ...a]); },
}));
const folders = vi.hoisted(() => ({ list: [] as { id: string; name: string; createdAt: number }[] }));
vi.mock("./folders", () => ({
  listLocalFolders: () => folders.list,
  deleteLocalFolder: (id: string) => { calls.push(["deleteLocalFolder", id]); },
  emitFoldersUpdated: async () => { calls.push(["emitFoldersUpdated"]); },
}));
const diar = vi.hoisted(() => ({ qualifies: false }));
vi.mock("../speakers/postDiarize", () => ({
  qualifiesForRediarization: () => diar.qualifies,
  rediarizeSegments: async (segments: { id: string; speaker: number }[]) => ({
    segments: segments.map((s) => ({ ...s, speaker: s.speaker + 1 })),
    changed: segments.length,
  }),
}));

import * as history from "./history";
import { setNotifier } from "../notify";
import { useLiveStore, useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";
import type { HistoryEntry } from "./types";

const INITIAL = useStore.getInitialState();
const INITIAL_LIVE = useLiveStore.getState();
let uuid = 0;

// Notices reach the user through the installed notifier (main.tsx installs
// sonner's toast); trace them under the toast names they render as.
let lastAction: { label: string; onClick: () => void } | undefined;
setNotifier({
  message: (t, action) => {
    lastAction = action;
    calls.push(action ? ["toast.message", t, action.label] : ["toast.message", t]);
  },
  success: (t) => { calls.push(["toast.success", t]); },
  error: (t) => { calls.push(["toast.error", t]); },
});

function baseMeta(id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    title: `Title ${id}`,
    source: "upload",
    createdAt: 100,
    durationMs: 60_000,
    segments: [seg({ id: "s1", text: "hello there", startMs: 0, endMs: 900 })],
    speakerNames: { "them-1": "Ann" },
    findings: [],
    actionItems: [],
    analyzed: false,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: "audio.ogg",
    folderId: null,
    ...extra,
  } as HistoryEntry;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useLiveStore.setState(INITIAL_LIVE, true);
  calls.length = 0;
  disk.clear();
  folders.list = [];
  diar.qualifies = false;
  uuid = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `uuid-${++uuid}` as `${string}-${string}-${string}-${string}-${string}`);
});

async function trace(run: () => Promise<unknown>): Promise<unknown[]> {
  const result = await run();
  await flush();
  return [...calls, ["result", result]];
}

const studyState = () =>
  useStore.setState({
    segments: [seg({ id: "s1", text: "new text", startMs: 0, endMs: 900 })],
    speakerNames: { "them-1": "Bo" },
    findings: [{ id: "f1", atMs: 10, side: "them", severity: "warn", source: "extra", title: "t", detail: "d" }],
    actionItems: [{ id: "a1", text: "x", done: false, linkedEventId: null, atMs: null }],
    analysisStatus: "done",
    actionItemsStatus: "done",
    brief: "the brief",
    briefStatus: "done",
    meetingKind: "sales" as never,
    meetingContext: "ctx",
  });

/** The snapshot the recording event would save the just-stopped meeting with. */
const stoppedMeeting = () => history.liveSnapshotFor(useLiveStore.getState().liveMeetingId ?? undefined, undefined);

describe("history IPC traffic", () => {
  it("saveTranscriptToHistory", async () => {
    expect(
      await trace(() =>
        history.saveTranscriptToHistory({
          title: "Imported",
          segments: [seg({ id: "i1", text: "imported line" })],
          speakerNames: {},
          durationMs: 1000,
          createdAt: 42,
          folderId: "fold-1",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("saveUploadToHistory", async () => {
    const session = replaySession([seg({ id: "u1", text: "upload line" })], { speechRateHz: 3 });
    useStore.getState().enterReplay(session);
    useStore.setState({ meetingFolderId: "picked" });
    expect(await trace(() => history.saveUploadToHistory(session))).toMatchSnapshot();
    expect(useStore.getState().loadedHistoryId).toBe("uuid-1");
    expect(useStore.getState().replayFolderId).toBe("picked");
  });

  it("saveLiveToHistory: kept, opened, no correction", async () => {
    const live = () => useLiveStore.getState();
    live().startMeeting();
    live().upsertSegment(seg({ id: "m1", source: "me", speaker: 0, text: "spoken words" }));
    live().stopMeeting();
    useLiveStore.setState({ meetingStartedAt: 1_000, isFinalizingMeeting: true });
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000, stoppedMeeting()))).toMatchSnapshot();
    const s = useStore.getState();
    // Home with nothing loaded: the report opens by itself.
    expect(s.appMode).toBe("study");
    expect(live().isFinalizingMeeting).toBe(false);
    expect(s.loadedHistoryId).toBe("uuid-1");
  });

  it("saveLiveToHistory: a busy main window keeps its recording and is offered the report instead", async () => {
    disk.set("other", baseMeta("other"));
    await history.loadHistoryEntry("other");
    const live = () => useLiveStore.getState();
    live().startMeeting();
    const id = live().liveMeetingId!;
    live().upsertSegment(seg({ id: "m1", source: "me", speaker: 0, text: "spoken words" }));
    live().stopMeeting();
    calls.length = 0;
    await history.saveLiveToHistory("/tmp-rec.ogg", 5_000, stoppedMeeting());
    await flush();
    expect(useStore.getState().loadedHistoryId).toBe("other");
    expect((disk.get(id) as HistoryEntry | undefined)?.segments.map((x) => x.text)).toEqual(["spoken words"]);
    expect(calls).toContainEqual(["toast.message", "會議已存好", "打開"]);
    lastAction!.onClick();
    await flush();
    expect(useStore.getState().loadedHistoryId).toBe(id);
  });

  it("saveLiveToHistory: speaker correction rewrites the saved entry and the store", async () => {
    diar.qualifies = true;
    const live = () => useLiveStore.getState();
    live().startMeeting();
    live().upsertSegment(seg({ id: "x1", source: "mix", speaker: 1, text: "line one" }));
    live().upsertSegment(seg({ id: "x2", source: "mix", speaker: 2, text: "line two", startMs: 1000, endMs: 2000 }));
    live().stopMeeting();
    useLiveStore.setState({ meetingStartedAt: 1_000, micSessionRateHz: 4 });
    const seen: (string | null)[] = [];
    const un = useStore.subscribe((st, prev) => {
      if (st.postSaveDiarizingId !== prev.postSaveDiarizingId) seen.push(st.postSaveDiarizingId);
    });
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000, stoppedMeeting()))).toMatchSnapshot();
    un();
    expect(seen).toEqual(["uuid-1", null]);
    // The opened report and the stopped meeting both carry the correction.
    expect(useStore.getState().segments.map((x) => x.speaker)).toEqual([2, 3]);
    expect(live().segments.map((x) => x.speaker)).toEqual([2, 3]);
  });

  it("saveLiveToHistory: discarded when nothing was said", async () => {
    useLiveStore.getState().startMeeting();
    useLiveStore.getState().stopMeeting();
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000, stoppedMeeting()))).toMatchSnapshot();
    expect(useStore.getState().appMode).toBe("home");
  });

  it("updateHistoryEntry", async () => {
    disk.set("e1", baseMeta("e1", { filingSuggestion: { title: "keep", folders: [] }, filingSuggested: true } as never));
    studyState();
    expect(await trace(() => history.updateHistoryEntry("e1"))).toMatchSnapshot();
  });

  it("patchEntryOutputs (pushed and not)", async () => {
    disk.set("e1", baseMeta("e1"));
    expect(
      await trace(async () => {
        await history.patchEntryOutputs("e1", { brief: "b", briefFailed: false });
        await history.patchEntryOutputs("e1", { analyzed: true, actionItems: [] }, { push: false });
      }),
    ).toMatchSnapshot();
  });

  it("persistStageOutputs to a read-only cache", async () => {
    expect(
      await trace(() => history.persistStageOutputs({ entryId: null, readOnlyId: "ro" }, { brief: "", briefFailed: true })),
    ).toMatchSnapshot();
  });

  it("persistReadOnlyStudyOutputs", async () => {
    studyState();
    useStore.setState({ replayReadOnly: true, replay: replaySession([]) });
    expect(await trace(() => history.persistReadOnlyStudyOutputs())).toMatchSnapshot();
  });

  it("persistFilingSuggestion", async () => {
    disk.set("e1", baseMeta("e1"));
    useStore.setState({ loadedHistoryId: "e1", filingSuggestion: { title: "New", folders: [] } });
    expect(await trace(() => history.persistFilingSuggestion())).toMatchSnapshot();
  });

  it("setEntryFolder (changed, then unchanged)", async () => {
    disk.set("e1", baseMeta("e1"));
    useStore.setState({ loadedHistoryId: "e1" });
    expect(
      await trace(async () => {
        await history.setEntryFolder("e1", "fold-9");
        await history.setEntryFolder("e1", "fold-9");
      }),
    ).toMatchSnapshot();
    expect(useStore.getState().replayFolderId).toBe("fold-9");
  });

  it("updateEntryMeta", async () => {
    disk.set("e1", baseMeta("e1"));
    useStore.setState({ loadedHistoryId: "e1" });
    expect(
      await trace(() => history.updateEntryMeta("e1", { meetingContext: "frame", speakerNames: { "them-1": "", "me-0": " Me " } })),
    ).toMatchSnapshot();
    expect(useStore.getState().meetingContext).toBe("frame");
  });

  it("setEntryAnalysis", async () => {
    disk.set("e1", baseMeta("e1", { briefFailed: true } as never));
    useStore.setState({ loadedHistoryId: "e1" });
    expect(
      await trace(() => history.setEntryAnalysis("e1", { brief: "external", analyzed: true, actionItems: [] })),
    ).toMatchSnapshot();
  });

  it("renameHistoryEntry + deleteHistoryEntry + listHistory", async () => {
    disk.set("e1", baseMeta("e1"));
    expect(
      await trace(async () => {
        await history.renameHistoryEntry("e1", "  New name ");
        const list = await history.listHistory();
        await history.deleteHistoryEntry("e1");
        return list;
      }),
    ).toMatchSnapshot();
  });

  it("loadHistoryEntry", async () => {
    disk.set("e1", baseMeta("e1", { brief: "saved", analyzed: true, folderId: "f" } as never));
    expect(await trace(() => history.loadHistoryEntry("e1"))).toMatchSnapshot();
    const s = useStore.getState();
    expect(s.loadedHistoryId).toBe("e1");
    expect(s.replay?.audioSrc).toBe("asset:///entries/e1/audio.ogg");
    expect(s.brief).toBe("saved");
  });

  it("loadHistoryEntry during a meeting loads into the main window and leaves the meeting alone", async () => {
    const live = useLiveStore.getState();
    live.startMeeting();
    useLiveStore.setState({ meetingContext: "live ctx", meetingFolderId: "live-fold", todos: [{ id: "t", text: "agenda", done: false }] });
    live.upsertSegment(seg({ id: "l1", source: "mix", speaker: 1, text: "live line" }));
    live.setSpeakerName("mix-1", "Dana");
    live.setFindings([{ id: "lf", atMs: 0, side: "them", severity: "info", source: "extra", title: "t", detail: "d" }]);
    const before = useLiveStore.getState();
    disk.set("e1", baseMeta("e1", { meetingContext: "saved ctx", folderId: "f" } as never));

    await history.loadHistoryEntry("e1");

    const s = useStore.getState();
    expect(s.loadedHistoryId).toBe("e1");
    expect(s.meetingContext).toBe("saved ctx");
    const after = useLiveStore.getState();
    expect(after.meetingStatus).toBe("recording");
    expect(after.segments).toBe(before.segments);
    expect(after.speakerNames).toBe(before.speakerNames);
    expect(after.findings).toBe(before.findings);
    expect(after.meetingContext).toBe("live ctx");
    expect(after.meetingFolderId).toBe("live-fold");
    expect(after.todos).toBe(before.todos);
  });

  it("migrateDuplicateFolders", async () => {
    folders.list = [
      { id: "old", name: "Acme", createdAt: 1 },
      { id: "twin", name: "Acme ", createdAt: 2 },
    ];
    disk.set("e1", baseMeta("e1", { folderId: "twin" }));
    disk.set("e2", baseMeta("e2", { folderId: "old" }));
    expect(await trace(() => history.migrateDuplicateFolders())).toMatchSnapshot();
  });
});

// The save race (C1): the recording of a stopped meeting is encoded while the
// user may already be in the next one. Its save must use what the stopped
// meeting looked like, never the live store.
describe("persistTranscriptText", () => {
  it("writes only the edited text onto the saved transcript, then tells listeners", async () => {
    disk.set(
      "e1",
      baseMeta("e1", {
        // Untimed on disk; the screen shows an estimate (replay/timing).
        segments: [seg({ id: "s1", text: "東昇 hi", startMs: 0, endMs: 0 }), seg({ id: "s2", text: "ok", startMs: 0, endMs: 0 })],
        brief: "kept",
      }),
    );
    await history.persistTranscriptText("e1", [
      seg({ id: "s1", text: "東森 hi", startMs: 400, endMs: 900 }),
      seg({ id: "s2", text: "ok", startMs: 900, endMs: 1200 }),
    ]);
    await flush();
    const meta = disk.get("e1") as HistoryEntry;
    expect(meta.segments.map((s) => [s.text, s.startMs, s.endMs])).toEqual([
      ["東森 hi", 0, 0],
      ["ok", 0, 0],
    ]);
    expect(meta.brief).toBe("kept");
    expect(calls.some((c) => (c as unknown[])[0] === "emit")).toBe(true);
  });

  it("writes nothing when the text on disk already matches", async () => {
    disk.set("e1", baseMeta("e1"));
    await history.persistTranscriptText("e1", [seg({ id: "s1", text: "hello there" })]);
    await flush();
    expect(calls.filter((c) => (c as unknown[])[1] === "save_history_entry")).toEqual([]);
  });
});

describe("live save race", () => {
  const fire = (name: string, payload: unknown) => handlers.get(name)!({ payload });
  const savedEntries = () => [...disk.values()] as HistoryEntry[];
  let unlisten: () => void = () => {};

  beforeEach(async () => {
    handlers.clear();
    unlisten = await history.listenForRecordingSaved();
  });

  afterEach(() => unlisten());

  /** Start a meeting the backend records, say `words` in it, stop it. */
  function recordAndStop(words: string, startedAt: number): string {
    useLiveStore.getState().startMeeting();
    const id = useLiveStore.getState().liveMeetingId!;
    history.liveSaves.markRecording(id);
    useLiveStore.setState({ meetingStartedAt: startedAt });
    useLiveStore.getState().upsertSegment(seg({ id: `${id}-s`, source: "me", speaker: 0, text: words }));
    useLiveStore.getState().stopMeeting();
    return id;
  }

  it("saves a meeting whose encode finishes after the next one started as itself", async () => {
    const a = recordAndStop("meeting A words", 1_000);
    expect(history.liveSaves.hasPending()).toBe(true);
    // The user is already in meeting B — nothing said yet.
    useLiveStore.getState().startMeeting();
    useLiveStore.setState({ meetingStartedAt: 9_000 });
    const b = useLiveStore.getState().liveMeetingId;

    fire("meeting://recording-saved", { path: "/tmp-a.ogg", durationMs: 4_000, meetingId: a, startedAtMs: 1_000 });
    await flush();

    // Before: B's start time and empty transcript, or A discarded as empty.
    const [entry] = savedEntries();
    expect(entry.id).toBe(a);
    expect(entry.createdAt).toBe(1_000);
    expect(entry.segments.map((x) => x.text)).toEqual(["meeting A words"]);
    expect(calls).toContainEqual(["invoke", "finish_meeting_journal", { meetingId: a }]);
    // Meeting B is untouched and still on screen.
    const s = useLiveStore.getState();
    expect(s.liveMeetingId).toBe(b);
    expect(s.meetingStatus).toBe("recording");
    // The meeting runs in its own window; the main window stays where it was.
    expect(useStore.getState().appMode).toBe("home");
    expect(history.liveSaves.hasPending()).toBe(false);
  });

  it("keeps the final words that land after Stop while the meeting is still on screen", async () => {
    const a = recordAndStop("first words", 1_000);
    // The provider's closing flush, after Stop.
    useLiveStore.getState().upsertSegment(seg({ id: "late", source: "me", speaker: 0, text: "last words", startMs: 2_000, endMs: 2_500 }));
    fire("meeting://recording-saved", { path: "/tmp-a.ogg", durationMs: 4_000, meetingId: a, startedAtMs: 1_000 });
    await flush();
    expect(savedEntries()[0].segments.map((x) => x.text)).toEqual(["first words", "last words"]);
  });

  it("a discarded recording settles its meeting without touching the next one's screen", async () => {
    const a = recordAndStop("hi", 1_000);
    useLiveStore.getState().startMeeting();
    fire("meeting://recording-discarded", { meetingId: a, startedAtMs: 1_000 });
    await flush();
    expect(history.liveSaves.hasPending()).toBe(false);
    expect(useStore.getState().appMode).toBe("home");
    expect(calls.filter((c) => (c as unknown[])[0] === "toast.message")).toEqual([]);
  });

  it("saves the live meeting's transcript, names, findings and prep even with another recording opened in between", async () => {
    useStore.getState().setMeetingContext("prep for A");
    useStore.getState().addTodo("agenda A");
    const { beginLiveSession } = await import("../meeting/liveSession");
    beginLiveSession();
    const id = useLiveStore.getState().liveMeetingId!;
    history.liveSaves.markRecording(id);
    useLiveStore.getState().upsertSegment(seg({ id: "a1", source: "mix", speaker: 1, text: "live words" }));
    useLiveStore.getState().setSpeakerName("mix-1", "Carol");
    useLiveStore.getState().setFindings([{ id: "lf", atMs: 0, side: "them", severity: "info", source: "extra", title: "live", detail: "d" }]);
    // Meanwhile the main window opens (and edits) another recording.
    disk.set("other", baseMeta("other", { meetingContext: "other ctx" }));
    await history.loadHistoryEntry("other");
    useStore.getState().setSpeakerName("them-1", "Renamed");
    useLiveStore.getState().stopMeeting();
    fire("meeting://recording-saved", { path: "/tmp-a.ogg", durationMs: 4_000, meetingId: id, startedAtMs: 1_000 });
    await flush();
    const saved = disk.get(id) as HistoryEntry;
    expect(saved.segments.map((x) => x.text)).toEqual(["live words"]);
    expect(saved.speakerNames).toEqual({ "mix-1": "Carol" });
    expect(saved.findings.map((f) => f.id)).toEqual(["lf"]);
    expect(saved.meetingContext).toContain("prep for A");
    // The other recording stays open: the report is offered, not forced.
    expect(useStore.getState().loadedHistoryId).toBe("other");
    expect(useStore.getState().meetingContext).toBe("other ctx");
  });

  it("a recording from a meeting this window never saw is kept without a transcript", async () => {
    fire("meeting://recording-saved", { path: "/tmp-x.ogg", durationMs: 4_000, meetingId: "lost", startedAtMs: 777 });
    await flush();
    const [entry] = savedEntries();
    expect(entry).toMatchObject({ id: "lost", createdAt: 777, segments: [] });
  });
});

describe("recoverCrashedMeetings", () => {
  it("saves each recovered journal once, then drops it", async () => {
    disk.set("already", baseMeta("already"));
    invoke.mockImplementationOnce(async (cmd: string) => {
      calls.push(["invoke", cmd]);
      return [
        { meetingId: "crashed", path: "/tmp-c.ogg", durationMs: 600_000, startedAtMs: 1_000 },
        { meetingId: "already", path: "/tmp-d.ogg", durationMs: 5_000, startedAtMs: 2_000 },
      ] as never;
    });
    expect(await history.recoverCrashedMeetings()).toBe(1);
    await flush();
    expect(disk.get("crashed")).toMatchObject({ id: "crashed", createdAt: 1_000, durationMs: 600_000, segments: [] });
    expect((disk.get("crashed") as HistoryEntry).title).toContain("（已復原）");
    expect(calls).toContainEqual(["invoke", "discard_recording", { path: "/tmp-d.ogg" }]);
    expect(calls).toContainEqual(["invoke", "finish_meeting_journal", { meetingId: "crashed" }]);
    expect(calls).toContainEqual(["invoke", "finish_meeting_journal", { meetingId: "already" }]);
    expect(calls.filter((c) => (c as unknown[])[0] === "toast.message")).toHaveLength(1);
  });
});
