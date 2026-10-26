import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CHARS,
  backgroundLines,
  capMemoryText,
  cleanLines,
  joinBackground,
  memoryFilesToText,
  mergeBackground,
} from "./memoryImport";

describe("cleanLines", () => {
  it("strips bullets and numbering, drops blanks and duplicates", () => {
    expect(cleanLines(["- 負責產品設計", "• 負責產品設計", "  ", "2) Team: Joe", "* Parley"])).toEqual([
      "負責產品設計",
      "Team: Joe",
      "Parley",
    ]);
  });
});

describe("background lines", () => {
  it("round-trips through userBackground", () => {
    const lines = backgroundLines("- 常和東森談外撥專案\n\n團隊：Brendan（PM）\r\n");
    expect(lines).toEqual(["常和東森談外撥專案", "團隊：Brendan（PM）"]);
    expect(joinBackground(lines)).toBe("常和東森談外撥專案\n團隊：Brendan（PM）");
  });

  it("merges only lines that aren't there yet", () => {
    expect(mergeBackground("A\nB", ["B", "C"])).toBe("A\nB\nC");
    expect(mergeBackground("", ["- A"])).toBe("A");
  });
});

describe("memory text", () => {
  it("labels each Claude Code file", () => {
    expect(
      memoryFilesToText([
        { label: "global", text: "I design Parley.\n" },
        { label: "-work-parley", text: "Team: Joe" },
      ]),
    ).toBe("## global\nI design Parley.\n\n## -work-parley\nTeam: Joe");
  });

  it("caps what goes to the model", () => {
    expect(capMemoryText("x".repeat(MAX_MEMORY_CHARS + 50))).toHaveLength(MAX_MEMORY_CHARS);
    expect(capMemoryText("  short  ")).toBe("short");
  });
});
