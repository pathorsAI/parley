import { softenPausePeriods } from "./punctuation";

/** A `transcript://segment` payload as the host and the overlay see it. */
export interface Segment {
  id: string;
  source: string;
  text: string;
  is_final: boolean;
  /** The backend session that produced it; null for a meeting's segments. */
  session: number | null;
}

/** `voicetyping://session`. `start` comes from Rust once the previous session's
 *  task is gone and names the new session; the other phases come from the host.
 *  `done` carries the verdict (a `DoneMessage`, see overlay.ts) and the text
 *  that was delivered, so the overlay ends on exactly what was pasted — the
 *  polished text included — rather than on its own copy of the transcript.
 *  `cancelled` is an Esc: the overlay offers Undo (see cancel.ts). */
export type SessionEvent =
  | { phase: "start"; session: number }
  | { phase: "done"; message?: string; text?: string }
  | { phase: "stop" | "polishing" | "error" | "limit" | "cancelled"; message?: string };

/** One dictation's text as `report()` renders it: what the overlay shows while
 *  it runs and what the host delivers once it settles — the two windows fold
 *  the same segments through the same pipeline. */
export interface TranscriptText {
  text: string;
  session: number;
  /** The same text before softenPausePeriods. Only for polish's length gate
   *  (`shouldPolish`): softening drops a bare phrase's trailing 。 and the
   *  space after a full-width mark, which can take an 8-unit dictation under
   *  MIN_POLISH_CHARS, and polish must run on what was said, not on what the
   *  floor under it tidied away. Never shown, pasted or saved. */
  sttText: string;
}

/** Converts one raw run for display (Simplified → Traditional, dictionary). */
export type Normalize = (raw: string) => Promise<string>;

/** Numeric index from a "voice-typing-{n}" segment id (tail sorts last). */
function idIndex(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * The transcript of one dictation: committed runs keyed by segment id, in id
 * order, then the tentative tail. The overlay keeps one to display; the host
 * keeps one per session to deliver, so a new session's instance can never
 * clear the text an older delivery is still reading.
 */
export class SessionTranscript {
  private session: number | null = null;
  private readonly finals = new Map<string, string>();
  private interim = "";
  // Final segments are converted once and cached; only the live tail is
  // converted every token, so cost stays flat no matter how long the dictation.
  private readonly converted = new Map<string, { raw: string; conv: string }>();

  /** Start over for `session`. */
  reset(session: number): void {
    this.session = session;
    this.finals.clear();
    this.converted.clear();
    this.interim = "";
  }

  /** Whether an event belongs to this dictation or a newer one whose reset
   *  this window never saw; anything older is a previous dictation's late
   *  output. */
  owns<T extends { source: string; session: number | null }>(p: T): p is T & { session: number } {
    if (p.source !== "voice-typing" || p.session === null) return false;
    return this.session === null || p.session >= this.session;
  }

  /** Whether the text still ends in a tentative run: words the recognizer may
   *  yet revise, or finalize. An endpoint or `<fin>` response commits it and
   *  sends an empty tail. */
  hasPendingTail(): boolean {
    return this.interim.trim() !== "";
  }

  /** Fold a segment in. Returns false when the segment is not ours. */
  accept(seg: Segment): boolean {
    if (!this.owns(seg)) return false;
    if (this.session === null || seg.session > this.session) this.reset(seg.session);
    if (seg.is_final) {
      this.finals.set(seg.id, seg.text);
      this.interim = ""; // the committed run supersedes the tail
    } else {
      this.interim = seg.text;
    }
    return true;
  }

  /** The display text, every committed run converted, then the tail, with
   *  pause-made full stops softened. Null when a reset landed while the
   *  conversion was in flight: the text is a previous dictation's and must not
   *  be shown or reported for this one. */
  async report(normalize: Normalize): Promise<TranscriptText | null> {
    const session = this.session;
    if (session === null) return null;
    const entries = [...this.finals.entries()].sort((a, b) => idIndex(a[0]) - idIndex(b[0]));
    let finals = "";
    for (const [id, raw] of entries) {
      const cached = this.converted.get(id);
      let conv: string;
      if (cached?.raw === raw) {
        conv = cached.conv;
      } else {
        conv = await normalize(raw);
        this.converted.set(id, { raw, conv });
      }
      finals += conv;
    }
    const interim = this.interim ? await normalize(this.interim) : "";
    if (this.session !== session) return null;
    // Most pause-made 。 sit on the seam between two finals (Soniox commits one
    // per endpoint, each closed with its own 。, the next often opening with a
    // space), and only this join can see a seam. It must not move into
    // normalizeTranscriptText: that runs per segment, and it is shared with
    // meetings and replay, which keep the STT's punctuation as it came. The
    // host and the overlay both report through here, so what the overlay shows
    // and what the host copies, polishes, pastes and saves stay the same text.
    const joined = (finals + interim).trim();
    return { text: softenPausePeriods(joined), session, sttText: joined };
  }
}

/**
 * The host's side of the same token: which backend session its events belong
 * to. Between a press and Rust's `start` event nothing is owned, so a previous
 * session's late error, close, or segment cannot be taken for the new one's.
 */
export class SessionOwner {
  private current: number | null = null;

  /** A press: nothing is ours until Rust names the new session. */
  begin(): void {
    this.current = null;
  }

  start(session: number): void {
    this.current = session;
  }

  owns(p: { session: number | null }): boolean {
    return p.session !== null && p.session === this.current;
  }
}
