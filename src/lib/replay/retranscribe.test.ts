import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-transcribing a saved recording (#680): when it may run, what it keeps and
// clears on the entry, and that a failed or empty result leaves the entry alone.
const mocks = vi.hoisted(() => ({
  transcribeRecording: vi.fn(),
  rewriteEntry: vi.fn(),
  emitHistoryUpdated: vi.fn(async () => {}),
  pushToCloud: vi.fn(async () => {}),
  loadHistoryEntry: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("./ingest", () => ({ transcribeRecording: mocks.transcribeRecording }));
vi.mock("../history/entryStore", () => ({
  rewriteEntry: mocks.rewriteEntry,
  emitHistoryUpdated: mocks.emitHistoryUpdated,
}));
vi.mock("../history/cloudPush", () => ({ pushToCloud: mocks.pushToCloud }));
vi.mock("../history/open", () => ({ loadHistoryEntry: mocks.loadHistoryEntry }));

import { useStore } from "../store";
import type { TranscriptSegment } from "../types";
import type { HistoryEntry } from "../history/types";
import type { ReplaySession } from "./types";
import { translate } from "../../i18n/messages";
import {
  carriedSpeakerNames,
  EmptyRetranscriptionError,
  retranscribeBlock,
  retranscribedEntry,
  retranscribeLoadedRecording,
} from "./retranscribe";

const seg = (id: string, speaker: number, text = "hello", source: TranscriptSegment["source"] = "them"): TranscriptSegment => ({
  id,
  source,
  speaker,
  text,
  isFinal: true,
  startMs: 0,
  endMs: 1000,
});

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "e1",
  title: "Weekly sync",
  source: "live",
  createdAt: 1,
  durationMs: 60_000,
  segments: [seg("a", 1, "old line")],
  speakerNames: { "them-1": "Alice" },
  findings: [{ id: "f1" } as HistoryEntry["findings"][number]],
  actionItems: [{ id: "x1" } as HistoryEntry["actionItems"][number]],
  analyzed: true,
  meetingContext: "Q4 budget",
  meetingBatna: "b",
  meetingTarget: "t",
  meetingFloor: "f",
  audio: "audio.ogg",
  brief: "old brief",
  briefFailed: false,
  deliveryAssessment: { summary: "x" } as HistoryEntry["deliveryAssessment"],
  folderId: "folder-1",
  meetingKind: "sales" as HistoryEntry["meetingKind"],
  speechRateHz: 3,
  ...over,
});

const freshSession = (segments: TranscriptSegment[], durationMs = 61_000): ReplaySession => ({
  id: "tmp",
  name: "audio.ogg",
  audioPath: "/entries/e1/audio.ogg",
  audioSrc: "asset:///entries/e1/audio.ogg",
  durationMs,
  createdAt: 2,
  segments,
  speakerNames: {},
  speechRateHz: 4,
});

describe("retranscribeBlock", () => {
  const ok = {
    replay: { audioPath: "/entries/e1/audio.ogg" },
    loadedHistoryId: "e1",
    replayReadOnly: false,
    meetingStatus: "stopped" as const,
  };

  it("allows an own saved recording with audio", () => {
    expect(retranscribeBlock(ok, true)).toBeNull();
  });

  it.each([
    ["not-desktop", ok, false],
    ["no-session", { ...ok, replay: null }, true],
    ["read-only", { ...ok, replayReadOnly: true }, true],
    ["read-only", { ...ok, loadedHistoryId: null }, true],
    ["no-audio", { ...ok, replay: { audioPath: "" } }, true],
    ["recording", { ...ok, meetingStatus: "recording" as const }, true],
  ])("blocks %s", (code, state, desktop) => {
    expect(retranscribeBlock(state, desktop)).toBe(code);
  });
});

describe("carriedSpeakerNames", () => {
  it("keeps names when the speakers are the same set", () => {
    expect(carriedSpeakerNames({ "them-1": "Alice", "them-2": "Bob" }, [seg("a", 1), seg("b", 2)], [seg("c", 2), seg("d", 1)])).toEqual({
      "them-1": "Alice",
      "them-2": "Bob",
    });
  });

  it("resets when the speaker count changed", () => {
    expect(carriedSpeakerNames({ "them-1": "Alice" }, [seg("a", 1)], [seg("c", 1), seg("d", 2)])).toEqual({});
  });

  it("resets when the speakers are different keys (live me/them → upload them)", () => {
    expect(carriedSpeakerNames({ "me-0": "Me" }, [seg("a", 0, "x", "me")], [seg("c", 0)])).toEqual({});
  });

  it("is empty when there were no names", () => {
    expect(carriedSpeakerNames({}, [seg("a", 1)], [seg("c", 1)])).toEqual({});
  });
});

describe("retranscribedEntry", () => {
  it("swaps the transcript and clears everything derived from the old one", () => {
    const next = retranscribedEntry(entry(), freshSession([seg("n1", 1, "new line")]));
    expect(next.segments.map((s) => s.text)).toEqual(["new line"]);
    expect(next.speakerNames).toEqual({ "them-1": "Alice" });
    expect(next.findings).toEqual([]);
    expect(next.actionItems).toEqual([]);
    expect(next.analyzed).toBe(false);
    expect(next.brief).toBeNull();
    expect(next.briefFailed).toBe(false);
    expect(next.deliveryAssessment).toBeNull();
    expect(next.durationMs).toBe(61_000);
    expect(next.speechRateHz).toBe(4);
  });

  it("keeps what the user set by hand", () => {
    const next = retranscribedEntry(entry(), freshSession([seg("n1", 1)]));
    expect(next).toMatchObject({
      id: "e1",
      title: "Weekly sync",
      source: "live",
      createdAt: 1,
      audio: "audio.ogg",
      folderId: "folder-1",
      meetingContext: "Q4 budget",
      meetingKind: "sales",
    });
  });

  it("never shortens the saved duration", () => {
    expect(retranscribedEntry(entry({ durationMs: 90_000 }), freshSession([seg("n1", 1)], 0)).durationMs).toBe(90_000);
  });
});

describe("retranscribeLoadedRecording", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.emitHistoryUpdated.mockResolvedValue(undefined);
    mocks.pushToCloud.mockResolvedValue(undefined);
    mocks.loadHistoryEntry.mockResolvedValue(undefined);
    mocks.rewriteEntry.mockImplementation(async (_id: string, change: (m: HistoryEntry) => HistoryEntry) => change(entry()));
    useStore.setState({
      replay: freshSession([]),
      loadedHistoryId: "e1",
      replayReadOnly: false,
      meetingStatus: "stopped",
      settings: { ...useStore.getState().settings, language: "en" },
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("transcribes fresh, saves, syncs and reopens", async () => {
    mocks.transcribeRecording.mockResolvedValue(freshSession([seg("n1", 1, "rescued")]));
    await retranscribeLoadedRecording();
    expect(mocks.transcribeRecording).toHaveBeenCalledWith(
      expect.anything(),
      "/entries/e1/audio.ogg",
      expect.objectContaining({ fresh: true }),
    );
    expect(mocks.rewriteEntry).toHaveBeenCalledWith("e1", expect.any(Function));
    const saved = await mocks.rewriteEntry.mock.results[0].value;
    expect(saved.segments[0].text).toBe("rescued");
    expect(mocks.emitHistoryUpdated).toHaveBeenCalledWith("e1");
    expect(mocks.pushToCloud).toHaveBeenCalledWith("e1");
    expect(mocks.loadHistoryEntry).toHaveBeenCalledWith("e1");
  });

  it("leaves the entry alone when transcription fails", async () => {
    mocks.transcribeRecording.mockRejectedValue(new Error("provider down"));
    await expect(retranscribeLoadedRecording()).rejects.toThrow("provider down");
    expect(mocks.rewriteEntry).not.toHaveBeenCalled();
    expect(mocks.pushToCloud).not.toHaveBeenCalled();
  });

  it("leaves the entry alone when the new transcript has nothing spoken", async () => {
    mocks.transcribeRecording.mockResolvedValue(freshSession([seg("n1", 1, "   ")]));
    const err = await retranscribeLoadedRecording().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyRetranscriptionError);
    expect((err as Error).message).toBe(translate("en", "replay.retranscribe.empty"));
    expect(mocks.rewriteEntry).not.toHaveBeenCalled();
  });

  it("refuses an org recording before transcribing anything", async () => {
    useStore.setState({ replayReadOnly: true, loadedHistoryId: null });
    await expect(retranscribeLoadedRecording()).rejects.toThrow(translate("en", "replay.retranscribe.block.read-only"));
    expect(mocks.transcribeRecording).not.toHaveBeenCalled();
  });

  it("doesn't yank the user back if they opened another recording meanwhile", async () => {
    mocks.transcribeRecording.mockImplementation(async () => {
      useStore.setState({ loadedHistoryId: "other" });
      return freshSession([seg("n1", 1, "rescued")]);
    });
    await retranscribeLoadedRecording();
    expect(mocks.rewriteEntry).toHaveBeenCalledWith("e1", expect.any(Function));
    expect(mocks.loadHistoryEntry).not.toHaveBeenCalled();
  });
});
