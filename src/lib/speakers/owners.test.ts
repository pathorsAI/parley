import { describe, expect, it } from "vitest";
import type { ActionItem, TranscriptSegment } from "../types";
import { ownerDisplayName, ownerSpeakerKey, withOwnerKeys } from "./owners";

const seg = (source: TranscriptSegment["source"], speaker: number) => ({ source, speaker });
const segments = [seg("mix", 1), seg("mix", 2), seg("mix", 3)];
const item = (owner?: string, ownerKey?: string): ActionItem => ({
  id: "a",
  text: "Send the quote",
  done: false,
  linkedEventId: null,
  atMs: null,
  owner,
  ownerKey,
});

describe("action item owners follow speaker names", () => {
  it("ties a speaker-owner to its key, by default label or current name", () => {
    expect(ownerSpeakerKey("Speaker 2", segments, {})).toBe("mix-2");
    expect(ownerSpeakerKey("kevin", segments, { "mix-3": "Kevin" })).toBe("mix-3");
    expect(ownerSpeakerKey("Amy", segments, {})).toBeUndefined();
  });

  it("refuses a name two speakers share", () => {
    expect(ownerSpeakerKey("Kevin", segments, { "mix-1": "Kevin", "mix-3": "Kevin" })).toBeUndefined();
  });

  it("shows a keyed owner by the speaker's latest name, through more than one rename", () => {
    const [a] = withOwnerKeys([item("Kevin")], segments, { "mix-2": "Kevin" });
    expect(a.ownerKey).toBe("mix-2");
    expect(ownerDisplayName(a, segments, { "mix-2": "Kevin Lin" })).toBe("Kevin Lin");
    expect(ownerDisplayName(a, segments, {})).toBe("Speaker 2");
  });

  it("renames an older, unkeyed Speaker N owner and leaves a mentioned name alone", () => {
    expect(ownerDisplayName(item("Speaker 1"), segments, { "mix-1": "王經理" })).toBe("王經理");
    expect(ownerDisplayName(item("Amy"), segments, { "mix-1": "王經理" })).toBe("Amy");
  });

  it("falls back to the written name when the keyed speaker is gone", () => {
    expect(ownerDisplayName(item("Kevin", "mix-9"), segments, {})).toBe("Kevin");
  });
});
