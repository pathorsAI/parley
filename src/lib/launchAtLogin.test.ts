import { describe, it, expect, beforeEach, vi } from "vitest";

// The two boundaries this module crosses: the Tauri IPC `invoke` (the Rust
// commands that own the OS login item) and the logger. `isTauri` is mocked so
// both the desktop and the plain-browser paths can be exercised.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const warn = vi.fn();
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: (...args: unknown[]) => warn(...args), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
let tauriFlag = true;
vi.mock("./platform", () => ({ isTauri: () => tauriFlag }));

import {
  LAUNCH_AT_LOGIN_TRANSLOCATED,
  isTranslocatedError,
  launchAtLoginStatus,
  setLaunchAtLogin,
} from "./launchAtLogin";

beforeEach(() => {
  invoke.mockReset();
  warn.mockReset();
  tauriFlag = true;
});

describe("launchAtLoginStatus", () => {
  it("returns the OS answer from Rust", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(launchAtLoginStatus()).resolves.toBe(true);
    invoke.mockResolvedValueOnce(false);
    await expect(launchAtLoginStatus()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("launch_at_login_status");
  });

  it("returns null and warns when the query fails, so the toggle renders disabled", async () => {
    invoke.mockRejectedValueOnce("registry unavailable");
    await expect(launchAtLoginStatus()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("autostart: status check failed", { error: "registry unavailable" });
  });

  it("returns null outside Tauri without touching IPC", async () => {
    tauriFlag = false;
    await expect(launchAtLoginStatus()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("setLaunchAtLogin", () => {
  it("returns the state Rust re-read, not the one requested", async () => {
    invoke.mockResolvedValueOnce(false);
    await expect(setLaunchAtLogin(true)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_launch_at_login", { enabled: true });
  });

  it("passes a rejection through so the UI can report it", async () => {
    invoke.mockRejectedValueOnce("login item state did not change");
    await expect(setLaunchAtLogin(false)).rejects.toBe("login item state did not change");
    expect(invoke).toHaveBeenCalledWith("set_launch_at_login", { enabled: false });
  });
});

describe("isTranslocatedError", () => {
  it("recognizes only Rust's translocated refusal", () => {
    expect(isTranslocatedError(LAUNCH_AT_LOGIN_TRANSLOCATED)).toBe(true);
    expect(isTranslocatedError("translocated")).toBe(true);
    expect(isTranslocatedError("Permission denied (os error 13)")).toBe(false);
    expect(isTranslocatedError(new Error("translocated path"))).toBe(false);
  });
});
