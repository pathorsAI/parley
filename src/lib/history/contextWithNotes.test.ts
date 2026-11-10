import { describe, expect, it } from "vitest";
import { contextWithNotes, contextWithoutNotes, meetingNotesOf, notesFromContext } from "./meetingNotes";

describe("contextWithNotes", () => {
  it("leaves the context alone when no notes were taken", () => {
    expect(contextWithNotes("背景", "  ", "筆記：")).toBe("背景");
  });

  it("adds the notes under a heading after the context", () => {
    expect(contextWithNotes("背景", "週末不打", "筆記：")).toBe("背景\n\n筆記：\n週末不打");
  });

  it("is just the notes when there was no context", () => {
    expect(contextWithNotes("", "週末不打", "筆記：")).toBe("筆記：\n週末不打");
  });
});

describe("notesFromContext", () => {
  const headings = ["會議中的筆記：", "Notes taken during the meeting:"];

  it("reads back what contextWithNotes wrote, with or without a context", () => {
    expect(notesFromContext(contextWithNotes("背景", "週末不打\n下週再聯絡", headings[0]), headings)).toBe(
      "週末不打\n下週再聯絡",
    );
    expect(notesFromContext(contextWithNotes("", "call back", headings[1]), headings)).toBe("call back");
  });

  it("is empty when the context carries no notes", () => {
    expect(notesFromContext("背景", headings)).toBe("");
    expect(notesFromContext("", headings)).toBe("");
    // The heading only counts as a line of its own, not inside a sentence.
    expect(notesFromContext("看一下會議中的筆記：沒有", headings)).toBe("");
  });

  it("finds notes saved under either language's heading", () => {
    expect(meetingNotesOf("背景\n\n會議中的筆記：\n週末不打")).toBe("週末不打");
    expect(meetingNotesOf("Notes taken during the meeting:\ncall back")).toBe("call back");
    expect(meetingNotesOf(null)).toBe("");
  });

  it("takes the last heading when the context mentions it earlier", () => {
    const ctx = contextWithNotes("會議中的筆記：\n舊的", "新的", headings[0]);
    expect(notesFromContext(ctx, headings)).toBe("新的");
  });
});

describe("contextWithoutNotes", () => {
  const heading = "## 會議中筆記";
  it("leaves the prepared context and drops the notes after it", () => {
    const saved = contextWithNotes("對方是王經理", "週五給名單", heading);
    expect(contextWithoutNotes(saved, [heading])).toBe("對方是王經理");
  });
  it("is empty when the context was only notes", () => {
    expect(contextWithoutNotes(contextWithNotes("", "週五給名單", heading), [heading])).toBe("");
  });
  it("keeps a context without notes whole", () => {
    expect(contextWithoutNotes("對方是王經理", [heading])).toBe("對方是王經理");
  });
});
