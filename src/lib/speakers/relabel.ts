// Keep AI-written text in step with the speaker names.
//
// Models see the transcript labelled in English ("Speaker 3", "Remote 2", or a
// name the user had typed by then), so findings, action items and delivery
// reads cite speakers by whatever they were called at generation time. When
// the user renames a speaker afterwards, those artifacts still say the old
// name. Rather than rewriting stored outputs, the text is relabelled at render
// / copy time: every old label of a speaker becomes its current display label.

import { translate } from "../../i18n/messages";
import type { TranscriptSegment } from "../types";
import { knownDefaultLabels, labelContextOf, labelMessage, speakerKey, type LabelContext } from "./labels";

type Line = Pick<TranscriptSegment, "source" | "speaker">;

/** Most recent stale names kept per speaker. */
const MAX_ALIASES = 20;

/**
 * A speaker's stale-name list after renaming it from `prev` to `next`.
 *
 * Names are set on every keystroke, so the raw history is mostly typing
 * residue ("J", "Ja", "Jac" on the way to "Jack"; "Bo", "B" while erasing
 * "Bob"). Kept: names that are not a prefix of the new name (still being
 * typed) or of another kept alias (being erased), and never the new name
 * itself. Pure.
 */
export function nextSpeakerAliases(aliases: readonly string[] | undefined, prev: string | undefined, next: string): string[] {
  const now = next.trim();
  const list = [...(aliases ?? [])];
  const old = prev?.trim() ?? "";
  if (old && old !== now && !list.includes(old)) list.push(old);
  const kept = list.filter(
    (a) => a && a !== now && !now.startsWith(a) && !list.some((b) => b !== a && b.startsWith(a)),
  );
  return kept.slice(-MAX_ALIASES);
}

const ASCII_WORD = /[A-Za-z0-9_]/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for `token`: whole-word on any end that is an ASCII word char
 *  ("Speaker 2" never matches inside "Speaker 21"), plain substring on a CJK
 *  end (Chinese has no word boundaries). */
function tokenPattern(token: string): string {
  const head = ASCII_WORD.test(token[0]) ? "(?<![A-Za-z0-9_])" : "";
  const tail = ASCII_WORD.test(token[token.length - 1]) ? "(?![A-Za-z0-9_])" : "";
  return `${head}${escapeRegExp(token)}${tail}`;
}

/** The numbered default labels a speaker may be cited by: every English form
 *  the model may have seen (see knownDefaultLabels), plus each language's
 *  on-screen form (a model writing Chinese sometimes translates "Remote 3"
 *  itself). Never a bare 我 / Me / You / 對方 / Them — far too common as
 *  ordinary words. */
function numberedDefaults(line: Line, ctx: LabelContext): string[] {
  const out = knownDefaultLabels(line, ctx).filter((l) => /\d$/.test(l));
  for (const c of [ctx, {}]) {
    const m = labelMessage(line, c);
    if (!m.params) continue;
    out.push(translate("zh-TW", m.key, m.params), translate("en", m.key, m.params));
  }
  // Pre-side naming of a second mic voice (說話者 N).
  if (line.source === "me" && line.speaker > 1) {
    out.push(translate("zh-TW", "speaker.speaker", { number: line.speaker }));
  }
  return [...new Set(out)];
}

/**
 * Replace each speaker's old labels in `text` with its current display label
 * (`label(seg)`): its numbered default ("Speaker 3", "Remote 2", 說話者 3) and
 * every stale name in `aliases[key]`. Pure.
 *
 * - A string that is some speaker's CURRENT label is never rewritten, and a
 *   string two speakers could mean is left alone.
 * - Longest match wins, so a current name that contains an old one ("Jack
 *   Chen" vs "Jack") is kept whole.
 * - Markdown link targets (`[6:52](#t=412)`) are left untouched.
 */
export function relabelSpeakers(
  text: string,
  segments: readonly Line[],
  names: Record<string, string>,
  aliases: Record<string, readonly string[]>,
  label: (seg: Line) => string,
): string {
  return speakerRelabeler(segments, names, aliases, label)(text);
}

/** {@link relabelSpeakers} with the speaker scan and pattern built once, for
 *  relabelling many texts against the same names. */
export function speakerRelabeler(
  segments: readonly Line[],
  names: Record<string, string>,
  aliases: Record<string, readonly string[]>,
  label: (seg: Line) => string,
): (text: string) => string {
  const identity = (text: string) => text;
  const speakers = new Map<string, Line>();
  for (const s of segments) {
    const key = speakerKey(s);
    if (!speakers.has(key)) speakers.set(key, s);
  }
  if (speakers.size === 0) return identity;
  const ctx = labelContextOf(segments);

  // Current labels are protected: they map to themselves.
  const current = new Map<string, string>();
  const protectedTokens = new Set<string>();
  for (const [key, line] of speakers) {
    const now = label(line);
    current.set(key, now);
    if (now) protectedTokens.add(now);
    const custom = names[key];
    if (custom) protectedTokens.add(custom);
  }

  // Old token → the speaker key it belongs to; null once two speakers claim it.
  const owner = new Map<string, string | null>();
  const claim = (token: string, key: string) => {
    const t = token.trim();
    if (!t || protectedTokens.has(t)) return;
    const prior = owner.get(t);
    owner.set(t, prior === undefined || prior === key ? key : null);
  };
  for (const [key, line] of speakers) {
    for (const d of numberedDefaults(line, ctx)) claim(d, key);
    for (const a of aliases[key] ?? []) claim(a, key);
  }

  const replacement = new Map<string, string>();
  for (const [token, key] of owner) {
    if (key == null) continue;
    const now = current.get(key);
    if (now && now !== token) replacement.set(token, now);
  }
  if (replacement.size === 0) return identity;
  for (const token of protectedTokens) replacement.set(token, token);

  const tokens = [...replacement.keys()].sort((a, b) => b.length - a.length);
  // A link target first, so its contents are consumed (and kept) whole.
  const pattern = new RegExp(`(\\]\\([^)]*\\))|${tokens.map(tokenPattern).join("|")}`, "g");
  return (text) =>
    text
      ? text.replace(pattern, (match: string, link: string | undefined) =>
          link ? match : (replacement.get(match) ?? match),
        )
      : text;
}
