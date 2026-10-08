import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDrains, SessionOwner, SessionTranscript, type Segment } from "./transcript";

const identity = async (raw: string) => raw;

async function text(t: SessionTranscript, normalize = identity): Promise<string | null> {
  const report = await t.report(normalize);
  return report && report.text;
}

function final(id: string, text: string, session: number): Segment {
  return { id, source: "voice-typing", text, is_final: true, session };
}

function tail(text: string, session: number): Segment {
  return { id: "voice-typing-tail", source: "voice-typing", text, is_final: false, session };
}

describe("SessionTranscript", () => {
  it("drops a previous session's late final after the next session's reset", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "第一句", 1));
    expect(await text(t)).toBe("第一句");

    t.reset(2);
    t.accept(final("voice-typing-1", "第一句的尾巴", 1));
    expect(await text(t)).toBe("");

    t.accept(final("voice-typing-0", "第二句", 2));
    expect(await text(t)).toBe("第二句");
  });

  it("keeps the current session's flush", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(tail("我們明", 1));
    expect(await text(t)).toBe("我們明");
    t.accept(final("voice-typing-0", "我們明天見", 1));
    expect(await text(t)).toBe("我們明天見");
  });

  it("adopts a newer session whose reset it never saw", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "舊的", 1));
    t.accept(final("voice-typing-0", "新的", 2));
    expect(await text(t)).toBe("新的");
  });

  it("withholds a report whose conversion a reset overtook", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "第一句", 1));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = t.report(async (raw) => {
      await gate;
      return raw;
    });
    t.reset(2);
    release();
    expect(await inFlight).toBeNull();
    expect(await t.report(identity)).toEqual({ text: "", session: 2, sttText: "" });
  });

  it("orders committed runs by id and appends the tail, converted", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-1", "second ", 1));
    t.accept(final("voice-typing-0", "first ", 1));
    t.accept(tail("third", 1));
    expect(await text(t, async (raw) => raw.toUpperCase())).toBe("FIRST SECOND THIRD");
  });

  /** The recognizer commits one final per endpoint, each closed with its
   *  own 。 and the next opening with a space; only the join sees that seam. */
  it("softens a pause-made full stop on the seam between two finals", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "我覺得。", 1));
    t.accept(final("voice-typing-1", " 這樣可以。", 1));
    expect(await text(t)).toBe("我覺得，這樣可以。");
  });

  it("softens against the live tail", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "我覺得。", 1));
    t.accept(tail(" 這樣", 1));
    expect(await text(t)).toBe("我覺得，這樣");
  });

  it("a single short final drops its trailing full stop", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "好的。", 1));
    expect(await text(t)).toBe("好的");
  });

  /** Softening can take a dictation one unit under polish's length gate (a
   *  bare phrase's 。, the space after a full-width mark); the gate reads the
   *  text as the recognizer gave it. */
  it("reports the unsoftened text for the polish gate", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "好的。", 1));
    t.accept(final("voice-typing-1", " 我知道。", 1));
    expect(await t.report(identity)).toEqual({
      text: "好的，我知道。",
      session: 1,
      sttText: "好的。 我知道。",
    });
  });

  /** The host's settle rule waits while a tentative run is pending: words the
   *  closing finalize may still revise or commit. */
  it("tracks whether a tentative tail is pending", () => {
    const t = new SessionTranscript();
    t.reset(1);
    expect(t.hasPendingTail()).toBe(false);
    t.accept(tail("我們明", 1));
    expect(t.hasPendingTail()).toBe(true);
    t.accept(final("voice-typing-0", "我們明天", 1));
    expect(t.hasPendingTail()).toBe(false);
    t.accept(tail("見", 1));
    expect(t.hasPendingTail()).toBe(true);
    // Rust's answer to the closing finalize: the last final, then the empty
    // tail that clears the tentative run.
    t.accept(final("voice-typing-0", "我們明天見", 1));
    t.accept(tail("", 1));
    expect(t.hasPendingTail()).toBe(false);
    t.accept(tail("  ", 1));
    expect(t.hasPendingTail()).toBe(false);
  });

  /** The host keeps one instance per session: a re-press must not null the
   *  report the previous dictation's delivery is still converting. */
  it("keeps an older instance's in-flight report when the next session starts", async () => {
    const previous = new SessionTranscript();
    previous.reset(1);
    previous.accept(final("voice-typing-0", "上一句", 1));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = previous.report(async (raw) => {
      await gate;
      return raw;
    });
    const next = new SessionTranscript();
    next.reset(2);
    next.accept(final("voice-typing-0", "下一句", 2));
    release();
    expect(await inFlight).toEqual({ text: "上一句", session: 1, sttText: "上一句" });
    expect(await text(next)).toBe("下一句");
  });

  it("ignores a meeting's segments", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    expect(
      t.accept({ id: "me-0", source: "me", text: "meeting", is_final: true, session: null }),
    ).toBe(false);
    expect(await text(t)).toBe("");
  });
});

describe("SessionOwner", () => {
  /** The report the host pastes from carries the session it describes. A
   *  press disowns everything until Rust names the new session, so a previous
   *  dictation's text landing in that gap is not what the next one pastes. */
  it("disowns a previous dictation's text report from the press onwards", () => {
    const host = new SessionOwner();
    host.start(1);
    expect(host.owns({ session: 1 })).toBe(true);

    host.begin();
    expect(host.owns({ session: 1 })).toBe(false);

    host.start(2);
    expect(host.owns({ session: 1 })).toBe(false);
    expect(host.owns({ session: 2 })).toBe(true);
    expect(host.owns({ session: null })).toBe(false);
  });
});

describe("SessionDrains", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The regression: a toggle tap during settle used to abort the settling
   *  session, so its last words never arrived. */
  it("keeps a restarted dictation's flush until its close", async () => {
    const drains = new SessionDrains(3000);
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-0", "我們明天", 1));
    let settled = false;
    const done = drains.add(1, t).then(() => {
      settled = true;
    });
    // The next session's segments are not this dictation's.
    expect(drains.accept(final("voice-typing-0", "下一句", 2))).toBe(false);
    expect(drains.accept(final("voice-typing-1", "早上九點見", 1))).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(drains.close(1)).toBe(true);
    await done;
    expect(await text(t)).toBe("我們明天早上九點見");
    // Closed: nothing more is routed to it.
    expect(drains.accept(final("voice-typing-2", "遲到的", 1))).toBe(false);
  });

  it("gives up after the cap", async () => {
    vi.useFakeTimers();
    const drains = new SessionDrains(3000);
    const t = new SessionTranscript();
    t.reset(4);
    let settled = false;
    void drains.add(4, t).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(drains.close(4)).toBe(false);
  });
});
