import { describe, it, expect } from "vitest";
import { cockpitHold, shellTreeVisible, type ShellTreeFacts } from "./sidebar";

/** A stopped meeting's cockpit, tree expanded, no peek. */
function facts(patch: Partial<ShellTreeFacts> = {}): ShellTreeFacts {
  return {
    meetingActive: false,
    liveRoute: true,
    collapsed: false,
    peek: false,
    ...patch,
  };
}

describe("shellTreeVisible (the shell's one tree decision)", () => {
  it("a running meeting hides the tree whatever the preference or a peek says", () => {
    expect(shellTreeVisible(facts({ meetingActive: true }))).toBe(false);
    expect(shellTreeVisible(facts({ meetingActive: true, peek: true }))).toBe(false);
    expect(shellTreeVisible(facts({ meetingActive: true, collapsed: true }))).toBe(false);
  });

  it("a stopped meeting's cockpit never shows the tree — saving, saved, discarded or failed alike", () => {
    // The four-column frame: the meeting is over, the cockpit is still up. It
    // used to be held back only while the save was in flight, so a meeting too
    // short to keep (no report ever opens) left the tree beside the coach.
    expect(shellTreeVisible(facts())).toBe(false);
  });

  it("⌘B on the stopped cockpit peeks: the peek alone decides, the saved preference is ignored", () => {
    expect(shellTreeVisible(facts({ peek: true }))).toBe(true);
    expect(shellTreeVisible(facts({ collapsed: false }))).toBe(false);
    expect(shellTreeVisible(facts({ collapsed: true, peek: true }))).toBe(true);
  });

  it("off the cockpit (report, Home, library) the saved preference is in charge", () => {
    expect(shellTreeVisible(facts({ liveRoute: false }))).toBe(true);
    expect(shellTreeVisible(facts({ liveRoute: false, collapsed: true }))).toBe(false);
    // A stale peek can't override the preference outside the hold.
    expect(shellTreeVisible(facts({ liveRoute: false, collapsed: true, peek: true }))).toBe(false);
  });
});

describe("cockpitHold", () => {
  it("holds exactly while a stopped meeting's cockpit is on screen", () => {
    expect(cockpitHold(facts())).toBe(true);
    expect(cockpitHold(facts({ liveRoute: false }))).toBe(false);
    // A running meeting is its own focus, not the hold — ⌘B keeps its old meaning there.
    expect(cockpitHold(facts({ meetingActive: true }))).toBe(false);
  });
});
