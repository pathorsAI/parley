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
