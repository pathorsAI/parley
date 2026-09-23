import { describe, expect, it } from "vitest";
import { SessionTranscript, type Segment } from "./transcript";

const identity = async (raw: string) => raw;

function final(id: string, text: string, session: number): Segment {
  return { id, source: "voice-typing", text, is_final: true, session };
}

function tail(text: string, session: number): Segment {
  return { id: "voice-typing-tail", source: "voice-typing", text, is_final: false, session };
}

describe("SessionTranscript", () => {
  /** The report: stop, restart within a second, and the previous dictation's
   *  flushed final lands after the reset. It must not show, and it must not
   *  be what the host pastes. */
  it("drops a previous session's late final after the next session's reset", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "第一句", 1));
    expect(await t.render(identity)).toBe("第一句");

    t.reset(2);
    t.accept(final("voice-typing-1", "第一句的尾巴", 1));
    expect(await t.render(identity)).toBe("");

    t.accept(final("voice-typing-0", "第二句", 2));
    expect(await t.render(identity)).toBe("第二句");
  });

  /** A stop does not reset: the relay's flush keeps landing in the same
   *  session and the tail becomes the pasted text. */
  it("keeps the current session's flush", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(tail("我們明", 1));
    expect(await t.render(identity)).toBe("我們明");
    t.accept(final("voice-typing-0", "我們明天見", 1));
    expect(await t.render(identity)).toBe("我們明天見");
  });

  /** The overlay can come up after the start event went out (the first
   *  dictation right after launch); a segment from a session it has not seen
   *  is the new dictation, not a stale one. */
  it("adopts a newer session whose reset it never saw", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "舊的", 1));
    t.accept(final("voice-typing-0", "新的", 2));
    expect(await t.render(identity)).toBe("新的");
  });

  it("orders committed runs by id and appends the tail, converted", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-1", "second ", 1));
    t.accept(final("voice-typing-0", "first ", 1));
    t.accept(tail("third", 1));
    expect(await t.render(async (raw) => raw.toUpperCase())).toBe("FIRST SECOND THIRD");
  });

  it("ignores a meeting's segments", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    expect(t.accept({ id: "me-0", source: "me", text: "meeting", is_final: true })).toBe(false);
    expect(await t.render(identity)).toBe("");
  });
});
