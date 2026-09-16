import { describe, expect, it } from "vitest";
import { safeExportFileName, FALLBACK_EXPORT_NAME } from "./exportName";

/**
 * The property this module exists for: whatever a recording is called on
 * screen, the name handed to the save dialog is one that BOTH macOS and Windows
 * will actually create — and still recognizable as the recording it came from.
 */

/** Escape-free so the source stays readable: NUL, BEL, and DEL. */
const ctrl = (...codes: number[]) => String.fromCharCode(...codes);

describe("safeExportFileName", () => {
  it("leaves an already-legal title alone apart from the extension", () => {
    expect(safeExportFileName("Acme kickoff", "ogg")).toBe("Acme kickoff.ogg");
  });

  it("rewrites the auto-generated live title, whose slashes and colons Windows rejects", () => {
    expect(safeExportFileName("Live meeting · 9/16/2026, 2:30:15 PM", "ogg")).toBe(
      "Live meeting · 9-16-2026, 2-30-15 PM.ogg",
    );
  });

  it("rewrites the zh-TW live title the same way, keeping every CJK character", () => {
    expect(safeExportFileName("會議紀錄 · 2026/9/16 下午2:30:15", "ogg")).toBe(
      "會議紀錄 · 2026-9-16 下午2-30-15.ogg",
    );
  });

  it("replaces each Windows-reserved character rather than deleting it", () => {
    // Deleting would close the gap and read as one word; the point is legibility.
    expect(safeExportFileName("Q3 Review: Acme", "ogg")).toBe("Q3 Review- Acme.ogg");
    expect(safeExportFileName('a<b>c:d"e/f\\g|h?i*j', "ogg")).toBe("a-b-c-d-e-f-g-h-i-j.ogg");
  });

  it("replaces ASCII control characters, which no filesystem will take", () => {
    expect(safeExportFileName(`Board${ctrl(0)}sync${ctrl(7)}notes${ctrl(127)}`, "ogg")).toBe(
      "Board-sync-notes.ogg",
    );
  });

  it("drops a trailing dot or space, which Windows silently strips from the path", () => {
    // Left in, the name we asked for stops matching the file that got written.
    expect(safeExportFileName("Board sync. ", "ogg")).toBe("Board sync.ogg");
    expect(safeExportFileName("Board sync ", "ogg")).toBe("Board sync.ogg");
  });

  it("drops a leading dot, which would hide the export on macOS", () => {
    // ...without reading the whole title as an extension and losing it.
    expect(safeExportFileName(".hidden sync", "ogg")).toBe("hidden sync.ogg");
  });

  it("sidesteps the Windows reserved device names, whatever their case", () => {
    expect(safeExportFileName("NUL", "ogg")).toBe("NUL_.ogg");
    expect(safeExportFileName("con", "ogg")).toBe("con_.ogg");
    expect(safeExportFileName("Prn", "ogg")).toBe("Prn_.ogg");
    expect(safeExportFileName("COM1", "ogg")).toBe("COM1_.ogg");
    expect(safeExportFileName("lpt9", "ogg")).toBe("lpt9_.ogg");
  });

  it("sidesteps a reserved device name that carries an extension too", () => {
    // NUL.txt is as unopenable on Windows as bare NUL.
    expect(safeExportFileName("aux.log", "ogg")).toBe("aux_.ogg");
    expect(safeExportFileName("NUL.txt.log", "ogg")).toBe("NUL_.txt.ogg");
  });

  it("leaves a title that merely starts with a device name untouched", () => {
    expect(safeExportFileName("CONSOLE", "ogg")).toBe("CONSOLE.ogg");
    expect(safeExportFileName("COM0", "ogg")).toBe("COM0.ogg");
    expect(safeExportFileName("Aux room notes", "ogg")).toBe("Aux room notes.ogg");
  });

  it("falls back to a fixed name when the title is empty or entirely illegal", () => {
    expect(safeExportFileName("", "ogg")).toBe(`${FALLBACK_EXPORT_NAME}.ogg`);
    expect(safeExportFileName("   ", "ogg")).toBe(`${FALLBACK_EXPORT_NAME}.ogg`);
    expect(safeExportFileName("***", "ogg")).toBe(`${FALLBACK_EXPORT_NAME}.ogg`);
    expect(safeExportFileName("...", "ogg")).toBe(`${FALLBACK_EXPORT_NAME}.ogg`);
  });

  it("caps the length with room left for the extension", () => {
    const long = safeExportFileName("字".repeat(300), "ogg");
    expect(long.length).toBe(80);
    expect(long.endsWith(".ogg")).toBe(true);
    // A longer extension eats into the stem, not past the cap.
    expect(safeExportFileName("a".repeat(300), "flac").length).toBe(80);
  });

  it("never lets the cut itself leave a trailing space", () => {
    // The 76th character is a space, which Windows would drop back off again.
    const cut = safeExportFileName(`${"a".repeat(75)} ${"b".repeat(20)}`, "ogg");
    expect(cut).toBe(`${"a".repeat(75)}.ogg`);
  });

  it("normalizes the extension it is handed", () => {
    expect(safeExportFileName("Acme kickoff", ".m4a")).toBe("Acme kickoff.m4a");
    expect(safeExportFileName("Acme kickoff", "")).toBe("Acme kickoff");
  });

  it("does not repeat an extension the title already ends with", () => {
    expect(safeExportFileName("interview.m4a", "m4a")).toBe("interview.m4a");
  });
});
