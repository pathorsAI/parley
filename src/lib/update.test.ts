import { describe, it, expect, beforeEach, vi } from "vitest";

// The boundaries the update flow crosses: the updater and process plugins, the
// Tauri IPC `invoke` (the show-on-next-launch marker in
// src-tauri/src/autostart.rs), the toast, and the store (only for the UI
// language). Every call lands in one ordered `calls` log, because the order is
// the point: the marker must exist BEFORE downloadAndInstall, which on Windows
// exits the process from inside the call.
const m = vi.hoisted(() => ({
  calls: [] as string[],
  check: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
  toast: Object.assign(vi.fn(), { loading: vi.fn(), error: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => m.check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => m.relaunch() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => m.invoke(...args) }));
vi.mock("sonner", () => ({ toast: m.toast }));
vi.mock("./tauriEvents", () => ({ isTauri: () => true }));
vi.mock("./store", () => ({ useStore: { getState: () => ({ settings: { language: "en" } }) } }));
vi.mock("./releaseNotes", () => ({ rememberPendingReleaseNotes: vi.fn() }));
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { checkForUpdate } from "./update";

/** An Update stand-in whose downloadAndInstall settles the way `outcome` says. */
function fakeUpdate(outcome: "installs" | "fails") {
  return {
    version: "9.9.9",
    body: "",
    downloadAndInstall: vi.fn(async () => {
      m.calls.push("downloadAndInstall");
      if (outcome === "fails") throw new Error("signature mismatch");
    }),
  };
}

/** Surface the update toast and click its "Update & restart" action. */
async function clickUpdateAndRestart(update: ReturnType<typeof fakeUpdate>) {
  m.check.mockResolvedValueOnce(update);
  await checkForUpdate();
  const options = m.toast.mock.lastCall?.[1] as { action: { onClick: () => void } };
  options.action.onClick();
}

beforeEach(() => {
  m.calls.length = 0;
  m.check.mockReset();
  m.relaunch.mockReset().mockImplementation(async () => {
    m.calls.push("relaunch");
  });
  m.invoke.mockReset().mockImplementation(async (cmd: string) => {
    m.calls.push(cmd);
  });
  m.toast.mockReset();
  m.toast.loading.mockReset();
  m.toast.error.mockReset();
});

describe("update & restart", () => {
  it("marks the next launch to show the window before downloading, then relaunches", async () => {
    await clickUpdateAndRestart(fakeUpdate("installs"));
    await vi.waitFor(() => expect(m.calls).toContain("relaunch"));
    expect(m.calls).toEqual(["mark_show_on_next_launch", "downloadAndInstall", "relaunch"]);
    expect(m.toast.error).not.toHaveBeenCalled();
  });

  it("clears the marker when downloadAndInstall fails, since nothing will relaunch", async () => {
    await clickUpdateAndRestart(fakeUpdate("fails"));
    await vi.waitFor(() => expect(m.calls).toContain("clear_show_on_next_launch"));
    expect(m.calls).toEqual(["mark_show_on_next_launch", "downloadAndInstall", "clear_show_on_next_launch"]);
    expect(m.toast.error).toHaveBeenCalled();
  });

  it("keeps the marker when only the relaunch fails: the update is staged", async () => {
    m.relaunch.mockImplementation(async () => {
      m.calls.push("relaunch");
      throw new Error("translocated");
    });
    await clickUpdateAndRestart(fakeUpdate("installs"));
    await vi.waitFor(() => expect(m.toast.error).toHaveBeenCalled());
    expect(m.calls).toEqual(["mark_show_on_next_launch", "downloadAndInstall", "relaunch"]);
  });

  it("still updates when the marker cannot be written", async () => {
    m.invoke.mockImplementation(async (cmd: string) => {
      m.calls.push(cmd);
      if (cmd === "mark_show_on_next_launch") throw new Error("read-only data dir");
    });
    await clickUpdateAndRestart(fakeUpdate("installs"));
    await vi.waitFor(() => expect(m.calls).toContain("relaunch"));
    expect(m.calls).toEqual(["mark_show_on_next_launch", "downloadAndInstall", "relaunch"]);
  });
});
