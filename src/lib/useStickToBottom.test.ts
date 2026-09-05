import { describe, it, expect } from "vitest";
import { isAtBottom, isUserTakeover } from "./useStickToBottom";

describe("isAtBottom", () => {
  it("is true when the viewport is parked exactly at the bottom", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1200, clientHeight: 400 }, 48)).toBe(true);
  });

  it("is true within the threshold of the bottom", () => {
    expect(isAtBottom({ scrollTop: 760, scrollHeight: 1200, clientHeight: 400 }, 48)).toBe(true);
    // Exactly on the threshold still counts as the tail.
    expect(isAtBottom({ scrollTop: 752, scrollHeight: 1200, clientHeight: 400 }, 48)).toBe(true);
  });

  it("is false once the user is further up than the threshold", () => {
    expect(isAtBottom({ scrollTop: 751, scrollHeight: 1200, clientHeight: 400 }, 48)).toBe(false);
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 1200, clientHeight: 400 }, 48)).toBe(false);
  });

  it("is true while the content is shorter than the viewport (nothing to scroll)", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 400 }, 48)).toBe(true);
  });

  it("is false for a viewport shorter than its content and scrolled to the top", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 401, clientHeight: 400 }, 0)).toBe(false);
    // ...though the same one-pixel overflow is within a 48px threshold.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 401, clientHeight: 400 }, 48)).toBe(true);
  });

  it("tolerates the sub-pixel overshoot browsers report at the very bottom", () => {
    expect(isAtBottom({ scrollTop: 800.4, scrollHeight: 1200, clientHeight: 400 }, 0)).toBe(true);
  });
});

describe("isUserTakeover", () => {
  it("reads upward movement as the user — a scrollbar thumb dragged back up", () => {
    expect(isUserTakeover({ scrollTop: 600, previousScrollTop: 800 }, 2)).toBe(true);
  });

  it("leaves our own tail-chasing scroll alone as it travels down", () => {
    expect(isUserTakeover({ scrollTop: 800, previousScrollTop: 600 }, 2)).toBe(false);
  });

  it("ignores a viewport that has not moved", () => {
    expect(isUserTakeover({ scrollTop: 800, previousScrollTop: 800 }, 2)).toBe(false);
  });

  it("absorbs sub-pixel jitter below the tolerance", () => {
    expect(isUserTakeover({ scrollTop: 799.5, previousScrollTop: 800 }, 2)).toBe(false);
    // Exactly on the tolerance is still jitter; one pixel more is a hand.
    expect(isUserTakeover({ scrollTop: 798, previousScrollTop: 800 }, 2)).toBe(false);
    expect(isUserTakeover({ scrollTop: 797.9, previousScrollTop: 800 }, 2)).toBe(true);
  });
});
