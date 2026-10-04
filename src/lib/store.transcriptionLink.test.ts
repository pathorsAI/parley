import { describe, it, expect, beforeEach, vi } from "vitest";

// The store calls `log.*`, whose Tauri-less path touches `window`. Logging is a
// side channel, not what these cases are about — stub it to a no-op.
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "./store";

// The store is a singleton: restore the pristine initial state before each case.
const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useStore.getState().startMeeting();
});

const report = (source: string, state: "live" | "reconnecting") =>
  useStore.getState().reportTranscriptionLink(source, state);

describe("transcription link (#570: a dropped connection pauses, never ends, the meeting)", () => {
  it("starts live and undropped", () => {
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionDropped).toBe(false);
    expect(s.transcriptionReconnectingSources).toEqual([]);
  });

  it("a leg's first handshake (live with nothing reconnecting) changes nothing", () => {
    report("mix", "live");
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionDropped).toBe(false);
  });

  it("reconnecting raises the link and marks the meeting as dropped", () => {
    report("mix", "reconnecting");
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("reconnecting");
    expect(s.transcriptionDropped).toBe(true);
    expect(s.transcriptionReconnectingSources).toEqual(["mix"]);
  });

  it("repeated attempts from one source keep one entry, and one live clears it", () => {
    report("mix", "reconnecting");
    report("mix", "reconnecting");
    report("mix", "reconnecting");
    expect(useStore.getState().transcriptionReconnectingSources).toEqual(["mix"]);

    report("mix", "live");
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionReconnectingSources).toEqual([]);
    // Sticky for the rest of the meeting: the save reads it after stop.
    expect(s.transcriptionDropped).toBe(true);
  });

  it("with two sessions, stays reconnecting until EVERY dropped source is live", () => {
    report("me", "reconnecting");
    report("them", "reconnecting");

    report("me", "live");
    expect(useStore.getState().transcriptionLink).toBe("reconnecting");
    expect(useStore.getState().transcriptionReconnectingSources).toEqual(["them"]);

    report("them", "live");
    expect(useStore.getState().transcriptionLink).toBe("live");
  });

  it("a live from a source that never dropped does not clear another's reconnect", () => {
    report("them", "reconnecting");
    report("me", "live");
    expect(useStore.getState().transcriptionLink).toBe("reconnecting");
    expect(useStore.getState().transcriptionReconnectingSources).toEqual(["them"]);
  });

  it("still tracks while paused — a paused meeting keeps its sessions", () => {
    useStore.getState().pauseMeeting();
    report("mix", "reconnecting");
    expect(useStore.getState().transcriptionLink).toBe("reconnecting");
  });

  it("stop lowers the banner but keeps transcriptionDropped for the save", () => {
    report("mix", "reconnecting");
    useStore.getState().stopMeeting();
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionReconnectingSources).toEqual([]);
    expect(s.transcriptionDropped).toBe(true);
  });

  it("ignores a stray reconnecting after stop (teardown race)", () => {
    useStore.getState().stopMeeting();
    report("mix", "reconnecting");
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionDropped).toBe(false);
  });

  it("startMeeting resets both the link and the dropped flag", () => {
    report("me", "reconnecting");
    useStore.getState().stopMeeting();
    // Leave the link mid-reconnect too, to prove start clears it on its own.
    useStore.setState({ transcriptionLink: "reconnecting", transcriptionReconnectingSources: ["me"] });

    useStore.getState().startMeeting();
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionDropped).toBe(false);
    expect(s.transcriptionReconnectingSources).toEqual([]);
  });

  it("cancelMeeting clears everything (nothing will be saved)", () => {
    report("mix", "reconnecting");
    useStore.getState().cancelMeeting();
    const s = useStore.getState();
    expect(s.transcriptionLink).toBe("live");
    expect(s.transcriptionDropped).toBe(false);
    expect(s.transcriptionReconnectingSources).toEqual([]);
  });
});
