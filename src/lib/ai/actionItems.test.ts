import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mapActionItem } from "./actionItems";
import type { TimelineEvent } from "../types";

describe("mapActionItem — side and owner", () => {
  const none = new Map<string, TimelineEvent>();

  it("carries a valid side and a trimmed owner", () => {
    const a = mapActionItem({ text: "Send the quote", side: "us", owner: " Kevin " }, "1", none);
    expect(a).toMatchObject({ side: "us", owner: "Kevin" });
    expect(mapActionItem({ text: "Confirm budget", side: "them", owner: null }, "2", none)?.side).toBe("them");
  });

  it("leaves both absent when the model gave null, blank, or an unknown side", () => {
    for (const raw of [{ text: "x", side: null, owner: null }, { text: "x", side: "both", owner: "  " }, { text: "x" }]) {
      const a = mapActionItem(raw, "id", none)!;
      expect(a.side).toBeUndefined();
      expect(a.owner).toBeUndefined();
    }
  });
});
