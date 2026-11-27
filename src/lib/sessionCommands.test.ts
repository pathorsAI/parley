import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./store";
import { applyRpcCommand } from "./sessionCommands";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
});

describe("create_meeting_draft", () => {
  it("files the playbook lists with the draft and lists them back as plain lists", async () => {
    const out = await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      branches: [
        { when: "too expensive", then: "Ask what they compare against" },
        { when: "half a branch" },
      ],
      topics: ["Their expansion plans"],
    });
    expect(out).toMatchObject({
      title: "Renewal",
      agenda: [],
      branches: [{ when: "too expensive", then: "Ask what they compare against" }],
      topics: ["Their expansion plans"],
    });
    const [saved] = useStore.getState().drafts;
    expect(out).not.toHaveProperty("questions");
    expect(saved.playbook.branches).toEqual([
      { id: expect.any(String), when: "too expensive", then: "Ask what they compare against" },
    ]);
    expect(await applyRpcCommand("list_meeting_drafts", {})).toEqual([out]);
  });

  it("without lists, files the empty playbook", async () => {
    const out = await applyRpcCommand("create_meeting_draft", { title: "Plain" });
    expect(out).toMatchObject({ agenda: [], branches: [], topics: [] });
    expect(useStore.getState().drafts[0].playbook).toEqual({ branches: [], topics: [] });
  });

  it("takes questions as an alias of agenda, appended to it and deduplicated by trimmed text", async () => {
    const out = await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      agenda: ["Confirm volume", " Budget? "],
      questions: ["  What does next year's volume look like?  ", "", "Budget?", "Confirm volume ", "What does next year's volume look like?"],
    });
    expect(out).toMatchObject({
      agenda: ["Confirm volume", "Budget?", "What does next year's volume look like?"],
    });
    const [saved] = useStore.getState().drafts;
    expect(saved.todos.every((t) => !t.done)).toBe(true);
    expect(saved.playbook).toEqual({ branches: [], topics: [] });
  });
});

describe("update_meeting_draft", () => {
  const HOUR = 3_600_000;

  it("changes only the fields it is given", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      startAt: "2026-11-03T14:00:00+08:00",
      endAt: "2026-11-03T14:30:00+08:00",
      context: "BATNA: stay with the current vendor",
      agenda: ["Confirm volume"],
      branches: [{ when: "too expensive", then: "Ask what they compare against" }],
      topics: ["Their expansion plans"],
    })) as { id: string };
    const out = await applyRpcCommand("update_meeting_draft", { id: made.id, topics: ["Hiring plans"] });
    expect(out).toEqual({ ...made, topics: ["Hiring plans"] });
    expect(await applyRpcCommand("list_meeting_drafts", {})).toEqual([out]);
  });

  it("replaces the agenda keeping the tick of an unchanged item, and appends questions", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      agenda: ["Confirm volume", "Budget?"],
    })) as { id: string };
    const [first] = useStore.getState().drafts[0].todos;
    useStore.setState((s) => ({
      drafts: s.drafts.map((d) => ({ ...d, todos: d.todos.map((t) => (t.id === first.id ? { ...t, done: true } : t)) })),
    }));
    await applyRpcCommand("update_meeting_draft", { id: made.id, agenda: ["Timeline?", " Confirm volume "] });
    expect(useStore.getState().drafts[0].todos).toEqual([
      { id: expect.any(String), text: "Timeline?", done: false },
      { id: first.id, text: "Confirm volume", done: true },
    ]);
    const out = await applyRpcCommand("update_meeting_draft", { id: made.id, questions: ["Timeline?", "Who signs?"] });
    expect(out).toMatchObject({ agenda: ["Timeline?", "Confirm volume", "Who signs?"] });
    expect(useStore.getState().drafts[0].todos[1]).toEqual({ id: first.id, text: "Confirm volume", done: true });
  });

  it("replaces a playbook list it is given, an empty one clearing it", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      branches: [{ when: "too expensive", then: "Ask what they compare against" }],
      topics: ["Their expansion plans"],
    })) as { id: string };
    const out = await applyRpcCommand("update_meeting_draft", {
      id: made.id,
      branches: [{ when: "need to ask my boss", then: "Offer to join that call" }],
      topics: [],
    });
    expect(out).toMatchObject({
      branches: [{ when: "need to ask my boss", then: "Offer to join that call" }],
      topics: [],
    });
  });

  it("moving the start keeps the meeting's length and re-arms the reminder", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      startAt: "2026-11-03T14:00:00+08:00",
      endAt: "2026-11-03T14:30:00+08:00",
    })) as { id: string };
    useStore.getState().markDraftReminded(made.id, Date.parse("2026-11-03T14:00:00+08:00"));
    const out = await applyRpcCommand("update_meeting_draft", { id: made.id, startAt: "2026-11-04T10:00:00+08:00" });
    expect(out).toMatchObject({
      title: "Renewal",
      startAt: new Date("2026-11-04T10:00:00+08:00").toISOString(),
      endAt: new Date("2026-11-04T10:30:00+08:00").toISOString(),
    });
    expect(useStore.getState().drafts[0].remindedFor).toBeNull();
    const untimed = await applyRpcCommand("update_meeting_draft", { id: made.id, startAt: null });
    expect(untimed).toMatchObject({ startAt: null, endAt: null });
    const timed = (await applyRpcCommand("update_meeting_draft", {
      id: made.id,
      startAt: "2026-11-05T10:00:00+08:00",
    })) as { startAt: string; endAt: string };
    expect(Date.parse(timed.endAt) - Date.parse(timed.startAt)).toBe(HOUR);
  });

  it("refuses an end without a start, an end before the start, and an unknown id", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", { title: "Untimed" })) as { id: string };
    await expect(
      applyRpcCommand("update_meeting_draft", { id: made.id, endAt: "2026-11-03T15:00:00+08:00" }),
    ).rejects.toThrow("endAt needs a startAt");
    await expect(
      applyRpcCommand("update_meeting_draft", {
        id: made.id,
        startAt: "2026-11-03T15:00:00+08:00",
        endAt: "2026-11-03T14:00:00+08:00",
      }),
    ).rejects.toThrow("endAt must be after startAt");
    await expect(applyRpcCommand("update_meeting_draft", { id: "nope", title: "x" })).rejects.toThrow(
      "no meeting draft with id nope",
    );
  });
});

