import { describe, expect, it } from "vitest";
import {
  emptyOpening,
  isOpeningEmpty,
  MAX_OPENING_SCRIPT,
  MAX_SMALL_TALK_ITEMS,
  normalizeOpening,
  openingSaid,
  openingShowing,
  openingWithSmallTalk,
  openingWithoutSmallTalk,
} from "./opening";

const SCRIPT = "謝謝今天撥空，我們大概三十分鐘，想先聊導入進度、再看報價，最後確認下一步，這樣可以嗎？";

describe("normalizeOpening", () => {
  it("reads a draft from before openings as the empty one", () => {
    expect(normalizeOpening(undefined)).toEqual({ script: "", smallTalk: [] });
    expect(normalizeOpening("nope")).toBe(emptyOpening());
    expect(isOpeningEmpty(normalizeOpening({}))).toBe(true);
  });

  it("trims, caps, and drops blank or repeated small talk", () => {
    const o = normalizeOpening({
      script: `  ${"字".repeat(MAX_OPENING_SCRIPT + 50)}  `,
      smallTalk: ["  去北海道了嗎？ ", "", 3, "去北海道了嗎？", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)],
    });
    expect(o.script).toHaveLength(MAX_OPENING_SCRIPT);
    expect(o.smallTalk[0]).toBe("去北海道了嗎？");
    expect(o.smallTalk).toHaveLength(MAX_SMALL_TALK_ITEMS);
    expect(new Set(o.smallTalk).size).toBe(o.smallTalk.length);
  });
});

describe("editing the small talk", () => {
  it("adds a line once and removes by position", () => {
    const one = openingWithSmallTalk(emptyOpening(), " 最近忙季還好嗎？ ");
    expect(one.smallTalk).toEqual(["最近忙季還好嗎？"]);
    expect(openingWithSmallTalk(one, "最近忙季還好嗎？")).toBe(one);
    expect(openingWithSmallTalk(one, "   ")).toBe(one);
    expect(openingWithoutSmallTalk(one, 0).smallTalk).toEqual([]);
  });
});

describe("openingSaid", () => {
  const opening = { script: SCRIPT, smallTalk: ["上次說要去北海道，後來去了嗎？"] };

  it("is not said before the user has spoken, or when only the other side has", () => {
    expect(openingSaid(opening, [])).toBe(false);
    expect(
      openingSaid(opening, [
        { who: "me", text: "喂，聽得到嗎？" },
        { who: "them", text: SCRIPT },
      ]),
    ).toBe(false);
  });

  it("is said once the user's lines, taken together, carry its wording", () => {
    expect(
      openingSaid(opening, [
        { who: "me", text: "謝謝今天撥空喔，我們大概三十分鐘" },
        { who: "them", text: "好" },
        { who: "me", text: "我想先聊一下導入進度，然後再看報價，最後確認下一步，這樣可以嗎" },
      ]),
    ).toBe(true);
  });

  it("small talk alone does not retire a draft that has a standard opening", () => {
    expect(openingSaid(opening, [{ who: "me", text: "上次說要去北海道，後來去了嗎？" }])).toBe(false);
  });

  it("with small talk only, one line said is enough", () => {
    const smallOnly = { script: "", smallTalk: opening.smallTalk };
    expect(openingSaid(smallOnly, [{ who: "me", text: "欸你上次說要去北海道，後來有去嗎" }])).toBe(true);
    expect(openingSaid(smallOnly, [{ who: "me", text: "我們直接開始吧" }])).toBe(false);
  });

  it("counts every line when the transcript cannot tell who spoke", () => {
    expect(openingSaid(opening, [{ who: "them", text: SCRIPT }])).toBe(true);
  });
});

describe("openingShowing", () => {
  const base = { meetingOpening: { script: SCRIPT, smallTalk: [] }, openingDismissed: false, meetingStatus: "recording" };

  it("is up while the meeting runs, until put away", () => {
    expect(openingShowing(base)).toBe(true);
    expect(openingShowing({ ...base, meetingStatus: "paused" })).toBe(true);
    expect(openingShowing({ ...base, openingDismissed: true })).toBe(false);
    expect(openingShowing({ ...base, meetingStatus: "idle" })).toBe(false);
  });

  it("never shows for a draft without an opening", () => {
    expect(openingShowing({ ...base, meetingOpening: emptyOpening() })).toBe(false);
  });
});
