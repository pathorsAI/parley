import { describe, expect, it } from "vitest";
import { MarkdownManager } from "@tiptap/markdown";
import type { JSONContent } from "@tiptap/core";
import { normalizeNotesMarkdown, notesForDisplay, notesLineCount } from "./notesMarkdown";
import { notesExtensions } from "./notesSchema";
import { contextWithNotes } from "../history/meetingNotes";

/** The editor's own Markdown manager, without an editor (no DOM in this suite). */
function manager(): MarkdownManager {
  return new MarkdownManager({ extensions: notesExtensions() });
}

function roundTrip(md: string): string {
  const m = manager();
  return normalizeNotesMarkdown(m.serialize(m.parse(md)));
}

const p = (text?: string): JSONContent => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });

describe("notes Markdown round trip", () => {
  it.each([
    ["bullets", "- one\n- two"],
    ["numbered", "1. a\n2. b\n3. c"],
    ["nested", "- a\n  - b\n- c"],
    ["tasks", "- [ ] todo\n- [x] done\n  - [ ] nested"],
    ["headings", "# h1\n\n## h2\n\n### h3"],
    ["marks", "**bold** *italic* ~~struck~~ `code`"],
    ["quote", "> quoted"],
    ["paragraphs", "first\n\nsecond"],
  ])("%s survive parse → serialize", (_name, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("old plain-text notes load as paragraphs and keep their lines", () => {
    expect(roundTrip("line one\nline two")).toBe("line one\nline two");
  });

  it("an empty pad serialises to the empty string", () => {
    const m = manager();
    expect(normalizeNotesMarkdown(m.serialize({ type: "doc", content: [p()] }))).toBe("");
    expect(normalizeNotesMarkdown(m.serialize({ type: "doc", content: [p(), p()] }))).toBe("");
    expect(contextWithNotes("ctx", roundTrip(""), "Notes:")).toBe("ctx");
  });

  it("an ordered list continues its numbering", () => {
    const m = manager();
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            { type: "listItem", content: [p("a")] },
            { type: "listItem", content: [p("b")] },
          ],
        },
      ],
    };
    expect(normalizeNotesMarkdown(m.serialize(doc))).toBe("1. a\n2. b");
  });
});

describe("normalizeNotesMarkdown", () => {
  it("drops trailing whitespace only", () => {
    expect(normalizeNotesMarkdown("  - a\n\n")).toBe("  - a");
    expect(normalizeNotesMarkdown("\n\n \n")).toBe("");
  });
});

describe("notesLineCount", () => {
  it("counts list items, not blank lines or bare syntax", () => {
    expect(notesLineCount("")).toBe(0);
    expect(notesLineCount("- a\n- b\n- c")).toBe(3);
    expect(notesLineCount("# Agenda\n\n1. a\n2. b\n\n- [ ] \n```\ncode\n```")).toBe(4);
    expect(notesLineCount("plain\nold\nnotes")).toBe(3);
  });
});

describe("notesForDisplay", () => {
  it("keeps plain-text lines apart as hard breaks", () => {
    expect(notesForDisplay("a\nb\nc")).toBe("a  \nb  \nc");
  });

  it("leaves paragraphs, the last line and code fences alone", () => {
    expect(notesForDisplay("a\n\nb")).toBe("a\n\nb");
    expect(notesForDisplay("```\nx\ny\n```")).toBe("```\nx\ny\n```");
  });
});
