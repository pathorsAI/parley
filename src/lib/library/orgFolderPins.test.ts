import { describe, it, expect } from "vitest";
import { orgFolderPinnedAt, readOrgFolderPins, setOrgFolderPinned } from "./orgFolderPins";

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("parley:org-folder-pins", initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("org folder pins", () => {
  it("pins and unpins per org and folder", () => {
    const storage = memoryStorage();
    setOrgFolderPinned("o1", "f", true, 10, storage);

    const pins = readOrgFolderPins(storage);
    expect(orgFolderPinnedAt(pins, "o1", "f")).toBe(10);
    expect(orgFolderPinnedAt(pins, "o2", "f")).toBeUndefined();

    setOrgFolderPinned("o1", "f", false, 20, storage);
    expect(orgFolderPinnedAt(readOrgFolderPins(storage), "o1", "f")).toBeUndefined();
  });

  it("keeps the original stamp when pinning an already-pinned folder", () => {
    const storage = memoryStorage();
    setOrgFolderPinned("o1", "f", true, 10, storage);
    setOrgFolderPinned("o1", "f", true, 99, storage);
    expect(orgFolderPinnedAt(readOrgFolderPins(storage), "o1", "f")).toBe(10);
  });

  it("treats a garbled record as no pins, and drops non-numeric stamps", () => {
    expect(readOrgFolderPins(memoryStorage("{nope"))).toEqual({});
    expect(readOrgFolderPins(memoryStorage(JSON.stringify({ "o:a": 1, "o:b": "x" })))).toEqual({
      "o:a": 1,
    });
    expect(readOrgFolderPins(null)).toEqual({});
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readOrgFolderPins(broken)).toEqual({});
    expect(() => setOrgFolderPinned("o", "f", true, 1, broken)).not.toThrow();
  });
});
