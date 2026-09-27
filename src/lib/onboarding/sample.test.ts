import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Boundaries: Tauri IPC, the event bus (history emits `history://updated`), the
// logger, and toasts. The mapping, idempotency and question lookup are ours.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), message: vi.fn(), success: vi.fn() } }));

import {
  buildSampleEntry,
  isSampleEntry,
  loadSampleRecording,
  recentFolders,
  sampleFilingSuggestion,
  sampleManifest,
  sampleQuestions,
} from "./sample";
import { evaluateStages, factsOf } from "../analysis/studyPipeline";
import type { SampleManifest } from "./sample";
import { speakerLabel, useStore } from "../store";
import type { HistoryEntry } from "../history/types";

const INITIAL = useStore.getState();
const REPO = path.resolve(__dirname, "..", "..", "..");
const fetchMock = vi.fn();

/** Route the IPC calls loadSampleRecording makes; `library` is what list_history returns. */
function routeInvoke(library: { id: string }[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_history") return library.map((e) => JSON.stringify({ createdAt: 0, ...e }));
    return undefined;
  });
}

function savedMeta(): HistoryEntry {
  const call = invoke.mock.calls.find((c) => c[0] === "save_history_entry");
  if (!call) throw new Error("save_history_entry was not invoked");
  return JSON.parse((call[1] as { metaJson: string }).metaJson) as HistoryEntry;
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  invoke.mockReset();
  toastError.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("buildSampleEntry (manifest → library entry)", () => {
  it("keys the user's side as the primary mic voice and names both speakers", () => {
    const m = sampleManifest("zh-TW");
    const entry = buildSampleEntry(m, 1234);

    expect(entry.speakerNames).toEqual({ "me-1": "你", "them-1": "林經理" });
    const [first, second] = entry.segments;
    expect(first).toMatchObject({ source: "me", speaker: 1, isFinal: true });
    expect(second).toMatchObject({ source: "them", speaker: 1 });
    expect(speakerLabel(first, entry.speakerNames)).toBe("你");
    expect(speakerLabel(second, entry.speakerNames)).toBe("林經理");
  });

  it("carries durations, timestamps and the upload-shaped defaults", () => {
    const m = sampleManifest("en");
    const entry = buildSampleEntry(m, 42);

    expect(entry).toMatchObject({
      id: m.id,
      title: m.title,
      source: "upload",
      createdAt: 42,
      durationMs: m.durationMs,
      meetingKind: "sales",
      meetingContext: m.context,
      folderId: null,
      audio: "audio.ogg",
    });
    expect(entry.segments).toHaveLength(m.segments.length);
    expect(entry.segments.map((s) => [s.startMs, s.endMs, s.text])).toEqual(
      m.segments.map((s) => [s.startMs, s.endMs, s.text]),
    );
    expect(new Set(entry.segments.map((s) => s.id)).size).toBe(entry.segments.length);
    expect(isSampleEntry(entry)).toBe(true);
  });

  it("arrives already analysed: brief, findings and action items from the manifest", () => {
    const m = sampleManifest("zh-TW");
    const entry = buildSampleEntry(m, 0);

    expect(entry.analyzed).toBe(true);
    expect(entry.brief).toBe(m.brief);
    expect(entry.findings).toHaveLength(m.findings.length);
    entry.findings.forEach((f, i) => {
      expect(f).toEqual({
        id: `sample-f-${i}`,
        source: "extra",
        atMs: m.findings[i].atMs,
        side: m.findings[i].side,
        severity: m.findings[i].severity,
        title: m.findings[i].title,
        detail: m.findings[i].detail,
        quotes: m.findings[i].quotes,
      });
    });
    expect(entry.actionItems).toHaveLength(m.actionItems.length);
    for (const [i, a] of entry.actionItems.entries()) {
      expect(a).toMatchObject({ text: m.actionItems[i].text, atMs: m.actionItems[i].atMs, done: false, linkedEventId: null });
    }
    expect(new Set(entry.actionItems.map((a) => a.id)).size).toBe(entry.actionItems.length);
  });

  it("arrives already suggested: the manifest title and a new folder", () => {
    const m = sampleManifest("zh-TW");
    const entry = buildSampleEntry(m, 0);

    expect(entry.filingSuggested).toBe(true);
    expect(entry.filingSuggestion).toEqual({
      title: m.suggestion.title,
      folders: [{ folderId: null, name: "泓昇科技", reason: m.suggestion.folders[0].reason }],
    });
    expect(entry.filingSuggestion!.title).not.toBe(entry.title);
  });

  it("offers up to two existing folders after the new one, three chips at most", () => {
    const m = sampleManifest("en");
    const existing = [
      { id: "a", name: "Acme" },
      { id: "b", name: "Beta" },
      { id: "c", name: "Gamma" },
    ];
    const s = sampleFilingSuggestion(m, existing);
    expect(s.folders).toEqual([
      { folderId: null, name: m.suggestion.folders[0].name, reason: m.suggestion.folders[0].reason },
      { folderId: "a", name: "Acme", reason: "Existing folder" },
      { folderId: "b", name: "Beta", reason: "Existing folder" },
    ]);
    expect(sampleFilingSuggestion(sampleManifest("zh-TW"), existing).folders[1].reason).toBe("既有資料夾");
  });

  it("points at a folder that already carries the suggested name instead of creating it twice", () => {
    const m = sampleManifest("zh-TW");
    const s = sampleFilingSuggestion(m, [{ id: "x", name: "Other" }, { id: "hs", name: "泓昇科技" }]);
    expect(s.folders.map((f) => f.folderId)).toEqual(["hs", "x"]);
  });

  it("orders existing folders by most recent use, skipping archived ones", () => {
    const folders = [
      { id: "old", name: "Old", createdAt: 1 },
      { id: "used", name: "Used", createdAt: 2 },
      { id: "fresh", name: "Fresh", createdAt: 5 },
      { id: "gone", name: "Gone", createdAt: 9, archivedAt: 10 },
    ];
    const library = [
      { folderId: "old", createdAt: 100 },
      { folderId: "used", createdAt: 300 },
      { folderId: "gone", createdAt: 999 },
      { folderId: null, createdAt: 50 },
    ];
    expect(recentFolders(folders, library).map((f) => f.id)).toEqual(["used", "old", "fresh"]);
  });

  it("does not send the study pipeline after the sample once it is open", () => {
    const m = sampleManifest("zh-TW");
    const entry = buildSampleEntry(m, 0);
    useStore.getState().updateSettings({ autoStudyAnalysis: true });
    useStore.getState().loadHistory(entry, {
      id: entry.id,
      name: entry.title,
      audioPath: "",
      audioSrc: "",
      durationMs: entry.durationMs,
      audioOffsetMs: 0,
      createdAt: 0,
      segments: entry.segments,
      speakerNames: entry.speakerNames,
      speechRateHz: null,
    });
    const s = useStore.getState();
    expect(s.analysisStatus).toBe("done");
    expect(s.actionItemsStatus).toBe("done");
    expect(s.briefStatus).toBe("done");
    expect(s.filingStatus).toBe("done");
    expect(s.filingSuggestion?.title).toBe(m.suggestion.title);
    // Even with every key present and auto-analysis on, nothing runs — not even
    // the delivery read, the one output the manifest doesn't carry.
    const facts = { ...factsOf(s), hasDeepKey: true, hasRealtimeKey: true };
    expect(facts.autoAnalyze).toBe(false);
    expect(evaluateStages(facts)).toEqual([]);
    // A manual regenerate on the sample is still the user's call.
    useStore.setState({ studyManualForId: entry.id });
    expect(factsOf(useStore.getState()).autoAnalyze).toBe(true);
  });

  it("drops a meeting kind the app doesn't know rather than saving it", () => {
    const m: SampleManifest = { ...sampleManifest("en"), meetingKind: "podcast" };
    expect(buildSampleEntry(m, 0).meetingKind).toBeNull();
  });
});

describe("loadSampleRecording", () => {
  it("writes audio first, then meta + summary, for the current language", async () => {
    useStore.getState().updateSettings({ language: "en" });
    routeInvoke([]);

    const id = await loadSampleRecording();

    expect(id).toBe(sampleManifest("en").id);
    expect(fetchMock).toHaveBeenCalledWith("/sample/sample-en.ogg");
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds.indexOf("write_sample_audio")).toBeLessThan(cmds.indexOf("save_history_entry"));
    const audioCall = invoke.mock.calls.find((c) => c[0] === "write_sample_audio")!;
    expect(audioCall[1]).toBeInstanceOf(Uint8Array);
    expect(audioCall[2]).toEqual({ headers: { "x-entry-id": id } });
    expect(savedMeta()).toMatchObject({
      id,
      source: "upload",
      speakerNames: { "me-1": "You", "them-1": "Mr. Lin" },
      analyzed: true,
      filingSuggested: true,
    });
    expect(useStore.getState().settings.gettingStarted.recorded).toBe(true);
  });

  it("does not duplicate a sample already in the library", async () => {
    const zh = sampleManifest("zh-TW");
    routeInvoke([{ id: "other" }, { id: zh.id }]);

    const id = await loadSampleRecording();

    expect(id).toBe(zh.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["list_history"]);
  });

  it("toasts and returns null when the audio can't be fetched", async () => {
    routeInvoke([]);
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    expect(await loadSampleRecording()).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("save_history_entry");
  });

  it("is unavailable outside Tauri", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await loadSampleRecording()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("sampleQuestions", () => {
  it("returns each language's in-app and MCP questions", () => {
    const zh = sampleQuestions("zh-TW");
    const en = sampleQuestions("en");
    expect(zh.questions[0]).toContain("林經理");
    expect(en.questions[0]).toContain("Mr. Lin");
    expect(zh.mcpQuestions).toHaveLength(3);
    expect(en.mcpQuestions).toHaveLength(3);
    expect(en.mcpQuestions[0]).toContain("Parley");
  });
});

describe("rendered sample manifests", () => {
  for (const lang of ["zh-TW", "en"] as const) {
    it(`public/sample/sample.${lang}.json parses, has 17 ordered segments, and matches the bundled copy`, () => {
      const file = path.join(REPO, "public", "sample", `sample.${lang}.json`);
      const m = JSON.parse(fs.readFileSync(file, "utf8")) as SampleManifest;

      expect(m.lang).toBe(lang);
      expect(m.id.startsWith("sample-")).toBe(true);
      expect(fs.existsSync(path.join(REPO, "public", "sample", m.audio))).toBe(true);
      expect(m.segments).toHaveLength(17);
      let prevEnd = 0;
      for (const s of m.segments) {
        expect(s.startMs).toBeGreaterThanOrEqual(prevEnd);
        expect(s.endMs).toBeGreaterThan(s.startMs);
        prevEnd = s.endMs;
      }
      expect(m.durationMs).toBeGreaterThanOrEqual(prevEnd);
      expect(m).toEqual(sampleManifest(lang));
    });
  }
});
