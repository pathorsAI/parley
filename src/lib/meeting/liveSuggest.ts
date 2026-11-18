// Live suggestions (即時建議): while a meeting records, Parley Cloud proposes
// the user's next line after the other side finishes a sentence, or a few
// directions when the talk runs dry. The cloud picks — from the draft's
// playbook and a few generated lines — or stays silent; this side decides WHEN
// to ask, drops answers the conversation has already moved past, and puts away
// what has had its moment. Everything here is pure; liveSuggestRun.ts is the
// store adapter. Design: pensieve.pathors.com/o/jack-db85/d/parley/live-suggestions

import type { TranscriptSegment } from "../types";
import { containment, SAID_IT_THRESHOLD } from "./suggestMatch";

export type SuggestMode = "turn" | "lull";
export type SuggestKind = "question" | "branch" | "topic" | "generated";

/** One suggestion as the cloud returns it. */
export interface Suggestion {
  /** Stable per candidate: `q:<id>`, `b:<id>`, `t:<id>`, `g:<hash>`. */
  key: string;
  kind: SuggestKind;
  /** The line to say (or, in a lull, the direction to take). */
  text: string;
  /** What triggered it: a branch's "when they say…", else null. */
  source: string | null;
  confidence: number;
}

/** What is on screen: one line after a turn, up to three directions in a lull. */
export interface ShownCard {
  mode: SuggestMode;
  items: Suggestion[];
  /** Meeting clock (ms since start, the transcript's axis) when it appeared. */
  atMs: number;
  /** How many final lines the transcript had then — what "the conversation
   *  moved on" is counted from. */
  finalsAtShow: number;
}

/** A suggestion that was shown, kept with the recording for the after-meeting
 *  adoption rate (meeting/suggestAdoption.ts). */
export interface ShownSuggestion extends Suggestion {
  mode: SuggestMode;
  atMs: number;
}

/** One final transcript line, as the cloud sees it. */
export interface Turn {
  who: "me" | "them";
  text: string;
  endMs: number;
}

// ── Timing ────────────────────────────────────────────────────────────────────

/** Wait this long after the other side's last word before asking: a pause
 *  inside a sentence is not the end of a turn. */
export const TURN_SETTLE_MS = 1_200;
/** Nobody has finished a line for this long → a lull. */
export const LULL_MS = 8_000;
/** At most one request this often, whatever happens. */
export const MIN_REQUEST_GAP_MS = 8_000;
/** A card leaves after this long on screen… */
export const CARD_TTL_MS = 45_000;
/** …or once the transcript has this many new final lines since it appeared. */
export const CARD_MAX_NEW_FINALS = 2;
/** How many final lines go to the cloud. */
export const TAIL_TURNS = 16;
/** How many earlier suggestions go along for the cloud's cooldown. */
export const SHOWN_SENT = 30;

/** Who said a segment, for the coach. A mixed stream (one microphone in a
 *  room) cannot tell, so it counts as the other side: a turn still ends. */
export function whoSaid(s: Pick<TranscriptSegment, "source">): "me" | "them" {
  return s.source === "me" ? "me" : "them";
}

/** The final, non-empty lines, oldest first. */
export function finalTurns(segments: readonly TranscriptSegment[]): Turn[] {
  return segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => ({ who: whoSaid(s), text: s.text.trim(), endMs: s.endMs }))
    .sort((a, b) => a.endMs - b.endMs);
}

/** Someone is mid-sentence: a segment still being transcribed. */
export function speechPending(segments: readonly TranscriptSegment[]): boolean {
  return segments.some((s) => !s.isFinal && s.text.trim().length > 0);
}

/** What the trigger needs to know, as plain values. */
export interface TriggerFacts {
  nowMs: number;
  turns: readonly Turn[];
  pending: boolean;
  inFlight: boolean;
  lastRequestAtMs: number | null;
  /** End of the other side's line the last turn request was for. */
  lastTurnEndMs: number;
  /** End of the last line before the lull already asked about. */
  lastLullEndMs: number;
}

/**
 * Ask now, and how? A `turn` once per finished line from the other side,
 * after it has settled; a `lull` once per silence. Never while a request is
 * out, while someone is mid-sentence, or sooner than MIN_REQUEST_GAP_MS after
 * the last one. Pure.
 */
