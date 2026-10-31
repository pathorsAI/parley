import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CHARS,
  REDACTED,
  appendBackground,
  backgroundLines,
  capMemoryText,
  cleanLines,
  templateLines,
  BACKGROUND_TEMPLATE,
  memoryFilesToText,
  readingSteps,
  redactSecrets,
  removeBackgroundLines,
  properNouns,
  refreshAiMemory,
  removeMemoryLine,
} from "./memoryImport";
import { DEFAULT_SETTINGS } from "../store/defaults";
import type { Settings } from "../types";

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
        { label: "global", kind: "global", name: "~/.claude/CLAUDE.md", text: "I design Parley.\n" },
        { label: "project", kind: "auto", name: "MEMORY.md", text: "Team: Joe" },
      ]),
    ).toBe("## global\nI design Parley.\n\n## project\nTeam: Joe");
  });

  it("keeps the files' display names out of the model's text", () => {
    const text = memoryFilesToText([{ label: "project", kind: "project", name: "acme-client/CLAUDE.md", text: "x" }]);
    expect(text).not.toContain("acme-client");
  });

  it("shares the cap: short files whole, long ones cut evenly", () => {
    const file = (text: string) => ({ label: "project", kind: "auto" as const, name: "n", text });
    const text = memoryFilesToText([file("G".repeat(MAX_MEMORY_CHARS)), file("short note"), file("P".repeat(MAX_MEMORY_CHARS))]);
    expect(text).toContain("short note");
    const g = text.match(/G+/u)![0].length;
    const p = text.match(/P+/u)![0].length;
    expect(Math.abs(g - p)).toBeLessThanOrEqual(1);
    expect(g + p + "short note".length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
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

describe("readingSteps", () => {
  const file = (kind: "global" | "auto" | "project", name: string) => ({ label: "x", kind, name, text: "t" });

  it("names each file, and counts auto memory on one line where it starts", () => {
    expect(
      readingSteps([
        file("global", "~/.claude/CLAUDE.md"),
        file("auto", "MEMORY.md"),
        file("auto", "user-role.md"),
        file("auto", "team.md"),
        file("project", "parley/CLAUDE.md"),
      ]),
    ).toEqual([
      { kind: "file", name: "~/.claude/CLAUDE.md" },
      { kind: "auto", count: 3 },
      { kind: "file", name: "parley/CLAUDE.md" },
    ]);
  });

  it("is empty when nothing was read", () => {
    expect(readingSteps([])).toEqual([]);
  });
});

describe("templateLines", () => {
  const labels = BACKGROUND_TEMPLATE["zh-TW"];

  it("keeps template lines, in template order, one per label", () => {
    expect(
      templateLines(
        [
          "常見講者: Brendan（PM）；Joe（工程）",
          "- 身分：產品設計師",
          "身分：重複的一行",
          "公司：派斯科技（Pathors）",
          "隨口一句沒有標籤",
          "溝通偏好：",
        ],
        labels,
      ),
    ).toEqual(["身分：產品設計師", "公司：派斯科技（Pathors）", "常見講者：Brendan（PM）；Joe（工程）"]);
  });

  it("needs a colon right after the label", () => {
    expect(templateLines(["公司的人都很好"], labels)).toEqual([]);
  });
});

describe("properNouns", () => {
  it("keeps company and product names, drops jargon, commands and short acronyms", () => {
    expect(
      properNouns(["派斯科技", "Parley", "Pensieve", "staging", "ticket", "weekly-summary", "CLAUDE.md", "BD", "CRM", "Pathors"]),
    ).toEqual(["派斯科技", "Parley", "Pensieve", "Pathors"]);
  });
});

describe("removeMemoryLine", () => {
  const notes = "Designer at Pathors\n\n  Works on Parley\nMeets Globex often";

  it("drops the line at the index the list shows (blank lines don't count)", () => {
    expect(removeMemoryLine(notes, 1)).toBe("Designer at Pathors\nMeets Globex often");
    expect(removeMemoryLine(notes, 0)).toBe("Works on Parley\nMeets Globex often");
  });

  it("leaves the notes alone for an index that isn't there", () => {
    expect(removeMemoryLine(notes, 3)).toBe(notes);
    expect(removeMemoryLine(notes, -1)).toBe(notes);
  });
});

describe("refreshAiMemory", () => {
  const MEMORY = [{ label: "~/.claude/CLAUDE.md", kind: "global" as const, name: "~/.claude/CLAUDE.md", text: "Designer at Pathors." }];
  const NOW = 1_700_000_000_000;

  function harness(over: Partial<Settings> = {}) {
    const state = { settings: { ...DEFAULT_SETTINGS, ...over } as Settings, added: [] as string[][] };
    const deps = {
      settings: () => state.settings,
      patch: (p: Partial<Settings>) => {
        state.settings = { ...state.settings, ...p };
      },
      addTerms: async (phrases: readonly string[]) => {
        state.added.push([...phrases]);
        return phrases.map((phrase, i) => ({ id: `t${i}`, phrase }));
      },
      readMemory: async () => MEMORY,
      now: () => NOW,
    };
    return { state, deps };
  }
  // Groq on the realtime lane; a key makes it ready.
  const ready: Partial<Settings> = { llmProviders: { realtime: "groq", deep: "groq" }, groqApiKey: "gsk_test" };

  it("says so when there is no memory", async () => {
    const { deps } = harness(ready);
    expect(await refreshAiMemory({ ...deps, readMemory: async () => [] })).toEqual({ kind: "none" });
  });

  it("needs an AI provider", async () => {
    const { deps } = harness({ llmProviders: { realtime: "groq", deep: "groq" }, groqApiKey: "" });
    expect(await refreshAiMemory(deps)).toMatchObject({ kind: "notCondensed", why: "needLlm" });
  });

  it("replaces the lines an earlier read added, keeping what the user wrote", async () => {
    const { state, deps } = harness({ ...ready, userBackground: "I design.\n身分：舊的", aiMemoryNotes: "身分：舊的" });
    const out = await refreshAiMemory({
      ...deps,
      draft: async () => ({ background: ["身分：產品設計師"], terms: ["Pathors"] }),
    });
    expect(out).toMatchObject({ kind: "condensed", empty: false });
    expect(state.settings.userBackground).toBe("I design.\n身分：產品設計師");
    expect(state.settings.aiMemoryNotes).toBe("身分：產品設計師");
    expect(state.settings.aiMemoryUpdatedAt).toBe(NOW);
    expect(state.added).toEqual([["Pathors"]]);
  });

  it("reports a failed call without touching the background", async () => {
    const { state, deps } = harness({ ...ready, userBackground: "I design." });
    const out = await refreshAiMemory({
      ...deps,
      draft: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toMatchObject({ kind: "notCondensed" });
    expect(state.settings.userBackground).toBe("I design.");
  });
});
