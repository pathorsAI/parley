import { describe, expect, it } from "vitest";
// The store first: prep.ts reaches it through ./meeting, and entering the
// cycle from the slice side would build the store before the slice exists.
import "../store";
import { draftsForOrg, isStartingSoon, sortDrafts, STARTING_SOON_MS, type MeetingDraft } from "./prep";

function draft(id: string, over: Partial<MeetingDraft> = {}): MeetingDraft {
  return {
    id,
    title: id,
    meetingAt: null,
    meetingEndAt: null,
    reminderLeadMin: 5,
    remindedFor: null,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    todos: [],
    meetingFolderId: null,
    meetingOrgShare: null,
    updatedAt: 0,
    ...over,
  };
}

describe("draftsForOrg", () => {
  const drafts = [
    draft("root", { meetingOrgShare: { orgId: "acme", folderId: null, mode: "copy" } }),
    draft("folder", { meetingOrgShare: { orgId: "acme", folderId: "f1", mode: "move" } }),
    draft("other-org", { meetingOrgShare: { orgId: "globex", folderId: null, mode: "copy" } }),
    draft("personal", { meetingFolderId: "p1" }),
    draft("follows-default"),
    draft("off", { meetingOrgShare: "off" }),
  ];

  it("keeps the drafts headed for the org's root and any of its folders", () => {
    expect(draftsForOrg(drafts, "acme").map((d) => d.id)).toEqual(["root", "folder"]);
  });

  it("leaves out personal drafts, other orgs, the settings default and opted-out ones", () => {
    expect(draftsForOrg(drafts, "globex").map((d) => d.id)).toEqual(["other-org"]);
    expect(draftsForOrg(drafts, "nobody")).toEqual([]);
  });
});

describe("sortDrafts", () => {
  it("puts timed drafts soonest first, then untimed ones newest first", () => {
    const sorted = sortDrafts([
      draft("untimed-old", { updatedAt: 1 }),
      draft("later", { meetingAt: 2_000 }),
      draft("untimed-new", { updatedAt: 5 }),
      draft("sooner", { meetingAt: 1_000 }),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(["sooner", "later", "untimed-new", "untimed-old"]);
  });

  it("given now, drops meetings already over below the rest, the latest first", () => {
    const now = 10 * 3_600_000;
    const sorted = sortDrafts(
      [
        draft("over-long-ago", { meetingAt: now - 5 * 3_600_000 }),
        draft("untimed", { updatedAt: 1 }),
        draft("in-2h", { meetingAt: now + 2 * 3_600_000 }),
        draft("over-recently", { meetingAt: now - 3 * 3_600_000, meetingEndAt: now - 3_600_000 }),
        draft("in-10m", { meetingAt: now + 600_000 }),
      ],
      now,
    );
    expect(sorted.map((d) => d.id)).toEqual(["in-10m", "in-2h", "untimed", "over-recently", "over-long-ago"]);
  });

  it("sorts an org's drafts the same way, without touching the input", () => {
    const input = [
      draft("b", { meetingAt: 20, meetingOrgShare: { orgId: "acme", folderId: "f1", mode: "copy" } }),
      draft("a", { meetingAt: 10, meetingOrgShare: { orgId: "acme", folderId: null, mode: "copy" } }),
    ];
    expect(sortDrafts(draftsForOrg(input, "acme")).map((d) => d.id)).toEqual(["a", "b"]);
    expect(input.map((d) => d.id)).toEqual(["b", "a"]);
  });
});

describe("setDraftOpen with a preset", () => {
  it("points a new draft at the org's root; plain opening leaves the destination alone", async () => {
    const { useStore } = await import("../store");
    useStore.getState().resetPrep();
    useStore.getState().setDraftOpen(true);
    expect(useStore.getState().meetingOrgShare).toBeNull();
    useStore.getState().setDraftOpen(false);
    useStore.getState().setDraftOpen(true, { orgId: "acme", folderId: null });
    expect(useStore.getState().meetingOrgShare).toEqual({ orgId: "acme", folderId: null, mode: "copy" });
    useStore.getState().setDraftOpen(false);
    useStore.getState().resetPrep();
  });
});

describe("isStartingSoon", () => {
  const now = 1_000_000_000;
  const min = 60_000;

  it("takes a meeting starting within the hour, and not one further out", () => {
    expect(isStartingSoon(draft("a", { meetingAt: now + 30 * min }), now)).toBe(true);
    expect(isStartingSoon(draft("b", { meetingAt: now + STARTING_SOON_MS }), now)).toBe(true);
    expect(isStartingSoon(draft("c", { meetingAt: now + 61 * min }), now)).toBe(false);
  });

  it("keeps a meeting under way until it ends, an hour when it has no end", () => {
    expect(isStartingSoon(draft("a", { meetingAt: now - 10 * min, meetingEndAt: now + 20 * min }), now)).toBe(true);
    expect(isStartingSoon(draft("b", { meetingAt: now - 90 * min, meetingEndAt: now - min }), now)).toBe(false);
    expect(isStartingSoon(draft("c", { meetingAt: now - 30 * min }), now)).toBe(true);
    expect(isStartingSoon(draft("d", { meetingAt: now - 61 * min }), now)).toBe(false);
  });

  it("never takes an untimed draft", () => {
    expect(isStartingSoon(draft("a"), now)).toBe(false);
  });
});
