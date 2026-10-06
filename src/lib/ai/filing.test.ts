import { describe, expect, it } from "vitest";
import {
  capFilingTranscript,
  filingLanguage,
  filingSystemPrompt,
  filingUserMessage,
  gateFilingTitle,
  resolveFilingFolders,
} from "./filing";
import FILING from "../../../shared/prompts/filing.json";

const folders = [
  { id: "f-acme", name: "Acme Corp" },
  { id: "f-hiring", name: "Hiring" },
  { id: "f-board", name: "Board" },
  { id: "f-ops", name: "Ops" },
];

/** Shorthand for one raw pick off the model. */
const pick = (name: string, isNew = false, reason = "fits") => ({ name, isNew, reason });

describe("resolveFilingFolders", () => {
  it("matches an existing folder by exact name", () => {
    expect(resolveFilingFolders([pick("Acme Corp")], folders)).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("matches case- and whitespace-insensitively, keeping the registry's spelling", () => {
    expect(resolveFilingFolders([pick("  acme CORP ")], folders)).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("treats a name matching nothing as a new folder", () => {
    expect(resolveFilingFolders([pick("Globex")], folders)).toEqual([
      { folderId: null, name: "Globex", reason: "fits" },
    ]);
  });

  it("resolves to the existing folder even when the model claims it is new", () => {
    expect(resolveFilingFolders([pick("Hiring", true)], folders)).toEqual([
      { folderId: "f-hiring", name: "Hiring", reason: "fits" },
    ]);
  });

  it("keeps only the first new-folder suggestion", () => {
    const out = resolveFilingFolders(
      [pick("Globex", true), pick("Initech", true), pick("Acme Corp")],
      folders
    );
    expect(out).toEqual([
      { folderId: null, name: "Globex", reason: "fits" },
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("collapses duplicate folder ids to one entry", () => {
    const out = resolveFilingFolders(
      [pick("Acme Corp", false, "customer"), pick("acme corp", true, "same again"), pick("Ops")],
      folders
    );
    expect(out).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "customer" },
      { folderId: "f-ops", name: "Ops", reason: "fits" },
    ]);
  });

  it("caps at three entries, preserving the model's order", () => {
    const out = resolveFilingFolders(
      [pick("Acme Corp"), pick("Hiring"), pick("Board"), pick("Ops")],
      folders
    );
    expect(out.map((f) => f.folderId)).toEqual(["f-acme", "f-hiring", "f-board"]);
  });

  it("drops empty and whitespace-only names", () => {
    const out = resolveFilingFolders([pick(""), pick("   "), pick("Board")], folders);
    expect(out).toEqual([{ folderId: "f-board", name: "Board", reason: "fits" }]);
  });

  it("trims the reason and allows an empty one", () => {
    expect(resolveFilingFolders([pick("Board", false, "  ongoing governance  ")], folders)).toEqual([
      { folderId: "f-board", name: "Board", reason: "ongoing governance" },
    ]);
    expect(resolveFilingFolders([pick("Board", false, "   ")], folders)).toEqual([
      { folderId: "f-board", name: "Board", reason: "" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(resolveFilingFolders([], folders)).toEqual([]);
    expect(resolveFilingFolders([], [])).toEqual([]);
  });
});

// ── The shared prompt (shared/prompts/filing.json) ───────────────────────────
// These pin the exact bytes desktop sends, because iOS and Android assemble the
// same strings from generated copies of the same file. A change here that the
// phones don't mirror is how one recording ends up with three different titles.

describe("filingLanguage / filingSystemPrompt", () => {
  it("follows the UI language: zh-TW, else English", () => {
    expect(filingLanguage({ language: "zh-TW" } as never)).toBe("zh-TW");
    expect(filingLanguage({ language: "en" } as never)).toBe("en");
  });

  it("is rules + language + JSON instruction, nothing per-user", () => {
    expect(filingSystemPrompt("zh-TW")).toBe(
      FILING.rules + FILING.languageInstruction["zh-TW"] + FILING.jsonInstruction
    );
    expect(filingSystemPrompt("en")).toBe(
      FILING.rules + FILING.languageInstruction.en + FILING.jsonInstruction
    );
  });
});

describe("filingUserMessage", () => {
  it("orders context, current title, folders, transcript", () => {
    expect(
      filingUserMessage({
        meetingContext: "  Q3 renewal with Acme  ",
        currentTitle: " 會議 10/6 ",
        folderNames: ["Acme Corp", "  ", " Hiring "],
        transcript: "[0:01] [Me] hi",
      })
    ).toBe(
      "Meeting context: Q3 renewal with Acme\n\n" +
        "The recording is currently called: 會議 10/6\n\n" +
        "The user's existing folders:\n- Acme Corp\n- Hiring\n\n" +
        "Transcript:\n[0:01] [Me] hi"
    );
  });

  it("omits a blank context and names an untitled recording", () => {
    expect(
      filingUserMessage({
        meetingContext: "   ",
        currentTitle: "",
        folderNames: ["Ops"],
        transcript: "t",
      })
    ).toBe(
      "The recording is currently called: (untitled)\n\n" +
        "The user's existing folders:\n- Ops\n\n" +
        "Transcript:\nt"
    );
  });

  it("says there are no folders when the registry is empty (or all blank)", () => {
    const msg = filingUserMessage({ currentTitle: "x", folderNames: [" "], transcript: "t" });
    expect(msg).toBe(
      "The recording is currently called: x\n\n" + FILING.noFolders + "\n\nTranscript:\nt"
    );
  });
});

describe("capFilingTranscript", () => {
  const max = FILING.maxTranscriptCharacters;
  const head = Math.floor((max * FILING.headShareNumerator) / FILING.headShareDenominator);

  it("leaves a transcript within budget untouched", () => {
    const t = "a".repeat(max);
    expect(capFilingTranscript(t)).toBe(t);
  });

  it("keeps the head and tail around the elision marker", () => {
    const t = "h".repeat(head) + "m".repeat(5000) + "t".repeat(max - head);
    const out = capFilingTranscript(t);
    expect(out).toBe("h".repeat(head) + FILING.elisionMarker + "t".repeat(max - head));
  });

  it("counts and cuts on code points, never splitting a surrogate pair", () => {
    // Each 𠀀 is ONE code point but TWO UTF-16 units: a length-based cut would
    // both over-count and leave half a character at the seams.
    const t = "𠀀".repeat(max + 10);
    const out = capFilingTranscript(t);
    const [h, tail] = out.split(FILING.elisionMarker);
    expect(Array.from(h)).toHaveLength(head);
    expect(Array.from(tail)).toHaveLength(max - head);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(capFilingTranscript("𠀀".repeat(max))).toBe("𠀀".repeat(max));
  });
});

describe("gateFilingTitle", () => {
  const gate = (raw: unknown, currentTitle = "會議 10/6", transcript = "[0:01] [我] 我們談一下合約") =>
    gateFilingTitle(raw, { currentTitle, transcript });

  it("passes a good title through, trimmed", () => {
    expect(gate("  泓昇科技 · 合約續約  ")).toBe("泓昇科技 · 合約續約");
  });

  it("rejects empty and non-string titles", () => {
    expect(gate("   ")).toBe("");
    expect(gate(undefined)).toBe("");
    expect(gate(42)).toBe("");
  });

  it("rejects a title over the code-point cap", () => {
    expect(gate("a".repeat(FILING.maxTitleCharacters))).toBe("a".repeat(FILING.maxTitleCharacters));
    expect(gate("a".repeat(FILING.maxTitleCharacters + 1))).toBe("");
    // 80 CJK-extension characters are 160 UTF-16 units but still within the cap.
    expect(gate("𠀀".repeat(FILING.maxTitleCharacters))).toBe("𠀀".repeat(FILING.maxTitleCharacters));
  });

  it("rejects the current title coming back unchanged", () => {
    expect(gate(" 會議 10/6 ")).toBe("");
  });

  it("rejects a listed Simplified character the recording did not contain", () => {
    expect(gate("泓昇科技 · 需求说明")).toBe("");
  });

  it("allows it once the transcript or current title already has it", () => {
    expect(gate("泓昇科技 · 需求说明", "會議", "[0:01] [我] 我来说一下需求")).toBe("泓昇科技 · 需求说明");
    expect(gate("需求说明會", "说明", "t")).toBe("需求说明會");
  });

  it("never rejects characters shared with Traditional (台, 后, 里)", () => {
    expect(gate("後台設定 · 皇后 · 公里數")).toBe("後台設定 · 皇后 · 公里數");
    expect(gate("台后里")).toBe("台后里");
    expect(gate("Acme renewal")).toBe("Acme renewal");
  });

  it("gates on exactly the shared list", () => {
    for (const ch of Array.from(FILING.simplifiedOnlyChars)) {
      expect(gate(`標題${ch}`)).toBe("");
    }
  });
});
