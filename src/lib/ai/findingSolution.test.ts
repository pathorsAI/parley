import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../types";
import { seg } from "../test/fixtures";
import { buildFindingSolutionPrompt, segmentsKnownAtFinding } from "./findingSolution";

const finding: TimelineEvent = {
  id: "f1",
  atMs: 10_000,
  side: "them",
  severity: "critical",
  source: "extra",
  title: "Price objection",
  detail: "THEM challenged the price and ME needs to explore before moving.",
};

const transcript = [
  seg({ id: "before", source: "me", text: "Our price is 6000.", startMs: 5_000, endMs: 6_000 }),
  seg({ id: "moment", source: "them", text: "6000 is too high.", startMs: 10_000, endMs: 12_000 }),
  seg({ id: "future", source: "me", text: "Then I can do 4500.", startMs: 20_000, endMs: 21_000 }),
];

describe("finding solution prompt context", () => {
  it("keeps live advice bounded to the selected finding turn", () => {
    expect(segmentsKnownAtFinding(transcript, finding).map((s) => s.id)).toEqual(["before", "moment"]);

    const prompt = buildFindingSolutionPrompt({
      context: "",
      finding,
      segments: transcript,
      mode: "live",
    });

    expect(prompt).toContain("MODE: REALTIME ADVICE");
    expect(prompt).toContain("6000 is too high.");
    expect(prompt).not.toContain("Then I can do 4500.");
    expect(prompt).not.toContain("Full transcript for HINDSIGHT only");
  });

  it("labels future transcript as hindsight for replay coaching", () => {
    const prompt = buildFindingSolutionPrompt({
      context: "",
      finding,
      segments: transcript,
      mode: "replay",
    });

    expect(prompt).toContain("MODE: POST-EVALUATION COACHING");
    expect(prompt).toContain("Transcript known at this moment");
    expect(prompt).toContain("Full transcript for HINDSIGHT only");
    expect(prompt).toContain("Then I can do 4500.");
  });
});