describe("delete_meeting_draft", () => {
  it("removes the draft, and refuses an unknown id", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", { title: "Renewal" })) as { id: string };
    expect(await applyRpcCommand("delete_meeting_draft", { id: made.id })).toEqual({ id: made.id, deleted: true });
    expect(useStore.getState().drafts).toEqual([]);
    await expect(applyRpcCommand("delete_meeting_draft", { id: made.id })).rejects.toThrow("it was deleted");
    await expect(applyRpcCommand("delete_meeting_draft", { id: "nope" })).rejects.toThrow("no meeting draft with id nope");
  });
});

describe("the opening", () => {
  it("is filed with a new draft and listed back", async () => {
    const out = await applyRpcCommand("create_meeting_draft", {
      title: "Kickoff",
      opening: "  Thanks for making time. We have thirty minutes.  ",
      smallTalk: ["Did you make it to Hokkaido?", " ", "Did you make it to Hokkaido?"],
    });
    expect(out).toMatchObject({
      opening: "Thanks for making time. We have thirty minutes.",
      smallTalk: ["Did you make it to Hokkaido?"],
    });
    expect(useStore.getState().drafts[0].opening).toEqual({
      script: "Thanks for making time. We have thirty minutes.",
      smallTalk: ["Did you make it to Hokkaido?"],
    });
  });

  it("is empty on a draft created without one", async () => {
    expect(await applyRpcCommand("create_meeting_draft", { title: "Plain" })).toMatchObject({ opening: "", smallTalk: [] });
  });

  it("an update changes only the half it carries, and an empty value clears it", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Kickoff",
      opening: "Thanks for making time.",
      smallTalk: ["How was the launch?"],
    })) as { id: string };
    expect(await applyRpcCommand("update_meeting_draft", { id: made.id, title: "Kickoff 2" })).toMatchObject({
      opening: "Thanks for making time.",
      smallTalk: ["How was the launch?"],
    });
    expect(await applyRpcCommand("update_meeting_draft", { id: made.id, smallTalk: ["Busy season over?"] })).toMatchObject({
      opening: "Thanks for making time.",
      smallTalk: ["Busy season over?"],
    });
    expect(await applyRpcCommand("update_meeting_draft", { id: made.id, opening: "", smallTalk: [] })).toMatchObject({
      opening: "",
      smallTalk: [],
    });
  });
});

