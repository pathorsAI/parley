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
    await expect(applyRpcCommand("delete_meeting_draft", { id: made.id })).rejects.toThrow("no meeting draft with id");
  });
});
