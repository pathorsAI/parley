import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CHARS,
  REDACTED,
  appendBackground,
  backgroundLines,
  capMemoryText,
  cleanLines,
  excerptMemory,
  memoryFilesToText,
  redactSecrets,
  removeBackgroundLines,
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
      lines: ["團隊：Joe"],
    });
    expect(appendBackground("", ["- A"])).toEqual({ text: "A", added: 1, lines: ["A"] });
    expect(appendBackground("A", ["A"])).toEqual({ text: "A", added: 0, lines: [] });
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

describe("removeBackgroundLines", () => {
  it("drops the given lines, markers or not, and keeps everything else as written", () => {
    const text = "Works at Acme\n\n- Designs onboarding\n* Talks to clients";
    expect(removeBackgroundLines(text, ["Designs onboarding"])).toBe("Works at Acme\n\n* Talks to clients");
  });

  it("undoes exactly what appendBackground added", () => {
    const before = "Works at Acme";
    const { text, lines } = appendBackground(before, ["Works at Acme", "Uses Parley for client calls"]);
    expect(lines).toEqual(["Uses Parley for client calls"]);
    expect(removeBackgroundLines(text, lines)).toBe(before);
  });
});

describe("excerptMemory", () => {
  it("keeps the plain statements and drops markdown furniture", () => {
    const text = [
      "## CLAUDE.md",
      "# About me",
      "- I'm a **product designer** at Pathors",
      "- Working on `Parley` onboarding",
      "```bash",
      "gws gmail users drafts create",
      "```",
      "| tool | use |",
      "> a quote",
      "---",
      "See [the docs](https://example.com) at ~/Pathors/p-drive/notes.md",
      "ok",
    ].join("\n");
    expect(excerptMemory(text)).toEqual(["I'm a product designer at Pathors", "Working on Parley onboarding"]);
  });

  it("masks secrets, cuts long lines and keeps a summary's worth", () => {
    const long = "這是一段很長的說明".repeat(12);
    const lines = excerptMemory(["api_key = sk-abcdefghijklmnopqrstuvwxyz123456", long, ...Array.from({ length: 12 }, (_, i) => `Fact number ${i}`)].join("\n"));
    expect(lines[0]).toContain(REDACTED);
    expect([...lines[1]].length).toBe(80);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines).toHaveLength(8);
  });
});
