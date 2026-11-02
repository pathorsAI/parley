import { describe, expect, it } from "vitest";
// The store first: prep.ts reaches it through ./meeting, and entering the
// cycle from the slice side would build the store before the slice exists.
import "../store";
import { draftsForOrg, sortDrafts, type MeetingDraft } from "./prep";

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
