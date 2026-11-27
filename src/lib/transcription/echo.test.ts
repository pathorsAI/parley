import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { echoCoverage, echoIdsFor, echoTokens, isEcho, withoutEchoes } from "./echo";

const seg = (p: Partial<TranscriptSegment> & Pick<TranscriptSegment, "id" | "source" | "text">): TranscriptSegment => ({
  speaker: p.source === "me" ? 0 : 1,
  isFinal: true,
  startMs: 0,
  endMs: 3000,
  ...p,
});

// Excerpts of a real separate-tracks call recorded on a laptop without
// headphones (2026-11-25). The "them" lines are the loopback; the "me" lines
// are what the mic transcribed at the same moment. Times are the recording's.
const CALL: TranscriptSegment[] = [
  seg({ id: "t1", source: "them", text: " Just my PC does not have mic.", startMs: 46320, endMs: 48120 }),
  seg({ id: "t2", source: "them", text: " So I'm opening from both, my mobile has mic.", startMs: 48840, endMs: 52560 }),
  seg({ id: "m1", source: "me", text: " Here's my PC. It does not have a mic.", startMs: 46560, endMs: 48360 }),

  seg({ id: "t3", source: "them", text: " Hmm.", startMs: 298740, endMs: 298920 }),
  seg({ id: "m2", source: "me", text: " Hmm.", startMs: 298980, endMs: 299160 }),
  // The user's own "Hmm" while the other side was mid-sentence.
  seg({
    id: "t4",
    source: "them",
    text: " When I think this will help me is I mean, I can use it for both of my businesses.",
    startMs: 347580,
    endMs: 358320,
  }),
  seg({ id: "m3", source: "me", text: " Hmm.", startMs: 354300, endMs: 354480 }),

  // The user picks up the other side's words and answers with their own.
  seg({
    id: "t5",
    source: "them",
    text:
      " If it's answered by a gatekeeper like the operator or the reception, the secretary, it knows what" +
      " question to ask, right? That means we can train them? Yeah, we can train the voice agent?",
    startMs: 1150080,
    endMs: 1187040,
  }),
  seg({
    id: "m4",
    source: "me",
    text: " Yeah, yeah. We can train the voice agent to speak to the gatekeeper.",
    startMs: 1185720,
    endMs: 1190400,
  }),

  seg({
    id: "t6",
    source: "them",
    text: " So can we give a specific specific. Okay. It's calling. Is it calling now?",
    startMs: 2154300,
    endMs: 2160120,
  }),
  seg({ id: "m5", source: "me", text: " So can— can we give a specific— specific?", startMs: 2155140, endMs: 2158680 }),
  seg({ id: "t7", source: "them", text: " So can I answer? All right.", startMs: 2162820, endMs: 2163840 }),
  seg({ id: "m6", source: "me", text: " So can I answer or what?", startMs: 2163180, endMs: 2164200 }),

  seg({
    id: "t8",
    source: "them",
    text: " Software, you know. Not this one. It's an AI chatbot.",
    startMs: 2480700,
    endMs: 2484360,
  }),
  seg({ id: "m7", source: "me", text: " Not this one. It's— it's a AI chatbot.", startMs: 2481300, endMs: 2483760 }),

  seg({ id: "t9", source: "them", text: " Thank you.", startMs: 4092660, endMs: 4092960 }),
  seg({ id: "t10", source: "them", text: " Bye.", startMs: 4094220, endMs: 4094400 }),
  // A goodbye a beat before theirs: the user's own.
  seg({ id: "m8", source: "me", text: " Bye.", startMs: 4093620, endMs: 4093680 }),
];

const byId = (id: string) => CALL.find((s) => s.id === id)!;

describe("echo between the mic and system tracks, on a real call", () => {
  it("drops the mic's differently-worded copy of the other side", () => {
    expect(isEcho(byId("m1"), CALL)).toBe(true);
    expect(isEcho(byId("m5"), CALL)).toBe(true);
    expect(isEcho(byId("m6"), CALL)).toBe(true);
    expect(isEcho(byId("m7"), CALL)).toBe(true);
  });

  it("drops a short reply only when the other side said the same at the same moment", () => {
    expect(isEcho(byId("m2"), CALL)).toBe(true);
    expect(isEcho(byId("m3"), CALL)).toBe(false);
    expect(isEcho(byId("m8"), CALL)).toBe(false);
  });

  it("keeps the user's answer that reuses the other side's words", () => {
    expect(isEcho(byId("m4"), CALL)).toBe(false);
  });

  it("cleans a saved transcript, keeping every line of the other side", () => {
    const kept = withoutEchoes(CALL).map((s) => s.id);
    expect(kept).not.toEqual(expect.arrayContaining(["m1", "m2", "m5", "m6", "m7"]));
    expect(kept).toEqual(expect.arrayContaining(["m3", "m4", "m8"]));
    expect(kept.filter((id) => id.startsWith("t"))).toHaveLength(10);
  });

  it("finds nothing once the other side is shifted out of time", () => {
    const shifted = CALL.map((s) =>
      s.source === "them" ? { ...s, startMs: s.startMs + 60_000, endMs: s.endMs + 60_000 } : s,
    );
    expect(withoutEchoes(shifted)).toBe(shifted);
  });
});

