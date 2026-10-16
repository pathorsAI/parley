import { describe, it, expect } from "vitest";
import { renameTarget } from "./rename";
import { formatElapsedClock } from "../meeting/elapsed";

describe("renameTarget", () => {
  it("saves a trimmed, changed name of a saved recording", () => {
    expect(renameTarget("  New  ", "Old", "h1")).toBe("New");
  });
  it("saves nothing for an empty or unchanged draft, or an unsaved recording", () => {
    expect(renameTarget("   ", "Old", "h1")).toBeNull();
    expect(renameTarget(" Old ", "Old", "h1")).toBeNull();
    expect(renameTarget("New", "Old", null)).toBeNull();
  });
});

describe("formatElapsedClock", () => {
  it("formats MM:SS with zero padding and keeps counting minutes", () => {
    expect(formatElapsedClock(0)).toBe("00:00");
    expect(formatElapsedClock(65_999)).toBe("01:05");
    expect(formatElapsedClock(6_000_000)).toBe("100:00");
  });
});
