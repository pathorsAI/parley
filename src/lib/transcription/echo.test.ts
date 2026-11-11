import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { echoIdsFor, isEchoOf, textSimilarity } from "./echo";

const seg = (p: Partial<TranscriptSegment> & Pick<TranscriptSegment, "id" | "source" | "text">): TranscriptSegment => ({
  speaker: 1,
  isFinal: true,
  startMs: 0,
  endMs: 3000,
  ...p,
});

describe("echo between the mic and system tracks", () => {
  it("treats near-identical overlapping speech as the mic picking up the speakers", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試。" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", startMs: 200, endMs: 3300 });
    expect(isEchoOf(me, them)).toBe(true);
  });

  it("catches a partial echo the mic only heard part of", () => {
    const them = seg({ id: "them-1", source: "them", text: "那報價的部分我們內部再討論一下好了" });
    const me = seg({ id: "me-1", source: "me", text: "內部再討論一下", startMs: 1500 });
    expect(isEchoOf(me, them)).toBe(true);
  });

  it("keeps a short backchannel the user said over the other side", () => {
    const them = seg({ id: "them-1", source: "them", text: "對" });
    const me = seg({ id: "me-1", source: "me", text: "對" });
    expect(isEchoOf(me, them)).toBe(false);
  });

  it("keeps the user's own different sentence said at the same time", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "等一下，我先確認一下預算" });
    expect(isEchoOf(me, them)).toBe(false);
  });

  it("does not match the same words far apart in time", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", startMs: 60_000, endMs: 63_000 });
    expect(isEchoOf(me, them)).toBe(false);
  });

  it("ignores interim segments", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", isFinal: false });
    expect(isEchoOf(me, them)).toBe(false);
  });

  it("finds echoes whichever track finalizes first", () => {
    const them = seg({ id: "them-1", source: "them", text: "Let's ship the pilot next Monday" });
    const me = seg({ id: "me-1", source: "me", text: "let's ship the pilot next monday" });
    expect(echoIdsFor([them], me)).toEqual(["me-1"]);
    expect(echoIdsFor([me], them)).toEqual(["me-1"]);
  });

  it("scores similarity on characters, not punctuation or case", () => {
    expect(textSimilarity("Hello, world!", "hello world")).toBe(1);
    expect(textSimilarity("", "x")).toBe(0);
  });
});
