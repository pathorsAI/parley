// Plain-text transcript import (issue #130's text-ingest path).
//
// Parses a pasted/picked .txt transcript into `TranscriptSegment[]` so it can be
// saved as a normal audio-less HistoryEntry (design doc D11: source "upload",
// audio null, synthesized timeline). Three formats are auto-detected, matching
// what real exports look like:
//
//   "speakers"    Speaker labels on their own line (or inline), text below:
//                     Speaker 1:
//                     Okay. Hello, Danny.
//                 Labels become diarized speakers AND seed `speakerNames`.
//
//   "timestamps"  `[HH:MM:SS.mmm]`-stamped lines (one segment per stamp, no
//                 speaker info): [00:00:07.760] 可以被打斷，剛剛我還沒有…
//
//   "plain"       Anything else: paragraphs become single-speaker segments.
//
// Formats without timestamps get a synthesized timeline estimated from text
// length, so the replay transcript, findings anchors and the analysis窗口 all
// stay meaningful. Parsing is pure/sync — file I/O and zh conversion happen in
// the dialog that calls this.

import type { TranscriptSegment } from "../types";

export type TranscriptFormat = "speakers" | "timestamps" | "plain";

export interface ParsedTranscript {
  segments: TranscriptSegment[];
  /** speakerKey ("them-N") → label, for labels worth keeping ("Jojo", "Speaker 2"). */
  speakerNames: Record<string, string>;
  durationMs: number;
  /** A short pre-content line treated as an embedded title (e.g. the recorder's
   *  "Recording-2026-07-16-12-00" first line) — dropped from the segments. */
  embeddedTitle: string | null;
  format: TranscriptFormat;
}

// ── Timing synthesis ────────────────────────────────────────────────────────

/** Rough per-character speaking time. CJK ≈ 3.7 chars/sec, latin ≈ 2.6 words/sec. */
const CJK_MS_PER_CHAR = 270;
const LATIN_MS_PER_WORD = 380;
const MIN_SEGMENT_MS = 1000;

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿]/g;

/** Estimate how long a line takes to say — drives the synthesized timeline. */
export function estimateSpeechMs(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const latinWords = text
    .replace(CJK_RE, " ")
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
  return Math.max(MIN_SEGMENT_MS, cjk * CJK_MS_PER_CHAR + latinWords * LATIN_MS_PER_WORD);
}

// ── Format detection helpers ────────────────────────────────────────────────

/** `[HH:MM:SS.mmm]` / `[MM:SS]` line stamp → ms, or null when not a stamp line. */
function parseStampLine(line: string): { ms: number; text: string } | null {
  const m = /^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\]\s*(.*)$/.exec(line);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const ms =
    ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 +
    (m[4] ? Number(m[4].padEnd(3, "0")) : 0);
  return { ms, text: m[5] ?? "" };
}

/** A speaker label: short, no sentence punctuation — "Speaker 1", "Jojo", "業務". */
const LABEL_TEXT_RE = /^[^\s:：。，,.?？!！""''()（）\d][^:：。，,.?？!！]{0,30}$/;
/** Generic labels that are speakers even when they appear only once. */
const GENERIC_LABEL_RE = /^(speaker|說話者|发言人|講者|讲者)\s*\d*$/i;

/** "Speaker 1:" alone on a line (the strongest signal — never normal prose). */
function ownLineLabel(line: string): string | null {
  const m = /^(.+?)[:：]\s*$/.exec(line);
  if (!m) return null;
  const label = m[1].trim();
  return LABEL_TEXT_RE.test(label) || GENERIC_LABEL_RE.test(label) ? label : null;
}

/** "Jojo: 你好" — label and text on one line. Weaker signal (prose can contain
 *  colons), so callers require the label to repeat or look generic. */
