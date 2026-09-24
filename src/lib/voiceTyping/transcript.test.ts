import { describe, expect, it } from "vitest";
import { SessionOwner, SessionTranscript, type Segment } from "./transcript";

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
    expect(await t.report(identity)).toEqual({ text: "", session: 2 });
  });

  it("orders committed runs by id and appends the tail, converted", async () => {
    const t = new SessionTranscript();
    t.reset(1);
    t.accept(final("voice-typing-1", "second ", 1));
    t.accept(final("voice-typing-0", "first ", 1));
    t.accept(tail("third", 1));
    expect(await text(t, async (raw) => raw.toUpperCase())).toBe("FIRST SECOND THIRD");
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
