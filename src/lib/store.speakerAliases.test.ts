import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "./store";
import { seg } from "./test/fixtures";

const INITIAL = useStore.getInitialState();
beforeEach(() => useStore.setState(INITIAL, true));

describe("setSpeakerName keeps a speaker's old names as aliases", () => {
  it("records the previous custom name, once", () => {
    const s = useStore.getState();
    s.setSpeakerName("them-1", "Alice");
    expect(useStore.getState().speakerAliases).toEqual({});
    s.setSpeakerName("them-1", "Dana");
    s.setSpeakerName("them-1", "Alice");
    s.setSpeakerName("them-1", "Dana");
    expect(useStore.getState().speakerNames).toEqual({ "them-1": "Dana" });
    expect(useStore.getState().speakerAliases).toEqual({ "them-1": ["Alice"] });
  });

  it("keeps the name when it is cleared, and only for that speaker", () => {
    const s = useStore.getState();
    s.setSpeakerName("them-1", "Alice");
    s.setSpeakerName("them-2", "Bob");
    s.setSpeakerName("them-1", "");
    expect(useStore.getState().speakerNames).toEqual({ "them-2": "Bob" });
    expect(useStore.getState().speakerAliases).toEqual({ "them-1": ["Alice"] });
  });

  it("ignores the keystrokes on the way to a new name", () => {
    const s = useStore.getState();
    s.setSpeakerName("mix-1", "Bob");
    for (const v of ["Bo", "B", "", "J", "Ja", "Jac", "Jack"]) s.setSpeakerName("mix-1", v);
    expect(useStore.getState().speakerAliases).toEqual({ "mix-1": ["Bob"] });
  });

  it("is reset with the names when the recording is diarized again", () => {
    const s = useStore.getState();
    s.setSpeakerName("them-1", "Alice");
    s.setSpeakerName("them-1", "Dana");
    s.applyDiarizedSpeakers([seg({ id: "a" })], {});
    expect(useStore.getState().speakerAliases).toEqual({});
  });
});
