import { describe, it, expect } from "vitest";
import { finalizingHold, shellTreeVisible, type ShellTreeFacts } from "./sidebar";

/** Live idle, tree expanded, no peek — the plain case. */
function facts(patch: Partial<ShellTreeFacts> = {}): ShellTreeFacts {
  return {
    meetingActive: false,
    finalizing: false,
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

  it("after End, the tree stays hidden on the cockpit until the save opens the report", () => {
    // The exact frame that used to go four-column: stopped, finalizing, still live.
    expect(shellTreeVisible(facts({ finalizing: true }))).toBe(false);
  });

  it("⌘B during the save peeks: the peek alone decides, the saved preference is ignored", () => {
    expect(shellTreeVisible(facts({ finalizing: true, peek: true }))).toBe(true);
    // An expanded preference doesn't leak the tree in early...
    expect(shellTreeVisible(facts({ finalizing: true, collapsed: false }))).toBe(false);
    // ...and a collapsed one doesn't stop a peek from showing it.
    expect(shellTreeVisible(facts({ finalizing: true, collapsed: true, peek: true }))).toBe(true);
  });

  it("once the report opens (study route) the saved preference is back in charge", () => {
    expect(shellTreeVisible(facts({ finalizing: true, liveRoute: false }))).toBe(true);
    expect(shellTreeVisible(facts({ liveRoute: false, collapsed: true }))).toBe(false);
    // A stale peek can't override the preference outside the hold.
    expect(shellTreeVisible(facts({ collapsed: true, peek: true }))).toBe(false);
  });

  it("outside any meeting it is simply the ⌘B preference", () => {
    expect(shellTreeVisible(facts())).toBe(true);
    expect(shellTreeVisible(facts({ collapsed: true }))).toBe(false);
  });
});

describe("finalizingHold", () => {
  it("holds only between End and the report: stopped, saving, still on the cockpit", () => {
    expect(finalizingHold(facts({ finalizing: true }))).toBe(true);
    expect(finalizingHold(facts({ finalizing: false }))).toBe(false);
    expect(finalizingHold(facts({ finalizing: true, liveRoute: false }))).toBe(false);
    // A running meeting is its own focus, not the hold — ⌘B keeps its old meaning there.
    expect(finalizingHold(facts({ finalizing: true, meetingActive: true }))).toBe(false);
  });
});