function inlineLabel(line: string): { label: string; text: string } | null {
  const m = /^(.+?)[:：]\s+(.+)$/.exec(line);
  if (!m) return null;
  const label = m[1].trim();
  if (!(LABEL_TEXT_RE.test(label) || GENERIC_LABEL_RE.test(label))) return null;
  return { label, text: m[2].trim() };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

interface Block {
  label: string | null;
  lines: string[];
}

/** Speaker-label format: fold lines into blocks, one segment per block. */
function parseSpeakerBlocks(lines: string[], inlineSpeakers: Set<string>): {
  blocks: Block[];
  preamble: string[];
} {
  const blocks: Block[] = [];
  const preamble: string[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const own = ownLineLabel(line);
    if (own) {
      current = { label: own, lines: [] };
      blocks.push(current);
      continue;
    }
    const inline = inlineLabel(line);
    if (inline && inlineSpeakers.has(inline.label)) {
      current = { label: inline.label, lines: [inline.text] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { blocks, preamble };
}

/** Labels eligible for INLINE matches: generic ones, or names seen ≥ 2 times
 *  (a one-off "結論: …" heading must not become a speaker). */
function collectInlineSpeakers(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    const hit = ownLineLabel(line) ?? inlineLabel(line)?.label ?? null;
    if (hit) counts.set(hit, (counts.get(hit) ?? 0) + 1);
  }
  const speakers = new Set<string>();
  for (const [label, n] of counts) {
    if (n >= 2 || GENERIC_LABEL_RE.test(label)) speakers.add(label);
  }
  return speakers;
}

/** Assemble segments with a synthesized contiguous timeline. */
function synthesizeSegments(
  parts: { label: string | null; text: string }[],
): { segments: TranscriptSegment[]; speakerNames: Record<string, string> } {
  const speakerOf = new Map<string, number>();
  const speakerNames: Record<string, string> = {};
  const segments: TranscriptSegment[] = [];
  let cursor = 0;
  for (const part of parts) {
    const text = part.text.trim();
    if (!text) continue;
    let speaker = 0;
    if (part.label) {
      const existing = speakerOf.get(part.label);
      speaker = existing ?? speakerOf.size;
      if (existing === undefined) {
        speakerOf.set(part.label, speaker);
        speakerNames[`them-${speaker}`] = part.label;
      }
    }
    const startMs = cursor;
    cursor += estimateSpeechMs(text);
    segments.push({
      id: `import-${segments.length}`,
      source: "them",
      speaker,
      text,
      isFinal: true,
      startMs,
      endMs: cursor,
    });
  }
  return { segments, speakerNames };
}

/** Timestamped format: one segment per stamp, real start times. */
function parseTimestamped(lines: string[]): {
  segments: TranscriptSegment[];
  preamble: string[];
} {
  const stamped: { ms: number; lines: string[] }[] = [];
  const preamble: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const stamp = parseStampLine(line);
    if (stamp) stamped.push({ ms: stamp.ms, lines: stamp.text ? [stamp.text] : [] });
    else if (stamped.length) stamped[stamped.length - 1].lines.push(line);
    else preamble.push(line);
  }
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < stamped.length; i++) {
    const text = stamped[i].lines.join("\n").trim();
    if (!text) continue;
    const startMs = stamped[i].ms;
    const next = stamped
      .slice(i + 1)
      .find((s) => s.ms > startMs);
    segments.push({
      id: `import-${segments.length}`,
      source: "them",
      speaker: 0,
      text,
      isFinal: true,
      startMs,
      endMs: next ? next.ms : startMs + estimateSpeechMs(text),
    });
  }
  return { segments, preamble };
}

/** Target size of a plain-format segment (roughly one spoken breath-group run). */
const PLAIN_CHUNK_CHARS = 160;

/** Split a long unbroken run of text at sentence boundaries into ~chunk-sized
 *  pieces (hard-splitting a single monster "sentence" as a last resort). Short
 *  paragraphs pass through untouched. */
function splitLongRun(text: string, maxChars = PLAIN_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  // Keep the terminator with its sentence; newlines also count as boundaries.
  const sentences = text.match(/[^。．！？!?\n]+[。．！？!?\n]*/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };
  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += maxChars * 2) {
      const piece = sentence.slice(i, i + maxChars * 2); // last-resort hard split
      if (buf && buf.length + piece.length > maxChars) flush();
      buf += piece;
    }
  }
  flush();
  return chunks.length ? chunks : [text];
}

