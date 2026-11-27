import { describe, expect, it } from "vitest";
// The store first: prep.ts reaches it through ./meeting, and entering the
// cycle from the slice side would build the store before the slice exists.
import { useStore } from "../store";
import { emptyPlaybook } from "../meeting/playbook";
import { emptyOpening } from "../meeting/opening";
import { REMOVED_DRAFTS_KEPT } from "../meeting/removedDrafts";
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
    playbook: emptyPlaybook(),
    opening: emptyOpening(),
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

describe("the playbook in the prep", () => {
  const INITIAL = useStore.getState();
  const fill = () => {
    const s = useStore.getState();
    s.setMeetingTitle("Renewal");
    s.addPlaybookItem("branches", { when: "too expensive", then: "Ask what they compare against" });
    s.addPlaybookItem("topics", { text: "Expansion" });
  };
  const texts = () => {
    const p = useStore.getState().meetingPlaybook;
    return [p.branches.map((b) => `${b.when}→${b.then}`), p.topics.map((t) => t.text)];
  };

  it("is edited with the add / remove actions", () => {
    useStore.setState(INITIAL, true);
    fill();
    useStore.getState().removePlaybookItem("topics", useStore.getState().meetingPlaybook.topics[0].id);
    expect(texts()).toEqual([["too expensive→Ask what they compare against"], []]);
  });

  it("is saved with the draft, cleared for the next, and loaded back by edit and take", () => {
    useStore.setState(INITIAL, true);
    fill();
    const saved = useStore.getState().saveDraft()!;
    expect(saved.playbook.topics.map((t) => t.text)).toEqual(["Expansion"]);
    expect(useStore.getState().meetingPlaybook).toEqual(emptyPlaybook());

    useStore.getState().editDraft(saved.id);
    expect(useStore.getState().meetingPlaybook).toEqual(saved.playbook);
    useStore.getState().discardDraftEdit();
    expect(useStore.getState().meetingPlaybook).toEqual(emptyPlaybook());

    expect(useStore.getState().takeDraft(saved.id)).toBe(true);
    expect(useStore.getState().meetingPlaybook).toEqual(saved.playbook);
  });

  it("is cleared by resetPrep", () => {
    useStore.setState(INITIAL, true);
    fill();
    useStore.getState().resetPrep();
    expect(useStore.getState().meetingPlaybook).toEqual(emptyPlaybook());
  });

  it("comes with a draft added from outside (MCP), leaving the prep alone", () => {
    useStore.setState(INITIAL, true);
    const playbook = { ...emptyPlaybook(), topics: [{ id: "t1", text: "Expansion" }] };
    const d = useStore.getState().addDraft({
      title: "From MCP",
      meetingAt: null,
      meetingEndAt: null,
      reminderLeadMin: null,
      meetingContext: "",
      meetingFolderId: null,
      agenda: [],
      opening: emptyOpening(),
      playbook,
    });
    expect(d.playbook).toEqual(playbook);
    expect(useStore.getState().meetingPlaybook).toEqual(emptyPlaybook());
  });
});

describe("the opening in the prep", () => {
  const INITIAL = useStore.getState();

  it("is saved with the draft, cleared for the next, and loaded back by edit and take", () => {
    useStore.setState(INITIAL, true);
    const s = useStore.getState();
    s.setMeetingTitle("Kickoff");
    s.setOpeningScript("  Thanks for making time.  ");
    s.addSmallTalk("Did you make it to Hokkaido?");
    s.addSmallTalk("Busy season over?");
    s.removeSmallTalk(1);
    const saved = useStore.getState().saveDraft()!;
    expect(saved.opening).toEqual({ script: "Thanks for making time.", smallTalk: ["Did you make it to Hokkaido?"] });
    expect(useStore.getState().meetingOpening).toEqual(emptyOpening());

    useStore.getState().editDraft(saved.id);
    expect(useStore.getState().meetingOpening).toEqual(saved.opening);
    useStore.getState().discardDraftEdit();
    expect(useStore.getState().meetingOpening).toEqual(emptyOpening());

    expect(useStore.getState().takeDraft(saved.id)).toBe(true);
    expect(useStore.getState().meetingOpening).toEqual(saved.opening);
  });
});

describe("drafts that leave the list", () => {
  const INITIAL = useStore.getState();
  const removedIds = () => useStore.getState().removedDrafts.map((r) => `${r.draft.id}:${r.reason}`);

  it("a draft taken to record is kept as recorded, and restore puts it back as a fresh write", () => {
    useStore.setState(INITIAL, true);
    useStore.setState({ drafts: [draft("a", { title: "Renewal", remindedFor: 5, updatedAt: 1 }), draft("b")] });
    expect(useStore.getState().takeDraft("a")).toBe(true);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual(["b"]);
    expect(removedIds()).toEqual(["a:recorded"]);

    const back = useStore.getState().restoreDraft("a")!;
    expect(back).toMatchObject({ id: "a", title: "Renewal", remindedFor: null });
    expect(back.updatedAt).toBeGreaterThan(1);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual(["b", "a"]);
    expect(removedIds()).toEqual([]);
    expect(useStore.getState().restoreDraft("a")).toBeNull();
  });

  it("a deleted draft is kept as deleted; deleting an unknown id files nothing", () => {
    useStore.setState(INITIAL, true);
    useStore.setState({ drafts: [draft("a")] });
    useStore.getState().deleteDraft("a");
    useStore.getState().deleteDraft("nope");
    expect(removedIds()).toEqual(["a:deleted"]);
  });

  it("a draft the cloud sync removes is kept as removed elsewhere, and one that comes back is no longer removed", () => {
    useStore.setState(INITIAL, true);
    useStore.setState({ drafts: [draft("a"), draft("b")] });
    useStore.getState().mergeCloudDrafts([], ["a"]);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual(["b"]);
    expect(removedIds()).toEqual(["a:elsewhere"]);

    useStore.getState().mergeCloudDrafts([draft("a", { title: "Back" })], []);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual(["b", "a"]);
    expect(removedIds()).toEqual([]);
  });

  it("keeps the newest REMOVED_DRAFTS_KEPT, newest first", () => {
    useStore.setState(INITIAL, true);
    const many = Array.from({ length: REMOVED_DRAFTS_KEPT + 3 }, (_, i) => draft(`d${i}`));
    useStore.setState({ drafts: many });
    for (const d of many) useStore.getState().deleteDraft(d.id);
    const kept = useStore.getState().removedDrafts;
    expect(kept).toHaveLength(REMOVED_DRAFTS_KEPT);
    expect(kept[0].draft.id).toBe(`d${REMOVED_DRAFTS_KEPT + 2}`);
  });
});