export function nextTrigger(f: TriggerFacts): SuggestMode | null {
  if (f.inFlight || f.pending) return null;
  if (f.lastRequestAtMs != null && f.nowMs - f.lastRequestAtMs < MIN_REQUEST_GAP_MS) return null;
  const last = f.turns[f.turns.length - 1];
  if (!last) return null;
  const quiet = f.nowMs - last.endMs;
  if (last.who === "them" && last.endMs > f.lastTurnEndMs && quiet >= TURN_SETTLE_MS && quiet < LULL_MS) {
    return "turn";
  }
  // A lull needs a conversation to have lulled: two lines at least.
  if (quiet >= LULL_MS && f.turns.length >= 2 && last.endMs > f.lastLullEndMs) return "lull";
  return null;
}

/**
 * An answer came back: is it still about now? Not if the other side has
 * finished another line since the request went out — a suggestion for the
 * previous sentence is worse than none. In a lull, any new line ends the lull.
 */
export function stillCurrent(mode: SuggestMode, sentTurns: readonly Turn[], nowTurns: readonly Turn[]): boolean {
  const newer = nowTurns.slice(sentTurns.length);
  return mode === "lull" ? newer.length === 0 : !newer.some((t) => t.who === "them");
}

/**
 * Should the card on screen go away? After CARD_TTL_MS, after the
 * conversation has moved CARD_MAX_NEW_FINALS lines on, or — for a single line
 * — once the user has said it. Pure.
 */
export function cardExpired(card: ShownCard, nowMs: number, turns: readonly Turn[]): boolean {
  if (nowMs - card.atMs >= CARD_TTL_MS) return true;
  const since = turns.slice(card.finalsAtShow);
  if (since.length >= CARD_MAX_NEW_FINALS) return true;
  if (card.mode === "lull") return since.length > 0;
  const line = card.items[0]?.text ?? "";
  return since.some((t) => t.who === "me" && containment(line, t.text) >= SAID_IT_THRESHOLD);
}

// ── Request ───────────────────────────────────────────────────────────────────

export interface SuggestRequest {
  mode: SuggestMode;
  language: "zh-TW" | "en";
  context: string;
  agenda: string[];
  playbook: import("./playbook").MeetingPlaybook;
  transcript: Turn[];
  shown: { key: string; text: string; atMs: number }[];
  nowMs: number;
}

/** The request body for POST /v1/live/suggest. Pure. */
export function buildRequest(input: {
  mode: SuggestMode;
  language: "zh-TW" | "en";
  context: string;
  agenda: readonly { text: string; done: boolean }[];
  playbook: import("./playbook").MeetingPlaybook;
  turns: readonly Turn[];
  shown: readonly ShownSuggestion[];
  nowMs: number;
}): SuggestRequest {
  return {
    mode: input.mode,
    language: input.language,
    context: input.context.slice(0, 6_000),
    agenda: input.agenda
      .filter((t) => !t.done && t.text.trim())
      .map((t) => t.text.trim())
      .slice(0, 20),
    playbook: input.playbook,
    transcript: input.turns.slice(-TAIL_TURNS).map((t) => ({ ...t, text: t.text.slice(0, 600) })),
    shown: input.shown.slice(-SHOWN_SENT).map((s) => ({ key: s.key, text: s.text, atMs: s.atMs })),
    nowMs: Math.round(input.nowMs),
  };
}

const KINDS = new Set<SuggestKind>(["question", "branch", "topic", "generated"]);

/** The cloud's answer, checked: whatever is malformed is dropped. A turn
 *  shows one line, a lull at most three. Pure. */
export function parseSuggestions(mode: SuggestMode, body: unknown): Suggestion[] {
  const raw = (body as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    if (typeof s.key !== "string" || typeof s.text !== "string" || !s.text.trim()) continue;
    if (!KINDS.has(s.kind as SuggestKind)) continue;
    out.push({
      key: s.key,
      kind: s.kind as SuggestKind,
      text: s.text.trim(),
      source: typeof s.source === "string" && s.source.trim() ? s.source.trim() : null,
      confidence: typeof s.confidence === "number" ? s.confidence : 0,
    });
  }
  return out.slice(0, mode === "turn" ? 1 : 3);
}
