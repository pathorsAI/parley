import { describe, it, expect } from "vitest";
import {
  EVAL_TEMPLATE_OF,
  MEETING_KINDS,
  briefSections,
  findingsFieldGuide,
  hasCategories,
  hasResolution,
  hasSides,
  lensOf,
} from "./lens";
import type { AnalysisLens } from "../types";

const LENSES: AnalysisLens[] = ["decision", "opportunity", "adversarial"];

describe("lensOf", () => {
  it("maps every kind to a lens", () => {
    for (const kind of MEETING_KINDS) expect(LENSES).toContain(lensOf(kind));
  });

  // An unclassified recording (old entry, failed detection) must not be read as
  // a negotiation — that is the reading that invents an adversary.
  it("falls back to the decision lens when the kind is unknown", () => {
    expect(lensOf(null)).toBe("decision");
    expect(lensOf(undefined)).toBe("decision");
  });

  it("keeps 議價 and 對手談判 on one output shape but separate watchers", () => {
    expect(lensOf("pricing")).toBe(lensOf("rivalry"));
    expect(EVAL_TEMPLATE_OF.pricing).not.toBe(EVAL_TEMPLATE_OF.rivalry);
  });

  it("gives every kind its own eval template", () => {
    const ids = MEETING_KINDS.map((k) => EVAL_TEMPLATE_OF[k]);
    expect(new Set(ids).size).toBe(MEETING_KINDS.length);
  });
});

describe("lens field predicates", () => {
  // A working meeting has no opposing party, so it has no lane and nothing to
  // "resolve" — the whole point of splitting the lens out.
  it("gives the decision lens categories instead of sides and resolution", () => {
    expect(hasSides("decision")).toBe(false);
    expect(hasResolution("decision")).toBe(false);
    expect(hasCategories("decision")).toBe(true);
  });

  // "I successfully rebutted the customer" is a bad thing to optimize for.
  it("withholds resolution from the sales lens", () => {
    expect(hasSides("opportunity")).toBe(true);
    expect(hasResolution("opportunity")).toBe(false);
  });

  it("keeps the full adversarial shape for negotiations", () => {
    expect(hasSides("adversarial")).toBe(true);
    expect(hasResolution("adversarial")).toBe(true);
    expect(hasCategories("adversarial")).toBe(false);
  });

  it("asks for the fields its predicates advertise, and no others", () => {
    for (const lens of LENSES) {
      const guide = findingsFieldGuide(lens);
      expect(guide.includes("- side:")).toBe(hasSides(lens));
      expect(guide.includes("- category:")).toBe(hasCategories(lens));
    }
  });
});

describe("briefSections", () => {
  it("writes a different set of sections per lens", () => {
    const rendered = LENSES.map((l) => briefSections(l));
    expect(new Set(rendered).size).toBe(LENSES.length);
  });

  // The complaint that started this: meeting notes were coming back with a
  // "what fell short" section grading the user on a meeting they merely ran.
  it("keeps performance grading out of meeting notes", () => {
    const notes = briefSections("decision");
    expect(notes).not.toMatch(/What fell short|How to improve/);
    expect(notes).toMatch(/## Decisions/);
    expect(notes).toMatch(/## Open questions/);
    expect(notes).toMatch(/## Suggested next agenda/);
  });

  it("keeps the debrief sections for a real negotiation", () => {
    expect(briefSections("adversarial")).toMatch(/## What fell short/);
  });
});
