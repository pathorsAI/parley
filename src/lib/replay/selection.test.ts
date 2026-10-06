import { describe, expect, it } from "vitest";
import { isTextSelected } from "./selection";

describe("isTextSelected", () => {
  it("is false with no selection, or the collapsed caret a plain click leaves", () => {
    expect(isTextSelected(null)).toBe(false);
    expect(isTextSelected(undefined)).toBe(false);
    expect(isTextSelected({ isCollapsed: true })).toBe(false);
  });

  it("is true once a drag has highlighted text", () => {
    expect(isTextSelected({ isCollapsed: false })).toBe(true);
  });
});
