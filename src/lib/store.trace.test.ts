import { describe, it, expect, vi, beforeAll } from "vitest";
import { createHash } from "node:crypto";

// A full, deterministic trace of every store action: after each step, which
// state fields changed (and to what), whether the persisted "parley-settings"
// payload changed (its hash), and the speaker-name cache side effect. Pinned
// with a file snapshot so splitting the store into slices can be proven to
// leave every action's observable effect — including the bytes written to
// localStorage — exactly as it was.

const { storage, writes } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const writes = { count: 0 };
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.count++;
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  // zustand-persist reads `window.localStorage`; the node test env has no
  // window, so hand it a minimal one carrying only this in-memory storage.
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  return { storage, writes };
});

vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

const { writeSpeakerNames } = vi.hoisted(() => ({ writeSpeakerNames: vi.fn() }));
vi.mock("./speakers/namesCache", async (orig) => ({
  ...(await orig<typeof import("./speakers/namesCache")>()),
  writeSpeakerNames,
}));

import { useStore } from "./store";
import { seg, replaySession } from "./test/fixtures";
import type { HistoryEntry } from "./history/types";
import type { TimelineEvent } from "./types";

type Plain = Record<string, unknown>;

function plainState(): Plain {
  const out: Plain = {};
  for (const [k, v] of Object.entries(useStore.getState())) {
    if (typeof v !== "function") out[k] = v;
  }
  return out;
}

const json = (v: unknown) => JSON.stringify(v);

/** Changed top-level fields; `settings` is diffed one level deeper. */
function diff(prev: Plain, next: Plain): Plain {
  const out: Plain = {};
  for (const k of Object.keys(next)) {
    if (json(prev[k]) === json(next[k])) continue;
    if (k === "settings") {
      const p = prev[k] as Plain;
      const n = next[k] as Plain;
      const sub: Plain = {};
      for (const sk of Object.keys(n)) if (json(p[sk]) !== json(n[sk])) sub[sk] = n[sk];
      out[k] = sub;
    } else {
      out[k] = next[k];
    }
  }
  return out;
}

const hash = (s: string | null) => (s == null ? null : createHash("sha256").update(s).digest("hex").slice(0, 16));

function finding(id: string, atMs: number): TimelineEvent {
  return { id, atMs, side: "them", severity: "warn", source: "extra", title: `t-${id}`, detail: "d" };
}

let uuid = 0;
let now = 1_700_000_000_000;

