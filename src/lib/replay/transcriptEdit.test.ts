import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
const persistTranscriptText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../history/history", () => ({ persistTranscriptText }));
const addEntry = vi.hoisted(() => vi.fn((_input: unknown) => ({ kind: "entry", entryId: "d1" })));
vi.mock("../dictionary", () => ({ addEntry, whenDictionaryReady: async () => {} }));

import { useStore } from "../store";
import { seg, replaySession } from "../test/fixtures";
import {
  editChangeVars,
  redoTranscriptEdit,
  replaceInTranscript,
  resetTranscriptHistory,
  teachReplacement,
  undoTranscriptEdit,
} from "./transcriptEdit";

const INITIAL = useStore.getInitialState();
const LINES = [seg({ id: "a", text: "東昇 said hi" }), seg({ id: "b", text: "bye 東昇, 東昇" })];

function open(opts: { entryId?: string | null; readOnly?: boolean } = {}) {
  useStore.setState({
    appMode: "study",
    replay: replaySession(LINES),
    segments: LINES,
    loadedHistoryId: opts.entryId === undefined ? "e1" : opts.entryId,
    replayReadOnly: !!opts.readOnly,
  });
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  resetTranscriptHistory();
  persistTranscriptText.mockClear();
  addEntry.mockClear();
});

describe("replaceInTranscript", () => {
  it("rewrites both transcript copies, marks the recording edited, and saves the entry", () => {
    open();
    expect(replaceInTranscript("東昇", "東森")).toBe(3);
    const s = useStore.getState();
    expect(s.segments.map((x) => x.text)).toEqual(["東森 said hi", "bye 東森, 東森"]);
    expect(s.replay!.segments.map((x) => x.text)).toEqual(["東森 said hi", "bye 東森, 東森"]);
    expect(s.transcriptEditedId).toBe("rec-1");
    expect(persistTranscriptText).toHaveBeenCalledWith("e1", s.segments);
  });

  it("replaces only the given line", () => {
    open();
    expect(replaceInTranscript("東昇", "東森", { onlySegmentId: "b" })).toBe(2);
    expect(useStore.getState().segments.map((x) => x.text)).toEqual(["東昇 said hi", "bye 東森, 東森"]);
  });

  it("writes nothing when nothing changes", () => {
    open();
    expect(replaceInTranscript("nope", "x")).toBe(0);
    expect(replaceInTranscript("東昇", "東昇")).toBe(0);
    expect(useStore.getState().segments).toBe(LINES);
    expect(useStore.getState().transcriptEditedId).toBeNull();
    expect(persistTranscriptText).not.toHaveBeenCalled();
  });

  it("leaves a not-yet-saved upload to its first save", () => {
    open({ entryId: null });
    expect(replaceInTranscript("東昇", "東森")).toBe(3);
    expect(persistTranscriptText).not.toHaveBeenCalled();
  });

  it("refuses a read-only org recording", () => {
    open({ entryId: null, readOnly: true });
    expect(replaceInTranscript("東昇", "東森")).toBe(0);
    expect(useStore.getState().segments).toBe(LINES);
  });

  it("forgets the edit when another recording opens", () => {
    open();
    replaceInTranscript("東昇", "東森");
    useStore.getState().enterReplay(replaySession(LINES, { id: "rec-2" }));
    expect(useStore.getState().transcriptEditedId).toBeNull();
  });
});

describe("teachReplacement", () => {
  it("adds the fixed word with the misheard one as a variant", async () => {
    await teachReplacement(" 東昇 ", "東森 ");
    expect(addEntry).toHaveBeenCalledWith({ phrase: "東森 ", variants: ["東昇"], source: "correction" });
  });

  it("adds no variant for a case-only fix", async () => {
    await teachReplacement("parley", "Parley");
    expect(addEntry).toHaveBeenCalledWith({ phrase: "Parley", variants: [], source: "correction" });
  });
});

describe("undo / redo of transcript edits", () => {
  const texts = () => useStore.getState().segments.map((x) => x.text);

  it("undoes replaces one at a time, newest first, and saves each step", () => {
    open();
    replaceInTranscript("東昇", "東森", { onlySegmentId: "a" });
    replaceInTranscript("bye", "再見");
    expect(undoTranscriptEdit()).toEqual({ from: "再見", to: "bye" });
    expect(texts()).toEqual(["東森 said hi", "bye 東昇, 東昇"]);
    expect(undoTranscriptEdit()).toEqual({ from: "東森", to: "東昇" });
    expect(texts()).toEqual(["東昇 said hi", "bye 東昇, 東昇"]);
    expect(undoTranscriptEdit()).toBeNull();
    expect(persistTranscriptText).toHaveBeenLastCalledWith("e1", useStore.getState().segments);
  });

  it("redoes what was undone, until a new edit forks the history", () => {
    open();
    replaceInTranscript("東昇", "東森");
    undoTranscriptEdit();
    expect(redoTranscriptEdit()).toEqual({ from: "東昇", to: "東森" });
    expect(texts()).toEqual(["東森 said hi", "bye 東森, 東森"]);
    undoTranscriptEdit();
    replaceInTranscript("hi", "hello");
    expect(redoTranscriptEdit()).toBeNull();
  });

  it("does not carry one recording's history into another", () => {
    open();
    replaceInTranscript("東昇", "東森");
    useStore.getState().enterReplay(replaySession(LINES, { id: "rec-2" }));
    expect(undoTranscriptEdit()).toBeNull();
  });

  it("does nothing on a read-only recording", () => {
    open();
    replaceInTranscript("東昇", "東森");
    useStore.setState({ replayReadOnly: true });
    expect(undoTranscriptEdit()).toBeNull();
  });
});

describe("editChangeVars", () => {
  it("names an empty side instead of leaving a dangling arrow", () => {
    expect(editChangeVars("zh-TW", { from: "party", to: "parley" })).toEqual({ from: "party", to: "parley" });
    expect(editChangeVars("zh-TW", { from: "嗯", to: "" })).toEqual({ from: "嗯", to: "（空白）" });
  });
});
