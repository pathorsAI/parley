import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Boundaries: Tauri IPC (the JSONL file lives behind three Rust commands), the
// event bus the list listens on, and the logger. The ordering — write first,
// broadcast only after the write succeeded — is what's under test.
const mocks = vi.hoisted(() => {
  type Handler = (e: { payload: unknown }) => void;
  const state: { handler: Handler | null } = { handler: null };
  return {
    state,
    invoke: vi.fn(),
    emit: vi.fn(async (..._args: unknown[]) => {}),
    listen: vi.fn(async (_name: string, h: Handler) => {
      state.handler = h;
      return () => {};
    }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => mocks.emit(...args),
  listen: (name: string, h: (e: { payload: unknown }) => void) => mocks.listen(name, h),
}));
vi.mock("../log", () => ({ log: mocks.log, attachConsoleOnce: vi.fn() }));

import {
  appendVoiceEntry,
  clearVoiceEntries,
  deleteVoiceEntry,
  listenForVoiceHistoryChanged,
  updateVoiceEntryText,
  VOICE_HISTORY_CHANGED_EVENT,
} from "./history";

const FIXTURE = [
  JSON.stringify({ id: "a1", text: "alpha", ts: 1_000 }),
  JSON.stringify({ id: "b2", text: "beta", ts: 2_000, appBundleId: "com.apple.Notes" }),
].join("\n");

/** Route the history commands; `fail` makes the named command reject. */
function routeInvoke(fail: string[] = []) {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (fail.includes(cmd)) throw new Error(`${cmd} failed`);
    if (cmd === "read_voice_history") return `${FIXTURE}\n`;
    if (cmd === "append_voice_history" || cmd === "write_voice_history") return undefined;
    throw new Error(`unexpected command ${cmd}`);
  });
}

function calls(cmd: string): unknown[][] {
  return mocks.invoke.mock.calls.filter((c) => c[0] === cmd);
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mocks.invoke.mockReset();
  mocks.emit.mockReset();
  mocks.emit.mockImplementation(async () => {});
  mocks.listen.mockClear();
  mocks.log.warn.mockClear();
  mocks.state.handler = null;
  routeInvoke();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("appendVoiceEntry", () => {
  it("writes the line, then broadcasts the appended id", async () => {
    await appendVoiceEntry("hello", "com.apple.Notes");

    const appends = calls("append_voice_history");
    expect(appends).toHaveLength(1);
    const line = JSON.parse((appends[0][1] as { line: string }).line) as {
      id: string;
      text: string;
      appBundleId?: string;
    };
    expect(line.text).toBe("hello");
    expect(line.appBundleId).toBe("com.apple.Notes");

    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(VOICE_HISTORY_CHANGED_EVENT, {
      kind: "append",
      id: line.id,
    });
    // The list's re-read must find the line on disk, so the write comes first.
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emit.mock.invocationCallOrder[0],
    );
  });

  it("logs and broadcasts nothing when the write fails", async () => {
    routeInvoke(["append_voice_history"]);

    await expect(appendVoiceEntry("hello", null)).resolves.toBeUndefined();

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "voice typing history: append failed",
      expect.objectContaining({ error: expect.stringContaining("append_voice_history failed") }),
    );
  });

  it("ignores whitespace-only text", async () => {
    await appendVoiceEntry("  \n ");

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("still resolves when the broadcast itself fails", async () => {
    mocks.emit.mockRejectedValueOnce(new Error("bus down"));

    await expect(appendVoiceEntry("hello")).resolves.toBeUndefined();

    expect(calls("append_voice_history")).toHaveLength(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "voice typing history: change broadcast failed",
      expect.objectContaining({ kind: "append" }),
    );
  });
});

describe("updateVoiceEntryText", () => {
  it("rewrites the file with the new text, then broadcasts the update", async () => {
    await updateVoiceEntryText("a1", "x");

    const writes = calls("write_voice_history");
    expect(writes).toHaveLength(1);
    const lines = (writes[0][1] as { content: string }).content.trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { text: string }).text)).toEqual(["x", "beta"]);
    expect(mocks.emit).toHaveBeenCalledWith(VOICE_HISTORY_CHANGED_EVENT, {
      kind: "update",
      id: "a1",
    });
  });

  it("neither writes nor broadcasts for an unknown id", async () => {
    await updateVoiceEntryText("missing", "x");

    expect(calls("write_voice_history")).toHaveLength(0);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe("deleteVoiceEntry", () => {
  it("writes the remaining entries, then broadcasts the delete", async () => {
    await deleteVoiceEntry("b2");

    const writes = calls("write_voice_history");
    expect(writes).toHaveLength(1);
    const content = (writes[0][1] as { content: string }).content;
    expect(content).toContain("alpha");
    expect(content).not.toContain("beta");
    expect(mocks.emit).toHaveBeenCalledWith(VOICE_HISTORY_CHANGED_EVENT, {
      kind: "delete",
      id: "b2",
    });
  });

  it("broadcasts nothing when the write fails", async () => {
    routeInvoke(["write_voice_history"]);

    await expect(deleteVoiceEntry("a1")).resolves.toBeUndefined();

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "voice typing history: write failed",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("does not rewrite the file when the read failed", async () => {
    // A failed read comes back as []; writing that back would erase every
    // other dictation.
    routeInvoke(["read_voice_history"]);

    await deleteVoiceEntry("a1");

    expect(calls("write_voice_history")).toHaveLength(0);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe("clearVoiceEntries", () => {
  it("empties the file, then broadcasts the clear", async () => {
    await clearVoiceEntries();

    expect(calls("write_voice_history")).toEqual([["write_voice_history", { content: "" }]]);
    expect(mocks.emit).toHaveBeenCalledWith(VOICE_HISTORY_CHANGED_EVENT, { kind: "clear" });
  });

  it("broadcasts nothing when the write fails", async () => {
    routeInvoke(["write_voice_history"]);

    await clearVoiceEntries();

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "voice typing history: clear failed",
      expect.anything(),
    );
  });
});

describe("listenForVoiceHistoryChanged", () => {
  it("hands each broadcast's payload to the callback", async () => {
    const cb = vi.fn();

    await listenForVoiceHistoryChanged(cb);
    expect(mocks.listen).toHaveBeenCalledWith(VOICE_HISTORY_CHANGED_EVENT, expect.any(Function));
    mocks.state.handler?.({ payload: { kind: "append", id: "a" } });

    expect(cb).toHaveBeenCalledWith({ kind: "append", id: "a" });
  });

  it("is a no-op outside Tauri, and so is recording", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;

    const un = await listenForVoiceHistoryChanged(vi.fn());
    expect(typeof un).toBe("function");
    expect(() => un()).not.toThrow();
    expect(mocks.listen).not.toHaveBeenCalled();

    await appendVoiceEntry("hello");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
