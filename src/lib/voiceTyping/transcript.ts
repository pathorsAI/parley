/** A `transcript://segment` payload as the overlay sees it. */
export interface Segment {
  id: string;
  source: string;
  text: string;
  is_final: boolean;
  /** The backend session that produced it (see `voice_typing.rs`). */
  session?: number;
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
 * segment id, in id order, then the tentative tail. What `render` returns is
 * what the overlay displays and what the host copies to the clipboard.
 */
export class SessionTranscript {
  session = 0;
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

  /** Whether an event belongs to the dictation this transcript is showing. */
  owns(p: { source: string; session?: number }): boolean {
    return p.source === "voice-typing";
  }

  /** Fold a segment in. Returns false when the segment is not ours. */
  accept(seg: Segment): boolean {
    if (!this.owns(seg)) return false;
    if (seg.is_final) {
      this.finals.set(seg.id, seg.text);
      this.interim = ""; // the committed run supersedes the tail
    } else {
      this.interim = seg.text;
    }
    return true;
  }

  /** The display text: every committed run converted, then the tail. */
  async render(normalize: Normalize): Promise<string> {
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
    return (finals + interim).trim();
  }
}
