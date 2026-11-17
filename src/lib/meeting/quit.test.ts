import { beforeEach, describe, expect, it, vi } from "vitest";

// Quit must not exit under a meeting: ⌘Q mid-meeting used to kill the process
// before the transcript was saved, leaving an audio-only recording with no
// summary, action items or score.
const mocks = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../history/history", async () => {
  const { PendingSaves } = await import("./pendingSaves");
  return { liveSaves: new PendingSaves<string>() };
});
vi.mock("../notify", () => ({
  notify: { message: (t: string) => mocks.notices.push(t), success: vi.fn(), error: vi.fn() },
}));

import { liveSaves } from "../history/history";
import { quitAfterSaving } from "./quit";

const saves = liveSaves as unknown as import("./pendingSaves").PendingSaves<string>;

/** What the main window's End does to liveSaves: the stop captures the
 *  meeting, and the save settles it later. */
function endThatCaptures(id: string): () => Promise<void> {
  return async () => {
    saves.markRecording(id);
    saves.capture(id, "snapshot");
  };
}

describe("quitAfterSaving", () => {
  beforeEach(() => {
    mocks.notices.length = 0;
  });

  it("exits only after the stopped meeting's save settles", async () => {
    const exit = vi.fn();
    const quitting = quitAfterSaving(endThatCaptures("m1"), exit, { meetingActive: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.notices).toHaveLength(1);

    saves.settle("m1");
    await quitting;
    expect(exit).toHaveBeenCalledOnce();
  });

  it("exits at once, silently, with no meeting to save", async () => {
    const exit = vi.fn();
    await quitAfterSaving(async () => {}, exit, { meetingActive: false });
    expect(exit).toHaveBeenCalledOnce();
    expect(mocks.notices).toHaveLength(0);
  });

  it("still exits when the save never finishes", async () => {
    const exit = vi.fn();
    await quitAfterSaving(endThatCaptures("m2"), exit, { meetingActive: true, waitMs: 20 });
    expect(exit).toHaveBeenCalledOnce();
    saves.settle("m2");
  });

  it("still exits when ending the meeting throws", async () => {
    const exit = vi.fn();
    await quitAfterSaving(() => Promise.reject(new Error("boom")), exit, { meetingActive: true });
    expect(exit).toHaveBeenCalledOnce();
  });
});
