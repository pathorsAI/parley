import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/messages";
import type { AppLanguage, TranscriptSegment } from "../types";
import { defaultSpeakerLabel, displaySpeakerLabel, localizedDefaultSpeakerLabel, type SpeakerLabelT } from "./labels";

type Line = Pick<TranscriptSegment, "source" | "speaker">;
const line = (source: Line["source"], speaker: number): Line => ({ source, speaker });
const tOf = (lang: AppLanguage): SpeakerLabelT => (key, vars) => translate(lang, key, vars);

describe("displaySpeakerLabel", () => {
  const cases: [Line, string, string][] = [
    [line("mix", 0), "說話者 1", "Speaker 1"],
    [line("mix", 3), "說話者 3", "Speaker 3"],
    [line("me", 0), "你", "You"],
    [line("me", 1), "你", "You"],
    [line("me", 2), "說話者 2", "Speaker 2"],
    [line("them", 0), "對方", "Them"],
    [line("them", 2), "遠端 2", "Remote 2"],
  ];

  it.each(cases)("%o → %s / %s", (seg, zh, en) => {
    expect(displaySpeakerLabel(seg, {}, tOf("zh-TW"))).toBe(zh);
    expect(displaySpeakerLabel(seg, undefined, tOf("en"))).toBe(en);
    // The English screen form is exactly what models see.
    expect(localizedDefaultSpeakerLabel(seg, tOf("en"))).toBe(defaultSpeakerLabel(seg));
  });

  it("prefers the user's name for the speaker", () => {
    expect(displaySpeakerLabel(line("them", 2), { "them-2": "王經理" }, tOf("zh-TW"))).toBe("王經理");
    expect(displaySpeakerLabel(line("mix", 1), { "mix-2": "Amy" }, tOf("zh-TW"))).toBe("說話者 1");
  });
});
