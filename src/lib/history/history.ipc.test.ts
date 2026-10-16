import { describe, it, expect, vi, beforeEach } from "vitest";

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
  listen: vi.fn(async () => () => {}),
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
import { useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";
import type { HistoryEntry } from "./types";

const INITIAL = useStore.getInitialState();
let uuid = 0;

// Notices reach the user through the installed notifier (main.tsx installs
// sonner's toast); trace them under the toast names they render as.
setNotifier({
  message: (t) => { calls.push(["toast.message", t]); },
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
    useStore.getState().startMeeting();
    useStore.getState().upsertSegment(seg({ id: "m1", source: "me", speaker: 0, text: "spoken words" }));
    useStore.getState().stopMeeting();
    useStore.setState({ meetingStartedAt: 1_000, isFinalizingMeeting: true });
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000))).toMatchSnapshot();
    const s = useStore.getState();
    expect(s.appMode).toBe("study");
    expect(s.isFinalizingMeeting).toBe(false);
    expect(s.loadedHistoryId).toBe("uuid-1");
  });

  it("saveLiveToHistory: speaker correction rewrites the saved entry and the store", async () => {
    diar.qualifies = true;
    useStore.getState().startMeeting();
    useStore.getState().upsertSegment(seg({ id: "x1", source: "mix", speaker: 1, text: "line one" }));
    useStore.getState().upsertSegment(seg({ id: "x2", source: "mix", speaker: 2, text: "line two", startMs: 1000, endMs: 2000 }));
    useStore.getState().stopMeeting();
    useStore.setState({ meetingStartedAt: 1_000, micSessionRateHz: 4 });
    const seen: (string | null)[] = [];
    const un = useStore.subscribe((st, prev) => {
      if (st.postSaveDiarizingId !== prev.postSaveDiarizingId) seen.push(st.postSaveDiarizingId);
    });
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000))).toMatchSnapshot();
    un();
    expect(seen).toEqual(["uuid-1", null]);
    expect(useStore.getState().segments.map((x) => x.speaker)).toEqual([2, 3]);
  });

  it("saveLiveToHistory: discarded when nothing was said", async () => {
    useStore.getState().startMeeting();
    useStore.getState().stopMeeting();
    expect(await trace(() => history.saveLiveToHistory("/tmp-rec.ogg", 5_000))).toMatchSnapshot();
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