describe("echo between the mic and system tracks", () => {
  it("treats near-identical overlapping speech as the mic picking up the speakers", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試。" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", startMs: 200, endMs: 3300 });
    expect(isEcho(me, [them])).toBe(true);
  });

  it("catches a partial echo the mic only heard part of", () => {
    const them = seg({ id: "them-1", source: "them", text: "那報價的部分我們內部再討論一下好了" });
    const me = seg({ id: "me-1", source: "me", text: "內部再討論一下", startMs: 1500 });
    expect(isEcho(me, [them])).toBe(true);
  });

  it("drops a short backchannel only when the other side said it at the same moment", () => {
    const them = seg({ id: "them-1", source: "them", text: "對", startMs: 1000, endMs: 1300 });
    expect(isEcho(seg({ id: "me-1", source: "me", text: "對", startMs: 1100, endMs: 1400 }), [them])).toBe(true);
    expect(isEcho(seg({ id: "me-2", source: "me", text: "對", startMs: 1900, endMs: 2200 }), [them])).toBe(false);
    expect(isEcho(seg({ id: "me-3", source: "me", text: "好", startMs: 1100, endMs: 1400 }), [them])).toBe(false);
  });

  it("keeps the user's own different sentence said at the same time", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "等一下，我先確認一下預算" });
    expect(isEcho(me, [them])).toBe(false);
  });

  it("keeps the user repeating the other side right after they finished", () => {
    const them = seg({ id: "them-1", source: "them", text: "所以總共是一百個坐席嗎", endMs: 2500 });
    const me = seg({ id: "me-1", source: "me", text: "對，一百個坐席", startMs: 3000, endMs: 4200 });
    expect(isEcho(me, [them])).toBe(false);
  });

  it("does not match the same words far apart in time", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", startMs: 60_000, endMs: 63_000 });
    expect(isEcho(me, [them])).toBe(false);
  });

  it("ignores interim segments", () => {
    const them = seg({ id: "them-1", source: "them", text: "我們下週三可以先做一次測試" });
    const me = seg({ id: "me-1", source: "me", text: "我們下週三可以先做一次測試", isFinal: false });
    expect(isEcho(me, [them])).toBe(false);
    expect(echoIdsFor([them], me)).toEqual([]);
  });

  it("finds echoes whichever track finalizes first", () => {
    const them = seg({ id: "them-1", source: "them", text: "Let's ship the pilot next Monday" });
    const me = seg({ id: "me-1", source: "me", text: "let's ship the pilot next monday" });
    expect(echoIdsFor([them], me)).toEqual(["me-1"]);
    expect(echoIdsFor([me], them)).toEqual(["me-1"]);
  });

  it("settles a mic line that spans two of the other side's lines", () => {
    const a = seg({ id: "them-1", source: "them", text: "Okay, what's the highest.", startMs: 0, endMs: 1500 });
    const b = seg({ id: "them-2", source: "them", text: "Rates for the lowest volume of calls?", startMs: 1600, endMs: 4000 });
    const me = seg({
      id: "me-1",
      source: "me",
      text: "Okay. What's the highest rates for the lowest volume of calls?",
      startMs: 100,
      endMs: 3900,
    });
    expect(echoIdsFor([a, me], b)).toEqual(["me-1"]);
  });

  it("leaves a transcript with only one side untouched", () => {
    const only = [seg({ id: "me-1", source: "me", text: "hello there everyone" })];
    expect(withoutEchoes(only)).toBe(only);
  });
});

describe("echo tokens and coverage", () => {
  it("splits words, and characters of scripts written without spaces", () => {
    expect(echoTokens("Here's my PC — 報價 OK?")).toEqual(["heres", "my", "pc", "報", "價", "ok"]);
  });

  it("only credits words found in order within a stretch about as long as the line", () => {
    const line = echoTokens("we can do that");
    expect(echoCoverage(line, echoTokens("so we can do that tomorrow"))).toBe(1);
    const scattered = echoTokens("we went home early and slept, then later that week they said nobody can really know what to do about all of that");
    expect(echoCoverage(line, scattered)).toBeLessThan(0.65);
  });
});