describe("a draft that left the list", () => {
  it("taken to record: the update says what happened, and restore brings it back", async () => {
    const made = (await applyRpcCommand("create_meeting_draft", {
      title: "Renewal",
      startAt: "2026-11-27T14:00:00+08:00",
      opening: "Thanks for making time.",
    })) as { id: string };
    expect(useStore.getState().takeDraft(made.id)).toBe(true);

    expect(await applyRpcCommand("list_meeting_drafts", {})).toEqual([]);
    const error = await applyRpcCommand("update_meeting_draft", { id: made.id, title: "x" }).catch((e: Error) => e.message);
    expect(error).toContain("the user started recording from it");
    expect(error).toContain("restore_meeting_draft");

    const listed = (await applyRpcCommand("list_meeting_drafts", { includeRemoved: true })) as Record<string, unknown>[];
    expect(listed).toEqual([
      expect.objectContaining({ id: made.id, title: "Renewal", removedReason: "recorded", removedAt: expect.any(String) }),
    ]);

    const restored = await applyRpcCommand("restore_meeting_draft", { id: made.id });
    expect(restored).toMatchObject({ id: made.id, title: "Renewal", opening: "Thanks for making time." });
    expect(await applyRpcCommand("list_meeting_drafts", { includeRemoved: true })).toEqual([restored]);
    // Restoring one that is already back is not an error.
    expect(await applyRpcCommand("restore_meeting_draft", { id: made.id })).toEqual(restored);
  });

  it("restore refuses an id that was never removed", async () => {
    await expect(applyRpcCommand("restore_meeting_draft", { id: "nope" })).rejects.toThrow("no removed meeting draft with id nope");
  });
});

describe("people notes", () => {
  beforeEach(async () => {
    (await import("./people/store")).resetPeopleForTests();
  });

  it("adds a note, lists the person, reads them back by name or alias-free id, and deletes", async () => {
    const added = (await applyRpcCommand("add_person_note", {
      name: "Ann Lee",
      org: "Acme",
      text: "Skiing in Hokkaido in December",
      saidAt: "2026-11-20T10:00:00+08:00",
    })) as { id: string; notes: { id: string; text: string; saidAt: string }[] };
    expect(added).toMatchObject({ name: "Ann Lee", org: "Acme", notes: [{ text: "Skiing in Hokkaido in December" }] });
    expect(added.notes[0].saidAt).toBe("2026-11-20T02:00:00.000Z");

    expect(await applyRpcCommand("list_people", {})).toEqual([
      { id: added.id, name: "Ann Lee", org: "Acme", aliases: [], notes: 1, lastSaidAt: "2026-11-20T02:00:00.000Z" },
    ]);
    expect(await applyRpcCommand("list_people", { query: "globex" })).toEqual([]);
    expect(await applyRpcCommand("get_person", { name: "ann lee" })).toEqual(added);
    expect(await applyRpcCommand("get_person", { id: added.id })).toEqual(added);

    expect(await applyRpcCommand("delete_person_note", { personId: added.id, noteId: added.notes[0].id })).toMatchObject({
      deleted: true,
    });
    expect(await applyRpcCommand("list_people", {})).toEqual([]);
    await expect(applyRpcCommand("get_person", { name: "Ann Lee" })).rejects.toThrow("no notes about Ann Lee");
  });

  it("never shows a candidate the user has not kept", async () => {
    const { mutatePeople } = await import("./people/store");
    const { withNote } = await import("./people/notes");
    await mutatePeople(
      (doc) => withNote(doc, { name: "Ann", text: "Moving in March", saidAt: 1, recordingId: "r1", status: "candidate" }, 1).doc,
    );
    expect(await applyRpcCommand("list_people", {})).toEqual([]);
    await expect(applyRpcCommand("get_person", { name: "Ann" })).rejects.toThrow("no notes about Ann");
  });

  it("refuses a blank note and an unknown note id", async () => {
    await expect(applyRpcCommand("add_person_note", { name: "Ann", text: " " })).rejects.toThrow("text is required");
    await expect(applyRpcCommand("get_person", {})).rejects.toThrow("id or name is required");
    await expect(applyRpcCommand("delete_person_note", { personId: "p", noteId: "n" })).rejects.toThrow("no note n on person p");
  });
});
