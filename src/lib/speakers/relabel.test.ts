import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/messages";
import type { AppLanguage, TranscriptSegment } from "../types";
import { displaySpeakerLabel, type SpeakerLabelT } from "./labels";
import { nextSpeakerAliases, relabelSpeakers } from "./relabel";

type Line = Pick<TranscriptSegment, "source" | "speaker">;
const line = (source: Line["source"], speaker: number): Line => ({ source, speaker });
const tOf = (lang: AppLanguage): SpeakerLabelT => (key, vars) => translate(lang, key, vars);

/** Relabel `text` the way the screen does, in `lang`. */
function relabel(
  text: string,
  segments: Line[],
  names: Record<string, string> = {},
  aliases: Record<string, string[]> = {},
  lang: AppLanguage = "en",
): string {
  return relabelSpeakers(text, segments, names, aliases, (seg) => displaySpeakerLabel(seg, names, tOf(lang)));
}

const mix = [line("mix", 1), line("mix", 2), line("mix", 3), line("mix", 21)];

describe("relabelSpeakers", () => {
  it("replaces a default label with the speaker's current name", () => {
    expect(relabel("Speaker 3 pushed back on price.", mix, { "mix-3": "Kevin" })).toBe("Kevin pushed back on price.");
    expect(relabel("Remote 2 asked twice.", [line("them", 2)], { "them-2": "王經理" })).toBe("王經理 asked twice.");
  });

  it("localizes an unnamed speaker's default label", () => {
    expect(relabel("Speaker 2 agreed.", mix, {}, {}, "zh-TW")).toBe("說話者 2 agreed.");
    expect(relabel("說話者 2 同意了", mix, { "mix-2": "Amy" }, {}, "zh-TW")).toBe("Amy 同意了");
  });

  it("never matches Speaker 2 inside Speaker 21", () => {
    expect(relabel("Speaker 21 and Speaker 2", mix, { "mix-2": "Amy" })).toBe("Speaker 21 and Amy");
    expect(relabel("Speaker 21 spoke", mix, { "mix-21": "Bo" })).toBe("Bo spoke");
  });

  it("does not rewrite bare You / Them", () => {
    const segs = [line("me", 1), line("them", 0)];
    expect(relabel("You told Them no.", segs, {}, {}, "zh-TW")).toBe("You told Them no.");
  });

  it("replaces a stale custom name with the current one", () => {
    expect(relabel("Kevin wants a discount.", mix, { "mix-3": "Kevin Lin" }, { "mix-3": ["Kevin"] })).toBe(
      "Kevin Lin wants a discount.",
    );
    // An ASCII alias is whole-word only.
    expect(relabel("Kevinson called.", mix, { "mix-3": "Kevin Lin" }, { "mix-3": ["Kevin"] })).toBe("Kevinson called.");
  });

  it("keeps a current name that contains an old one whole", () => {
    expect(relabel("Kevin Lin said so", mix, { "mix-3": "Kevin Lin" }, { "mix-3": ["Kevin"] })).toBe("Kevin Lin said so");
  });

  it("replaces a CJK alias as a plain substring", () => {
    expect(relabel("王先生提出要求", mix, { "mix-1": "王經理" }, { "mix-1": ["王先生"] })).toBe("王經理提出要求");
  });

  it("clears back to the default label when the name is removed", () => {
    expect(relabel("Amy agreed.", mix, {}, { "mix-2": ["Amy"] }, "zh-TW")).toBe("說話者 2 agreed.");
  });

  it("never replaces a name that is now another speaker's", () => {
    // Speaker 1 was "Amy"; Speaker 2 is called Amy now.
    expect(relabel("Amy agreed.", mix, { "mix-1": "Bea", "mix-2": "Amy" }, { "mix-1": ["Amy"] })).toBe("Amy agreed.");
  });

  it("leaves a name two speakers both used alone", () => {
    expect(
      relabel("Sam agreed.", mix, { "mix-1": "A", "mix-2": "B" }, { "mix-1": ["Sam"], "mix-2": ["Sam"] }),
    ).toBe("Sam agreed.");
  });

  it("leaves timestamp link targets untouched", () => {
    const text = "Speaker 3 at [6:52](#t=412) and [Speaker 3](#speaker-3)";
    expect(relabel(text, mix, { "mix-3": "Kevin" })).toBe("Kevin at [6:52](#t=412) and [Kevin](#speaker-3)");
  });

  it("returns the text as-is with no speakers or nothing to change", () => {
    expect(relabel("Speaker 3 said", [])).toBe("Speaker 3 said");
    expect(relabel("Speaker 3 said", mix)).toBe("Speaker 3 said");
  });
});

describe("nextSpeakerAliases", () => {
  it("keeps the previous name on a rename", () => {
    expect(nextSpeakerAliases(undefined, "Bob", "Robert")).toEqual(["Bob"]);
    expect(nextSpeakerAliases(["Bob"], "Robert", "Rob Lee")).toEqual(["Bob", "Robert"]);
  });

  it("drops typing residue from keystroke-by-keystroke renames", () => {
    let aliases: string[] = [];
    let prev: string | undefined = "Bob";
    for (const next of ["Bo", "B", "", "J", "Ja", "Jac", "Jack"]) {
      aliases = nextSpeakerAliases(aliases, prev, next);
      prev = next || undefined;
    }
    expect(aliases).toEqual(["Bob"]);
  });

  it("never keeps the current name, and adds nothing when there was no name", () => {
    expect(nextSpeakerAliases(["Amy"], "Bea", "Amy")).toEqual(["Bea"]);
    expect(nextSpeakerAliases([], undefined, "Amy")).toEqual([]);
  });
});