beforeAll(() => {
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `uuid-${++uuid}` as `${string}-${string}-${string}-${string}-${string}`);
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

type Step = [name: string, run: (s: ReturnType<typeof useStore.getState>) => void];

const session = replaySession(
  [seg({ id: "r1", source: "them", speaker: 1, text: "hello", startMs: 0, endMs: 1000 }),
   seg({ id: "r2", source: "me", speaker: 0, text: "um yes", startMs: 2000, endMs: 3000 })],
  { speakerNames: { "them-1": "Alice" }, speechRateHz: 3.2 },
);

const entry: HistoryEntry = {
  id: "h-1",
  title: "Saved",
  source: "upload",
  createdAt: 5,
  durationMs: 60_000,
  segments: session.segments,
  speakerNames: { "them-1": "Bob" },
  findings: [finding("f1", 500), finding("f2", 2500)],
  actionItems: [{ id: "a1", text: "do", done: false, linkedEventId: "f1", atMs: 500 }],
  analyzed: true,
  meetingContext: "ctx",
  meetingBatna: "b",
  meetingTarget: "t",
  meetingFloor: "f",
  audio: "audio.ogg",
  folderId: "fold-1",
  brief: "brief text",
  meetingKind: "sales",
  filingSuggestion: { title: "T", folders: [] },
} as unknown as HistoryEntry;

const STEPS: Step[] = [
  ["setMeetingContext", (s) => s.setMeetingContext("Quarterly review")],
  ["setNegotiationField", (s) => s.setNegotiationField("meetingBatna", "walk")],
  ["setMeetingFolder", (s) => s.setMeetingFolder("folder-a")],
  ["setMeetingOrgShare", (s) => s.setMeetingOrgShare({ orgId: "o1", folderId: null, mode: "copy" })],
  ["addTodo", (s) => s.addTodo("  first  ")],
  ["addTodo blank", (s) => s.addTodo("   ")],
  ["applyTodoTemplate", (s) => s.applyTodoTemplate(["a", " ", "b "])],
  ["toggleTodo", (s) => s.toggleTodo(useStore.getState().todos[0].id)],
  ["markTodosDone", (s) => s.markTodosDone([useStore.getState().todos[1].id])],
  ["removeTodo", (s) => s.removeTodo(useStore.getState().todos[0].id)],
  ["openLibrary", (s) => s.openLibrary({ kind: "voice" })],
  ["openHome", (s) => s.openHome()],
  ["showReplay without replay", (s) => s.showReplay()],
  ["setHighlightMs", (s) => s.setHighlightMs(1234)],
  ["setAutoAnalyze", (s) => s.setAutoAnalyze(true)],
  ["setAutoAnalyzeSec low", (s) => s.setAutoAnalyzeSec(5)],
  ["setAutoAnalyzeSec 0", (s) => s.setAutoAnalyzeSec(0)],
  ["startMeeting", (s) => s.startMeeting()],
  ["openHome during meeting", (s) => s.openHome()],
  ["openLibrary during meeting", (s) => s.openLibrary({ kind: "voice" })],
  ["resetPrep during meeting", (s) => s.resetPrep()],
  ["upsertSegment me filler", (s) => s.upsertSegment(seg({ id: "m1", source: "me", speaker: 0, text: "um uh so" }))],
  ["upsertSegment me grow", (s) => s.upsertSegment(seg({ id: "m1", source: "me", speaker: 0, text: "um so" }))],
  ["upsertSegment them", (s) => s.upsertSegment(seg({ id: "t1", source: "them", speaker: 1, text: "嗯 對", startMs: 1000, endMs: 2000 }))],
  ["setProsody", (s) => s.setProsody({ f0Hz: 1, pitchVarSemitones: 2, monotonyScore: 0.1, speechRateHz: 3, sessionRateHz: 4, voicedRatio: 0.5, silenceMs: 0 } as never)],
  ["setProsody zero session", (s) => s.setProsody({ f0Hz: 1, pitchVarSemitones: 2, monotonyScore: 0.1, speechRateHz: 3, sessionRateHz: 0, voicedRatio: 0.5, silenceMs: 0 } as never)],
  ["pushDeliveryNudge", (s) => s.pushDeliveryNudge({ kind: "pace", message: "slow", severity: "info" } as never)],
  ["clearDeliveryNudge", (s) => s.clearDeliveryNudge()],
  ["setSystemAudioWarning", (s) => s.setSystemAudioWarning(true)],
  ["reportTranscriptionLink live unknown", (s) => s.reportTranscriptionLink("mix", "live")],
  ["reportTranscriptionLink reconnecting me", (s) => s.reportTranscriptionLink("me", "reconnecting")],
  ["reportTranscriptionLink reconnecting me again", (s) => s.reportTranscriptionLink("me", "reconnecting")],
  ["reportTranscriptionLink reconnecting them", (s) => s.reportTranscriptionLink("them", "reconnecting")],
  ["reportTranscriptionLink live me", (s) => s.reportTranscriptionLink("me", "live")],
  ["pauseMeeting", (s) => { now += 1000; s.pauseMeeting(); }],
  ["setProsody while paused", (s) => s.setProsody({ f0Hz: 9, pitchVarSemitones: 9, monotonyScore: 0.9, speechRateHz: 9, sessionRateHz: 9, voicedRatio: 0.9, silenceMs: 0 } as never)],
  ["pauseMeeting again", (s) => s.pauseMeeting()],
  ["resumeMeeting", (s) => { now += 5000; s.resumeMeeting(); }],
  ["resumeMeeting again", (s) => s.resumeMeeting()],
  ["setSpeakerName live", (s) => s.setSpeakerName("them-1", "  Carol ")],
  ["setFindings", (s) => s.setFindings([finding("x1", 100), finding("x2", 50)])],
  ["setSelectedFinding", (s) => s.setSelectedFinding("x1")],
  ["setSolutionFinding", (s) => s.setSolutionFinding("x2")],
  ["setFindingSolution", (s) => s.setFindingSolution("x2", { status: "running" } as never)],
  ["setFindings keeps surviving", (s) => s.setFindings([finding("x2", 50), finding("x3", 70)])],
  ["addFinding", (s) => s.addFinding(finding("x4", 60))],
  ["addFinding collide", (s) => s.addFinding(finding("x4", 10))],
  ["updateFinding", (s) => s.updateFinding("x3", { title: "edited", id: "nope" } as never)],
  ["removeFinding", (s) => s.removeFinding("x2")],
  ["setAnalysisStatus", (s) => s.setAnalysisStatus("running")],
  ["setAnalysisError", (s) => s.setAnalysisError("boom")],
  ["setActionItems", (s) => s.setActionItems([{ id: "ai1", text: "x", done: false, linkedEventId: null, atMs: 30 }, { id: "ai2", text: "y", done: false, linkedEventId: null, atMs: null }] as never)],
  ["toggleActionItem", (s) => s.toggleActionItem("ai1")],
  ["setActionItemsStatus", (s) => s.setActionItemsStatus("done")],
  ["setActionItemsError", (s) => s.setActionItemsError("err")],
  ["setDeliveryAssessment", (s) => s.setDeliveryAssessment({ tone: "calm", toneEvidence: "", fillers: {}, summary: "ok" } as never)],
  ["setDeliveryStatus", (s) => s.setDeliveryStatus("done")],
  ["setBrief", (s) => s.setBrief("b1")],
  ["appendBrief", (s) => s.appendBrief(" more")],
  ["setBriefStatus", (s) => s.setBriefStatus("done")],
  ["setMeetingKind", (s) => s.setMeetingKind("sales" as never)],
  ["setFilingSuggestion", (s) => s.setFilingSuggestion({ title: "F", folders: [] })],
  ["setFilingStatus", (s) => s.setFilingStatus("done")],
  ["setStudyTab", (s) => s.setStudyTab("replay")],
  ["setFinalizingMeeting", (s) => s.setFinalizingMeeting(true)],
  ["stopMeeting", (s) => s.stopMeeting()],
  ["reportTranscriptionLink after stop", (s) => s.reportTranscriptionLink("me", "reconnecting")],
  ["setProsody after stop", (s) => s.setProsody({ f0Hz: 1, pitchVarSemitones: 1, monotonyScore: 1, speechRateHz: 1, sessionRateHz: 1, voicedRatio: 1, silenceMs: 0 } as never)],
  ["setProsody null", (s) => s.setProsody(null)],
  ["resetPrep after stop", (s) => s.resetPrep()],
  ["clearTranscript", (s) => s.clearTranscript()],
  ["enterReplay", (s) => s.enterReplay(session)],
  ["upsertSegment in study ignored", (s) => s.upsertSegment(seg({ id: "z", source: "me", text: "um" }))],
  ["setSpeakerName replay", (s) => s.setSpeakerName("them-1", "Dana")],
  ["setSpeakerName replay clear", (s) => s.setSpeakerName("them-1", "  ")],
  ["setReplayPlayhead negative", (s) => s.setReplayPlayhead(-50)],
  ["setReplayPlayhead", (s) => s.setReplayPlayhead(1500)],
  ["bumpReplaySeek", (s) => s.bumpReplaySeek()],
  ["setReplayTrim", (s) => s.setReplayTrim({ startMs: 40, endMs: 80 })],
  ["setFindings for trim", (s) => s.setFindings([finding("y1", 10), finding("y2", 50), finding("y3", 90)])],
  ["select y1", (s) => s.setSelectedFinding("y1")],
  ["solution y2", (s) => s.setSolutionFinding("y2")],
  ["setActionItems for trim", (s) => s.setActionItems([{ id: "b1", text: "x", done: false, linkedEventId: null, atMs: 10 }, { id: "b2", text: "y", done: false, linkedEventId: null, atMs: 60 }, { id: "b3", text: "z", done: false, linkedEventId: null, atMs: null }] as never)],
  ["dropFindingsOutsideTrim", (s) => s.dropFindingsOutsideTrim()],
  ["setReplayTrim null", (s) => s.setReplayTrim(null)],
  ["dropFindingsOutsideTrim no trim", (s) => s.dropFindingsOutsideTrim()],
  ["setLoadedHistoryId", (s) => s.setLoadedHistoryId("loaded-1")],
  ["setReplayFolderId", (s) => s.setReplayFolderId("rf")],
  ["renameReplay", (s) => s.renameReplay("Renamed")],
  ["openIngestWizard", (s) => s.openIngestWizard("/a.wav")],
  ["setIngestWizardStep", (s) => s.setIngestWizardStep("trim")],
  ["setIngestWizardStep error", (s) => s.setIngestWizardStep("error", "bad")],
  ["closeIngestWizard", (s) => s.closeIngestWizard()],
  ["openTranscriptImport", (s) => s.openTranscriptImport(["/a.txt"])],
  ["openTranscriptImport folder", (s) => s.openTranscriptImport(["/b.txt"], "fx")],
  ["closeTranscriptImport", (s) => s.closeTranscriptImport()],
  ["openHome from study", (s) => s.openHome()],
  ["showReplay", (s) => s.showReplay()],
  ["loadHistory", (s) => s.loadHistory(entry, session)],
  ["loadHistory readOnly", (s) => s.loadHistory(entry, session, { readOnly: true })],
  ["exitReplay", (s) => s.exitReplay()],
  ["renameReplay without replay", (s) => s.renameReplay("x")],
  ["updateSettings plain", (s) => s.updateSettings({ userName: "Ann", layout: "transcript" })],
  ["updateSettings same language", (s) => s.updateSettings({ language: "zh-TW" })],
  ["updateSettings language en", (s) => s.updateSettings({ language: "en" })],
  ["updateSettings evaluations", (s) => s.updateSettings({ evaluations: useStore.getState().settings.evaluations.slice(0, 2) })],
  ["applySettings", (s) => s.applySettings({ ...useStore.getState().settings, userRole: "PM" })],
  ["updateSettings parley stt", (s) => s.updateSettings({ transcriptionProvider: "parley" as never })],
  ["setCloudAuth signed in", (s) => s.setCloudAuth({ token: "t", email: "e@x" } as never)],
  ["setCloudAuth signed out", (s) => s.setCloudAuth(null)],
  ["setCloudAuth signed out again", (s) => s.setCloudAuth(null)],
  ["startMeeting from home", (s) => s.startMeeting()],
  ["cancelMeeting", (s) => s.cancelMeeting()],
];

describe("store action trace", () => {
  it("every action changes exactly what it did before, and persists the same bytes", async () => {
    const trace: Plain[] = [];
    let prev = plainState();
    let prevPersisted = storage.getItem("parley-settings");
    for (const [name, run] of STEPS) {
      writes.count = 0;
      writeSpeakerNames.mockClear();
      run(useStore.getState());
      // The speaker-name cache write is a dynamic import: let it land.
      await vi.dynamicImportSettled();
      await new Promise((r) => setTimeout(r, 0));
      const next = plainState();
      const persisted = storage.getItem("parley-settings");
      trace.push({
        step: name,
        changed: diff(prev, next),
        persistWrites: writes.count,
        persisted: persisted === prevPersisted ? "unchanged" : hash(persisted),
        speakerNameWrites: writeSpeakerNames.mock.calls,
      });
      prev = next;
      prevPersisted = persisted;
    }
    expect(trace).toMatchSnapshot();
  });

  it("writes the persisted payload byte-identically for a fixed input", () => {
    useStore.getState().applySettings({ ...useStore.getState().settings, userName: "Fixed", language: "en" });
    useStore.getState().setCloudAuth({ token: "tok", email: "a@b" } as never);
    expect(storage.getItem("parley-settings")).toMatchSnapshot();
  });

  it("rehydrates a fixed persisted payload into the same state and bytes", async () => {
    storage.setItem(
      "parley-settings",
      JSON.stringify({
        state: {
          settings: { onboarded: true, language: "en", userName: "Old", provider: "openai", voiceTypingPolish: false, layout: "classic" },
          cloudAuth: { token: "x", email: "y" },
        },
        version: 3,
      }),
    );
    await useStore.persist.rehydrate();
    const s = useStore.getState();
    expect({ settings: s.settings, evaluations: s.evaluations, cloudAuth: s.cloudAuth }).toMatchSnapshot();
    expect(storage.getItem("parley-settings")).toMatchSnapshot();
  });
});
