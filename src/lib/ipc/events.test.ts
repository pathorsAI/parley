import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: vi.fn() }));

import { createListenerScope, listenEvent, listenIfTauri } from "./events";

/** A listen() whose resolution the test controls. */
function deferredListen() {
  let resolve: (u: () => void) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<() => void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  mocks.listen.mockReset();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("listenEvent / listenIfTauri", () => {
  it("listenEvent is Tauri's listen, with the same two arguments", async () => {
    const handler = () => {};
    const un = () => {};
    mocks.listen.mockResolvedValue(un);
    expect(await listenEvent("x://y", handler)).toBe(un);
    expect(mocks.listen.mock.calls).toEqual([["x://y", handler]]);
  });

  it("listenIfTauri does nothing outside the Tauri shell", async () => {
    const un = await listenIfTauri("x://y", () => {});
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(() => un()).not.toThrow();
  });

  it("listenIfTauri subscribes inside it", async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const un = () => {};
    mocks.listen.mockResolvedValue(un);
    expect(await listenIfTauri("x://y", () => {})).toBe(un);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });
});

describe("createListenerScope", () => {
  it("releases every listener that resolved before dispose", async () => {
    const scope = createListenerScope(vi.fn());
    const a = vi.fn();
    const b = vi.fn();
    scope.track(Promise.resolve(a));
    scope.track(Promise.resolve(b));
    await flush();
    expect(a).not.toHaveBeenCalled();
    scope.dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    scope.dispose();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("unlistens a listener that resolves after dispose the moment it arrives", async () => {
    const scope = createListenerScope(vi.fn());
    const late = deferredListen();
    scope.track(late.promise);
    scope.dispose();
    const un = vi.fn();
    late.resolve(un);
    await flush();
    expect(un).toHaveBeenCalledTimes(1);
  });

  it("reports a listener that failed to register", async () => {
    const onError = vi.fn();
    const scope = createListenerScope(onError);
    const failing = deferredListen();
    scope.track(failing.promise);
    failing.reject(new Error("no window"));
    await flush();
    expect(onError).toHaveBeenCalledWith(new Error("no window"));
  });
});
