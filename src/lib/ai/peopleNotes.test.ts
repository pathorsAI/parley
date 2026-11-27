import { describe, expect, it } from "vitest";
import { capPeopleTranscript, checkedCandidates, MAX_CANDIDATES, PEOPLE_NOTES_SYSTEM } from "./peopleNotes";

const transcript = [
  "[0:12] [Jack] 最近還好嗎？",
  "[0:15] [王小明] 還不錯，我們十二月要去北海道滑雪。",
  "[1:05] [王小明] 報價的部分我們要再看一下。",
].join("\n");
const ctx = { transcript, selfNames: ["Jack"] };
const good = { name: "王小明", org: "Acme", text: "十二月要去北海道滑雪", quote: "我們十二月要去北海道滑雪", at: "0:15" };

describe("checkedCandidates", () => {
  it("keeps a note whose quote is in the transcript, with where it was said", () => {
    expect(checkedCandidates([good], ctx)).toEqual([
      { name: "王小明", org: "Acme", text: "十二月要去北海道滑雪", quote: "我們十二月要去北海道滑雪", atMs: 15_000 },
    ]);
  });

  it("drops what the model made up, placeholder names, the user, blanks and repeats", () => {
    const out = checkedCandidates(
      [
        { ...good, quote: "他下個月要搬去東京開分公司" },
        { ...good, name: "Speaker 2" },
        { ...good, name: "講者 1" },
        { ...good, name: "jack" },
        { ...good, text: " " },
        good,
        good,
      ],
      ctx,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps a note with an unreadable timestamp, without a position, and caps the count", () => {
    expect(checkedCandidates([{ ...good, at: "soon" }], ctx)[0]).not.toHaveProperty("atMs");
    const many = Array.from({ length: MAX_CANDIDATES + 4 }, (_, i) => ({ ...good, text: `去北海道滑雪 ${i}` }));
    expect(checkedCandidates(many, ctx)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("the prompt", () => {
  it("names what must never be noted", () => {
    for (const word of ["health", "family conflict", "money trouble", "politics", "religion"]) {
      expect(PEOPLE_NOTES_SYSTEM).toContain(word);
    }
  });

  it("sends a long transcript's head and tail", () => {
    const long = "字".repeat(60_000);
    const capped = capPeopleTranscript(long);
    expect(Array.from(capped).length).toBeLessThan(25_000);
    expect(capped).toContain("[…]");
    expect(capPeopleTranscript("short")).toBe("short");
  });
});
