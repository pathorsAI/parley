import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CHARS,
  REDACTED,
  appendBackground,
  backgroundLines,
  capMemoryText,
  cleanLines,
  memoryFilesToText,
  redactSecrets,
} from "./memoryImport";

describe("cleanLines", () => {
  it("strips list markers, drops blanks and duplicates", () => {
    expect(cleanLines(["- 負責產品設計", "•負責產品設計", "  ", "2) Team: Joe", "* Parley", "10. Acme"])).toEqual([
      "負責產品設計",
      "Team: Joe",
      "Parley",
      "Acme",
    ]);
  });

  it("keeps numbers and symbols that are part of the text", () => {
    expect(cleanLines(["3.5 years at Acme", "-10% churn target", "*Important* client", "2024. Joined Pathors"])).toEqual([
      "3.5 years at Acme",
      "-10% churn target",
      "*Important* client",
      "2024. Joined Pathors",
    ]);
  });
});

describe("background editing", () => {
  const typed = "Clients:\n  - Acme\n\n- 常和東森談外撥專案\n";

  it("lists non-blank lines without rewriting them", () => {
    expect(backgroundLines(typed)).toEqual(["Clients:", "- Acme", "- 常和東森談外撥專案"]);
  });

  it("appends only lines it doesn't already have, ignoring list markers", () => {
    expect(appendBackground(typed, ["常和東森談外撥專案", "團隊：Joe"])).toEqual({
      text: "Clients:\n  - Acme\n\n- 常和東森談外撥專案\n團隊：Joe",
      added: 1,
    });
    expect(appendBackground("", ["- A"])).toEqual({ text: "A", added: 1 });
    expect(appendBackground("A", ["A"])).toEqual({ text: "A", added: 0 });
  });
});

describe("memory text", () => {
  it("labels each Claude Code file", () => {
    expect(
      memoryFilesToText([
        { label: "global", text: "I design Parley.\n" },
        { label: "project", text: "Team: Joe" },
      ]),
    ).toBe("## global\nI design Parley.\n\n## project\nTeam: Joe");
  });

  it("caps what goes to the model", () => {
    expect(capMemoryText("x".repeat(MAX_MEMORY_CHARS + 50))).toHaveLength(MAX_MEMORY_CHARS);
    expect(capMemoryText("  short  ")).toBe("short");
  });
});

describe("redactSecrets", () => {
  it("masks tokens and secret assignments", () => {
    const text = [
      "OpenAI key sk-proj-abcdefghijklmnop1234",
      "github ghp_ABCDEFGHIJKLMNOP1234",
      'API_KEY="hunter2hunter2"',
      "password: correcthorse",
      "blob Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toMatch(/abcdefghijklmnop1234|ABCDEFGHIJKLMNOP1234|hunter2|correcthorse|Zm9vYmFy/u);
    expect(out).toContain(`API_KEY=${REDACTED}`);
    expect(out).toContain(`password: ${REDACTED}`);
  });

  it("leaves ordinary notes alone", () => {
    const notes = "I lead design at Pathors; we pitch 東森 on outbound calling. Token budget talks are on Fridays.";
    expect(redactSecrets(notes)).toBe(notes);
  });
});
