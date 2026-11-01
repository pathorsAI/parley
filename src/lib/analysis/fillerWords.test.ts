import { describe, it, expect } from "vitest";
import { countFillerSounds, countFillersByWord, topFillers } from "./fillerWords";

describe("countFillerSounds", () => {
  it("counts English hesitations", () => {
    expect(countFillerSounds("um so uh yeah")).toBe(2);
    expect(countFillerSounds("er, I mean, erm")).toBe(2);
    expect(countFillerSounds("hmm let me think")).toBe(1);
  });

  it("collapses repeated runs to a single event", () => {
    expect(countFillerSounds("ummm")).toBe(1);
    expect(countFillerSounds("嗯嗯嗯")).toBe(1);
    expect(countFillerSounds("啊啊啊")).toBe(1);
  });

  it("counts unambiguous Mandarin hesitation characters", () => {
    expect(countFillerSounds("嗯我覺得呃這樣")).toBe(2); // 嗯 + 呃
    expect(countFillerSounds("痾這個唔")).toBe(2); // 痾 + 唔
  });

  it("counts cross-language / code-switched fillers together", () => {
    // The same hesitation the recognizer may write as "um" OR "嗯".
    expect(countFillerSounds("um 嗯 uh 呃")).toBe(4);
  });

  it("does not flag single ambiguous particles, only repeated runs", () => {
    expect(countFillerSounds("真的很好啊")).toBe(0); // trailing 啊 is a particle
    expect(countFillerSounds("啊啊 怎麼會這樣")).toBe(1); // repeated → hesitation
  });

  it("does not match hesitation letters inside real words", () => {
    expect(countFillerSounds("a human ahead, yeah, summary")).toBe(0);
  });

  it("returns 0 for empty / whitespace", () => {
    expect(countFillerSounds("")).toBe(0);
    expect(countFillerSounds("   ")).toBe(0);
  });
});

describe("countFillersByWord", () => {
  const tally = (text: string) => Object.fromEntries(countFillersByWord(text));

  it("counts lexical crutch words per word", () => {
    expect(tally("然後我們然後再看，然後就好")).toEqual({ 然後: 3 });
  });

  it("prefers the longest entry so a phrase is not also counted as its prefix", () => {
    expect(tally("就是說這樣就是")).toEqual({ 就是說: 1, 就是: 1 });
  });

  it("folds hesitation-sound variants onto one label", () => {
    expect(tally("ummm so um, 嗯嗯 嗯 啊啊")).toEqual({ um: 2, 嗯: 2, 啊啊: 1 });
  });

  it("counts rapid-fire agreement runs of three or more 對", () => {
    expect(tally("對對對，好")).toEqual({ 對對對: 1 });
    expect(tally("對，對，對，對")).toEqual({ 對對對: 1 });
    expect(tally("對對")).toEqual({});
  });

  it("anchors English entries to whole words, case-insensitively", () => {
    expect(tally("Like, it was likely, you know, LIKE that")).toEqual({ like: 2, "you know": 1 });
  });

  it("accumulates into a shared map", () => {
    const m = new Map<string, number>();
    countFillersByWord("然後", m);
    countFillersByWord("然後 um", m);
    expect(Object.fromEntries(m)).toEqual({ 然後: 2, um: 1 });
  });
});

describe("topFillers", () => {
  it("orders by count and caps the list", () => {
    const m = new Map([
      ["um", 2],
      ["然後", 6],
      ["對對對", 3],
      ["其實", 1],
      ["那個", 1],
      ["就是", 1],
    ]);
    expect(topFillers(m, 3)).toEqual([
      { word: "然後", count: 6 },
      { word: "對對對", count: 3 },
      { word: "um", count: 2 },
    ]);
  });
});
