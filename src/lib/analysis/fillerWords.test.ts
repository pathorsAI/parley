import { describe, it, expect } from "vitest";
import { countFillerSounds } from "./fillerWords";

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
