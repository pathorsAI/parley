import { describe, expect, it } from "vitest";
import { arbitrateImportPaths } from "./ingest";

// The single audio-vs-transcript arbitration rule (R7) shared by the picker and
// the window drag-drop. If this rule changes, every import door changes with it.
describe("arbitrateImportPaths", () => {
  it("audio wins over transcripts when the set mixes kinds", () => {
    expect(
      arbitrateImportPaths(["/a/notes.txt", "/a/call.m4a", "/a/more.txt"]),
    ).toEqual({ kind: "audio", path: "/a/call.m4a" });
  });

  it("an only-.txt set imports ALL of them", () => {
    expect(arbitrateImportPaths(["/a/one.txt", "/a/two.TXT"])).toEqual({
      kind: "transcript",
      paths: ["/a/one.txt", "/a/two.TXT"],
    });
  });

  it("takes the first audio file only (one file per transcription run)", () => {
    expect(arbitrateImportPaths(["/a/first.mp3", "/a/second.wav"])).toEqual({
      kind: "audio",
      path: "/a/first.mp3",
    });
  });

  it("ignores paths that are neither audio nor transcript", () => {
    expect(arbitrateImportPaths(["/a/slides.pdf", "/a/pic.png"])).toBeNull();
    expect(arbitrateImportPaths([])).toBeNull();
  });

  it("matches audio extensions case-insensitively", () => {
    expect(arbitrateImportPaths(["/a/CALL.M4A"])).toEqual({
      kind: "audio",
      path: "/a/CALL.M4A",
    });
  });
});
