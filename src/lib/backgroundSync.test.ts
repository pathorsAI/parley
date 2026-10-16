import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Timing contract of the two store → file mirrors: session.json (600 ms after
// the last change, seeded at start, a pending write dropped on teardown) and
// templates.json (400 ms after the template lists change, never echoing a load
// from the file back, a pending save still landing after teardown).

vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("./platform", async (orig) => ({
  ...(await orig<typeof import("./platform")>()),
  isTauri: () => true,
}));

const files = vi.hoisted(() => ({ templates: "" }));
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, _args?: unknown) => (cmd === "read_templates" ? files.templates : undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const focus = new Map<string, () => void>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (n: string, f: () => void) => { focus.set(n, f); },
  removeEventListener: (n: string) => { focus.delete(n); },
};

import { useStore } from "./store";
import { initSessionSync } from "./sessionSync";
import { initTemplatesSync } from "./templatesSync";

const INITIAL = useStore.getInitialState();
const callsOf = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  useStore.setState(INITIAL, true);
  invoke.mockClear();
  focus.clear();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe("session.json mirror", () => {
  it("seeds once, then writes 600 ms after the last change", async () => {
    const stop = initSessionSync();
    await vi.advanceTimersByTimeAsync(599);
    expect(callsOf("write_session")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsOf("write_session")).toHaveLength(1);

    useStore.getState().setMeetingContext("a");
    await vi.advanceTimersByTimeAsync(300);
    useStore.getState().setHighlightMs(4);
    await vi.advanceTimersByTimeAsync(599);
    expect(callsOf("write_session")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsOf("write_session")).toHaveLength(2);
    // The snapshot is read when the write fires.
    const json = JSON.parse((callsOf("write_session")[1][1] as { json: string }).json);
    expect(json.updatedAt).toBe(1_000 + 600 + 300 + 600);
    stop();
  });

  it("teardown drops a pending write and stops listening", async () => {
    const stop = initSessionSync();
    stop();
    useStore.getState().setMeetingContext("late");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callsOf("write_session")).toHaveLength(0);
  });
});

describe("templates.json mirror", () => {
  it("loads from the file without echoing, then saves 400 ms after a template edit", async () => {
    files.templates = JSON.stringify({ evalTemplates: [], todoTemplates: [] });
    const stop = initTemplatesSync();
    await vi.advanceTimersByTimeAsync(0);
    // The load writes the reconciled set back once, directly — not via the debounce.
    expect(callsOf("write_templates")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsOf("write_templates")).toHaveLength(1);

    // Unrelated changes never save.
    useStore.getState().setMeetingContext("x");
    useStore.getState().updateSettings({ userName: "n" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsOf("write_templates")).toHaveLength(1);

    const s = useStore.getState().settings;
    useStore.getState().updateSettings({ todoTemplates: [...s.todoTemplates] });
    await vi.advanceTimersByTimeAsync(200);
    useStore.getState().updateSettings({ evalTemplates: [...s.evalTemplates] });
    await vi.advanceTimersByTimeAsync(399);
    expect(callsOf("write_templates")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsOf("write_templates")).toHaveLength(2);
    stop();
    expect(focus.has("focus")).toBe(false);
  });

  it("a save pending at teardown still lands", async () => {
    files.templates = "";
    const stop = initTemplatesSync();
    await vi.advanceTimersByTimeAsync(0);
    const before = callsOf("write_templates").length;
    const s = useStore.getState().settings;
    useStore.getState().updateSettings({ todoTemplates: [...s.todoTemplates] });
    stop();
    await vi.advanceTimersByTimeAsync(400);
    expect(callsOf("write_templates")).toHaveLength(before + 1);
  });

  it("focus reloads from the file", async () => {
    files.templates = JSON.stringify({ evalTemplates: [], todoTemplates: [] });
    const stop = initTemplatesSync();
    await vi.advanceTimersByTimeAsync(0);
    focus.get("focus")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf("read_templates")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsOf("write_templates")).toHaveLength(2);
    stop();
  });
});
