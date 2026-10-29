import { describe, expect, it } from "vitest";
import { contextWithNotes } from "./history";

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
