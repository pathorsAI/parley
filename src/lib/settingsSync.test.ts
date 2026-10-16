import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// The settings window ↔ main window contract. Who broadcasts (only an edit
// made in the Settings window), when (right after the store applied it, with
// the post-update settings), and what the receiving window does with it
// (applySettings — which never broadcasts back, so there is no echo).

vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

const tauri = vi.hoisted(() => ({ on: true }));
vi.mock("./platform", async (orig) => ({
  ...(await orig<typeof import("./platform")>()),
  isTauri: () => tauri.on,
}));

const { emit, listen, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  return {
    handlers,
    emit: vi.fn(async (..._args: unknown[]) => {}),
    listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));

const domListeners = new Map<string, (e: unknown) => void>();
const g = globalThis as unknown as {
  addEventListener: (n: string, f: (e: unknown) => void) => void;
  removeEventListener: (n: string, f: (e: unknown) => void) => void;
};
g.addEventListener = (n, f) => void domListeners.set(n, f);
g.removeEventListener = (n) => void domListeners.delete(n);
afterAll(() => {
  delete (g as Partial<typeof g>).addEventListener;
  delete (g as Partial<typeof g>).removeEventListener;
});

import { useStore } from "./store";
import { broadcastSettings, listenForSettings } from "./settingsSync";

const INITIAL = useStore.getInitialState();

/** What every Settings-window edit does: apply it, then hand the result to the
 *  other windows. */
function settingsWindowEdit(patch: Parameters<ReturnType<typeof useStore.getState>["updateSettings"]>[0]) {
  useStore.getState().updateSettings(patch);
  return broadcastSettings({ ...useStore.getState().settings });
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  emit.mockClear();
  listen.mockClear();
  handlers.clear();
  domListeners.clear();
  tauri.on = true;
});

describe("settings broadcast", () => {
  it("a plain store update (any non-Settings window) broadcasts nothing", () => {
    useStore.getState().updateSettings({ userName: "Ann" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a Settings-window edit broadcasts the post-update settings once", async () => {
    await settingsWindowEdit({ userName: "Ann", language: "en" });
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0];
    expect(name).toBe("settings://updated");
    expect(payload).toEqual(useStore.getState().settings);
    // A copy, not the live object.
    expect(payload).not.toBe(useStore.getState().settings);
    expect((payload as { language: string }).language).toBe("en");
  });

  it("broadcasts nothing outside the Tauri shell", async () => {
    tauri.on = false;
    await settingsWindowEdit({ userName: "Ann" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("applySettings never broadcasts", () => {
    useStore.getState().applySettings({ ...useStore.getState().settings, userName: "Z" });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("receiving window", () => {
  it("applies a broadcast without echoing it back", async () => {
    const un = await listenForSettings();
    const incoming = { ...useStore.getState().settings, userName: "From settings" };
    handlers.get("settings://updated")!({ payload: incoming });
    expect(useStore.getState().settings).toBe(incoming);
    expect(emit).not.toHaveBeenCalled();
    un();
    expect(handlers.has("settings://updated")).toBe(false);
    expect(domListeners.has("storage")).toBe(false);
  });

  it("applies the persisted settings + sign-in from a storage event", async () => {
    await listenForSettings();
    const incoming = { ...useStore.getState().settings, userName: "Stored" };
    const auth = { token: "t", email: "e" };
    domListeners.get("storage")!({
      key: "parley-settings",
      newValue: JSON.stringify({ state: { settings: incoming, cloudAuth: auth }, version: 4 }),
    });
    expect(useStore.getState().settings).toEqual(incoming);
    expect(useStore.getState().cloudAuth).toEqual(auth);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores storage events for other keys", async () => {
    await listenForSettings();
    const before = useStore.getState().settings;
    domListeners.get("storage")!({ key: "other", newValue: "{}" });
    expect(useStore.getState().settings).toBe(before);
  });

  it("outside Tauri listens to storage only", async () => {
    tauri.on = false;
    const un = await listenForSettings();
    expect(listen).not.toHaveBeenCalled();
    expect(domListeners.has("storage")).toBe(true);
    un();
    expect(domListeners.has("storage")).toBe(false);
  });
});
