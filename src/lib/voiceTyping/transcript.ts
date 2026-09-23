/** A `transcript://segment` payload as the overlay sees it. */
export interface Segment {
  id: string;
  source: string;
  text: string;
  is_final: boolean;
  /** The backend session that produced it; null for a meeting's segments. */
  session: number | null;
}

/** `voicetyping://session`. `start` comes from Rust once the previous session's
 *  task is gone and names the new session; the other phases come from the host. */
export type SessionEvent =
  | { phase: "start"; session: number }
  | { phase: "stop" | "polishing" | "done" | "error" | "limit"; message?: string };

/** `voicetyping://text`: what the overlay shows for `session`, which is what the
 *  host copies and pastes. */
export interface TextReport {
  text: string;
  session: number;
}

/** Converts one raw run for display (Simplified → Traditional, dictionary). */
export type Normalize = (raw: string) => Promise<string>;

/** Numeric index from a "voice-typing-{n}" segment id (tail sorts last). */
function idIndex(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * The transcript the overlay shows for one dictation: committed runs keyed by
 * segment id, in id order, then the tentative tail.
 */
export class SessionTranscript {
  private session: number | null = null;
  private finals = new Map<string, string>();
  private interim = "";
  // Final segments are converted once and cached; only the live tail is
  // converted every token, so cost stays flat no matter how long the dictation.
  private converted = new Map<string, { raw: string; conv: string }>();

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

  /** The display text, every committed run converted, then the tail. Null when
   *  a reset landed while the conversion was in flight: the text is a previous
   *  dictation's and must not be shown or reported for this one. */
  async report(normalize: Normalize): Promise<TextReport | null> {
    const session = this.session;
    if (session === null) return null;
    const entries = [...this.finals.entries()].sort((a, b) => idIndex(a[0]) - idIndex(b[0]));
    let finals = "";
    for (const [id, raw] of entries) {
      const cached = this.converted.get(id);
      let conv: string;
      if (cached && cached.raw === raw) {
        conv = cached.conv;
      } else {
        conv = await normalize(raw);
        this.converted.set(id, { raw, conv });
      }
      finals += conv;
    }
    const interim = this.interim ? await normalize(this.interim) : "";
    if (this.session !== session) return null;
    return { text: (finals + interim).trim(), session };
  }
}

/**
 * The host's side of the same token: which backend session its events belong
 * to. Between a press and Rust's `start` event nothing is owned, so a previous
 * session's late error, close, or text report cannot be taken for the new one's.
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