/** A preamble short enough to be a title line rather than lost speech. */
function titleFromPreamble(preamble: string[]): string | null {
  if (preamble.length === 0 || preamble.length > 2) return null;
  const joined = preamble.join(" ").trim();
  return joined && joined.length <= 120 ? joined : null;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Parse a transcript's raw text. Returns null when there is no spoken content
 * at all (empty / whitespace-only file).
 */
export function parseTranscript(raw: string): ParsedTranscript | null {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  const inlineSpeakers = collectInlineSpeakers(lines);
  let stampCount = 0;
  let labelCount = 0;
  for (const l of lines) {
    const line = l.trim();
    if (!line) continue;
    if (parseStampLine(line)) {
      stampCount++;
      continue;
    }
    if (ownLineLabel(line)) {
      labelCount++;
      continue;
    }
    const inline = inlineLabel(line);
    if (inline && inlineSpeakers.has(inline.label)) labelCount++;
  }

  if (stampCount >= 2 && stampCount >= labelCount) {
    const { segments, preamble } = parseTimestamped(lines);
    if (segments.length) {
      return {
        segments,
        speakerNames: {},
        durationMs: segments[segments.length - 1].endMs,
        embeddedTitle: titleFromPreamble(preamble),
        format: "timestamps",
      };
    }
  }

  if (labelCount >= 1) {
    const { blocks, preamble } = parseSpeakerBlocks(lines, inlineSpeakers);
    const { segments, speakerNames } = synthesizeSegments(
      blocks.map((b) => ({ label: b.label, text: b.lines.join("\n") })),
    );
    if (segments.length) {
      return {
        segments,
        speakerNames,
        durationMs: segments[segments.length - 1].endMs,
        embeddedTitle: titleFromPreamble(preamble),
        format: "speakers",
      };
    }
  }

  // Plain fallback: paragraphs (blank-line separated) become segments. Long
  // unbroken paragraphs — a whole meeting exported as one run of text is common
  // — are further split at sentence boundaries so the synthesized timeline
  // spreads across the recording (readable replay, anchorable findings).
  const paragraphs: string[] = [];
  let acc: string[] = [];
  for (const l of lines) {
    const line = l.trim();
    if (line) acc.push(line);
    else if (acc.length) {
      paragraphs.push(acc.join("\n"));
      acc = [];
    }
  }
  if (acc.length) paragraphs.push(acc.join("\n"));
  const chunks = paragraphs.flatMap((p) => splitLongRun(p));
  const { segments } = synthesizeSegments(chunks.map((text) => ({ label: null, text })));
  if (!segments.length) return null;
  return {
    segments,
    speakerNames: {},
    durationMs: segments[segments.length - 1].endMs,
    embeddedTitle: null,
    format: "plain",
  };
}

// ── File-name helpers (shared by the dialog) ────────────────────────────────

/** Export-tool suffixes stripped from a transcript file name for the title. */
const TITLE_SUFFIX_RE = /_(full_transcript|transcript_with_timestamps|transcript)$/i;

/** "台哥大 Danny 會前會_full_transcript.txt" → "台哥大 Danny 會前會". */
export function titleFromFileName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(TITLE_SUFFIX_RE, "").trim();
  return cleaned || stem || name;
}

/** A YYYY-MM-DD embedded in the file name → epoch ms (local noon, so the date
 *  survives timezone display), or null. Beats file mtime, which cloud-drive
 *  syncs routinely rewrite. */
export function dateFromFileName(path: string): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(path.split(/[\\/]/).pop() ?? path);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  return Number.isFinite(t) ? t : null;
}
