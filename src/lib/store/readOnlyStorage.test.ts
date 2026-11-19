import { afterEach, describe, expect, it } from "vitest";
import { READ_ONLY_STORAGE } from "./persistence";

// The test environment is plain Node: give it the one localStorage it needs.
const backing = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: () => null,
  length: 0,
} as Storage;

afterEach(() => backing.clear());

describe("READ_ONLY_STORAGE", () => {
  it("hydrates from the shared key", async () => {
    backing.set("parley-settings", JSON.stringify({ state: { drafts: [1, 2] }, version: 4 }));
    expect(await READ_ONLY_STORAGE!.getItem("parley-settings")).toEqual({ state: { drafts: [1, 2] }, version: 4 });
  });

  it("never writes or removes it: a secondary window cannot undo the main window's state", async () => {
    backing.set("parley-settings", "main");
    await READ_ONLY_STORAGE!.setItem("parley-settings", { state: { drafts: [] }, version: 4 });
    await READ_ONLY_STORAGE!.removeItem("parley-settings");
    expect(backing.get("parley-settings")).toBe("main");
  });
});
