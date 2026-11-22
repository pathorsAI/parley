import { describe, expect, it } from "vitest";
import { seg } from "../test/fixtures";
import type { TodoItem, TranscriptSegment } from "../types";
import {
  AGENDA_OVERLAP_LINES,
  commitAgendaCheck,
  createAgendaCursor,
  cursorForMeeting,
  planAgendaCheck,
} from "./agendaDelta";

const render = (s: TranscriptSegment) => s.text;
const item = (id: string, text = `item ${id}`): TodoItem => ({ id, text, done: false });
const line = (n: number, text = `line ${n}`) => seg({ id: `s${n}`, text, startMs: n * 1000, endMs: n * 1000 + 900 });
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const ids = (xs: readonly TranscriptSegment[]) => xs.map((s) => s.id);

describe("planAgendaCheck", () => {
  it("sends everything said on the first pass, without context", () => {
    const plan = planAgendaCheck(createAgendaCursor("m1"), lines(1, 3), [item("a")], render);
    expect(ids(plan!.fresh)).toEqual(["s1", "s2", "s3"]);
    expect(plan!.context).toEqual([]);
  });

  it("after a committed pass, sends only the new lines behind a few already-checked ones", () => {
    const cursor = createAgendaCursor("m1");
    const open = [item("a")];
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 10), open, render)!);
    const plan = planAgendaCheck(cursor, lines(1, 12), open, render);
    expect(ids(plan!.fresh)).toEqual(["s11", "s12"]);
    expect(ids(plan!.context)).toEqual(["s7", "s8", "s9", "s10"]);
    expect(plan!.context).toHaveLength(AGENDA_OVERLAP_LINES);
  });

  it("returns null when nothing final was said since the last pass", () => {
    const cursor = createAgendaCursor("m1");
    const open = [item("a")];
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 3), open, render)!);
    const interim = seg({ id: "s4", text: "still talk", isFinal: false, startMs: 4000 });
    const blank = seg({ id: "s5", text: "  ", startMs: 5000 });
    expect(planAgendaCheck(cursor, [...lines(1, 3), interim, blank], open, render)).toBeNull();
  });

  it("returns null when no item is open", () => {
    expect(planAgendaCheck(createAgendaCursor("m1"), lines(1, 3), [], render)).toBeNull();
  });

  it("keeps the unsent lines when a pass is not committed (the call failed)", () => {
    const cursor = createAgendaCursor("m1");
    const open = [item("a")];
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 2), open, render)!);
    planAgendaCheck(cursor, lines(1, 4), open, render); // failed: never committed
    const retry = planAgendaCheck(cursor, lines(1, 5), open, render);
    expect(ids(retry!.fresh)).toEqual(["s3", "s4", "s5"]);
  });

  it("caps a backlog at the newest lines that fit, and consumes the trimmed ones too", () => {
    const cursor = createAgendaCursor("m1");
    const segs = Array.from({ length: 10 }, (_, i) => seg({ id: `s${i}`, text: "x".repeat(9), startMs: i * 1000 }));
    const plan = planAgendaCheck(cursor, segs, [item("a")], render, 30); // 10 chars per line
    expect(ids(plan!.fresh)).toEqual(["s7", "s8", "s9"]);
    expect(ids(plan!.context)).toEqual(["s3", "s4", "s5", "s6"]);
    commitAgendaCheck(cursor, plan!);
    expect(planAgendaCheck(cursor, segs, [item("a")], render, 30)).toBeNull();
  });

  it("always sends the newest line even when it alone exceeds the budget", () => {
    const plan = planAgendaCheck(createAgendaCursor(), [seg({ text: "y".repeat(50) })], [item("a")], render, 10);
    expect(plan!.fresh).toHaveLength(1);
  });

  it("re-reads earlier speech when the agenda gains an item", () => {
    const cursor = createAgendaCursor("m1");
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 5), [item("a")], render)!);
    const plan = planAgendaCheck(cursor, lines(1, 6), [item("a"), item("b")], render);
    expect(ids(plan!.fresh)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("stays on the delta when items only leave the open list", () => {
    const cursor = createAgendaCursor("m1");
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 5), [item("a"), item("b")], render)!);
    const plan = planAgendaCheck(cursor, lines(1, 6), [item("b")], render);
    expect(ids(plan!.fresh)).toEqual(["s6"]);
  });

  it("treats a final line the recognizer rewrote as new", () => {
    const cursor = createAgendaCursor("m1");
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 3), [item("a")], render)!);
    const plan = planAgendaCheck(cursor, [...lines(1, 2), line(3, "line 3, corrected")], [item("a")], render);
    expect(ids(plan!.fresh)).toEqual(["s3"]);
  });
});

describe("cursorForMeeting", () => {
  it("keeps the cursor through a resume of the same meeting and starts over for a new one", () => {
    const cursor = createAgendaCursor("m1");
    commitAgendaCheck(cursor, planAgendaCheck(cursor, lines(1, 3), [item("a")], render)!);
    expect(cursorForMeeting(cursor, "m1")).toBe(cursor);
    const next = cursorForMeeting(cursor, "m2");
    expect(next).not.toBe(cursor);
    expect(next.checked.size).toBe(0);
    expect(next.askedItems).toBeNull();
    expect(cursorForMeeting(null, "m1").meetingId).toBe("m1");
  });
});
