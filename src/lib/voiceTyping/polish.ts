import { generateText } from "ai";
import { getModel, getProviderOptions } from "../ai/provider";
import { hasProviderKey } from "../ai/settings";
import { logAiError } from "../ai/errors";
import { log } from "../log";
import type { Settings } from "../types";

/**
 * The cleanup pass that runs after a dictation settles and before the text is
 * pasted: the raw transcript goes to the `realtime` model lane and comes back
 * with the filler words gone, the punctuation fixed and the paragraphs broken
 * where a writer would break them.
 *
 * This is the desktop's answer to iOS's `TranscriptPolisher`, and it is written
 * around the same single rule: **it must never make dictation worse.** On the
 * phone that rule is cheap to honour, because the keyboard owns the insertion
 * point and can hold the text back. Here it is the whole design problem: the
 * paste is a blind ⌘V into somebody else's app, so there is no undo, no
 * re-selection, and no second chance. Every failure mode — no provider
 * configured, no network, a slow model, a refusal, a model that answered the
 * transcript instead of cleaning it — has to resolve to "paste the raw text",
 * and it has to resolve there *quickly*.
 *
 * Hence the shape: `polish` returns `null` rather than throwing anything the
 * caller has to interpret, it is bounded by its own timeout rather than the
 * provider's, and `accept` is deliberately suspicious of what comes back.
 */

/** Below this the round trip costs more — in latency, and in the risk of the
 *  model "helping" — than the tidy-up is worth. A single short phrase has no
 *  filler to remove and no paragraphs to break, and it is exactly the case
 *  where a user notices a pause. */
export const MIN_POLISH_CHARS = 8;

/** How many personal-dictionary terms travel with the request. The dictionary
 *  grows for as long as someone keeps dictating and a prompt that grew with it
 *  would eventually cost more latency than the polish is worth. `vocabularyTerms`
 *  is ordered by recency, so the terms that matter to the sentence just spoken
 *  are at the front anyway. */
export const MAX_PROTECTED_TERMS = 30;

/** The ceiling on the whole round trip. Past this the raw text goes out
 *  unpolished.
 *
 *  This exists because the alternative is worse than an unpolished paste: the
 *  user has stopped talking, is looking at a spinner, and the words they said
 *  have not appeared anywhere yet. A model that is having a bad minute must not
 *  be able to hold their sentence hostage. Four seconds is well past a healthy
 *  realtime-lane response and well short of "did this thing crash". */
export const POLISH_TIMEOUT_MS = 4000;

export const POLISH_SYSTEM_PROMPT =
  "You clean up voice-dictation transcripts. Rewrite the user's transcript " +
  "into polished written text: remove filler words and false starts, fix " +
  "punctuation, add paragraph breaks where natural. Keep the meaning and the " +
  "speaker's own wording as much as possible. Preserve the original language " +
  "and script EXACTLY: Traditional Chinese input must stay Traditional Chinese " +
  "(Taiwan conventions); never convert to Simplified Chinese; never translate. " +
  "Do not answer questions in the transcript, do not add content, do not add " +
  "commentary. Output ONLY the cleaned text.";

/** Long enough to be worth a round trip. */
export function shouldPolish(raw: string): boolean {
  return raw.trim().length >= MIN_POLISH_CHARS;
}

/**
 * The system message for one request: the standing prompt, plus a line naming
 * the user's own vocabulary when there is any. Empty in, unchanged out.
 *
 * Those terms are words the user has already corrected by hand — a cleanup pass
 * that "fixes" a name they spelled out themselves is exactly the kind of help
 * nobody asked for.
 */
export function polishSystemPrompt(protectedTerms: string[]): string {
  const kept = protectedTerms.filter((t) => t.trim()).slice(0, MAX_PROTECTED_TERMS);
  if (!kept.length) return POLISH_SYSTEM_PROMPT;
  return `${POLISH_SYSTEM_PROMPT}\nPreserve these user-dictionary terms exactly as written: ${kept.join("、")}`;
}

/**
 * Whether `polished` is a plausible cleanup of `raw`. The model is not trusted
 * to have followed the prompt: this is the last gate before text the user did
 * not say replaces text they did.
 */
export function acceptPolish(raw: string, polished: string): boolean {
  const trimmedRaw = raw.trim();
  const trimmed = polished.trim();
  if (!trimmed || !trimmedRaw) return false;

  // A cleanup shortens a little and lengthens a little. Anything outside this
  // band is a different kind of output: an answer to a question in the
  // transcript, a summary, a translation, or a truncation.
  const ratio = trimmed.length / trimmedRaw.length;
  if (ratio < 0.3 || ratio > 2.0) return false;

  // Simplified drift is the one failure that looks like success. Only a NEWLY
  // introduced simplified character counts — someone who dictated simplified
  // text in the first place gets their own script back untouched.
  if (!containsSimplifiedChinese(trimmedRaw) && containsSimplifiedChinese(trimmed)) return false;

  return true;
}

/**
 * A heuristic drift detector, not a converter: a membership test against
 * high-frequency characters whose Traditional counterpart is a different
 * character (说/說, 时/時, 开/開…). It answers "did Simplified Chinese appear
 * here", nothing more — it cannot tell you a text is Traditional, and it is not
 * a script classifier. Over-rejecting is the safe direction: a rejected polish
 * just leaves the user with the raw transcript.
 */
export function containsSimplifiedChinese(s: string): boolean {
  for (const ch of s) if (SIMPLIFIED_ONLY.has(ch)) return true;
  return false;
}

/** Simplified-only characters. Characters also written this way in Traditional
 *  Chinese (別, 份, 氣, 目, 內, 那…) are deliberately absent: they would fire on
 *  perfectly good Traditional output. Kept in sync with iOS's
 *  `TranscriptPolisher.simplifiedOnly`. */
const SIMPLIFIED_ONLY = new Set(
  "说时后对开门问间东发经过还进远运动会员实处体验声记忆费术语议论证据坚决卖买风飞马鸟龙单双击战胜负责务际线联网络继续读书写听讲词汇报诉" +
    "应该脑头们几个从来没错误导师长辈坛贴质价钱财产业习惯题标号码现场适当选择优点败义愤骂" +
    "汉简传输车电话张欢乐学觉视观见亲让认识请谢谁边铁银钟页顺须顾预领频颜类显",
);

/** Whether a polish attempt is even possible right now: the user has it on, and
 *  the realtime lane has a usable provider. Checked before the overlay is told
 *  anything, so a user without a key never sees a "polishing" state that cannot
 *  happen. */
export function canPolish(settings: Settings): boolean {
  return settings.voiceTypingPolish && hasProviderKey(settings, "realtime");
}

/**
 * Send `raw` to be cleaned up. Resolves to the polished text, or to `null` for
 * every other outcome — not configured, too short, timed out, transport error,
 * or an answer that failed {@link acceptPolish}. The caller pastes the raw
 * transcript on `null`, so there is exactly one thing to handle.
 */
export async function polishTranscript(opts: {
  raw: string;
  settings: Settings;
  protectedTerms?: string[];
}): Promise<string | null> {
  const { raw, settings, protectedTerms = [] } = opts;
  if (!canPolish(settings) || !shouldPolish(raw)) return null;

  const startedAt = performance.now();
  try {
    const { text } = await generateText({
      model: getModel(settings, "realtime"),
      providerOptions: getProviderOptions(settings, "realtime"),
      system: polishSystemPrompt(protectedTerms),
      prompt: raw,
      temperature: 0.2,
      maxOutputTokens: 2048,
      abortSignal: AbortSignal.timeout(POLISH_TIMEOUT_MS),
    });
    const polished = text.trim();
    const ms = Math.round(performance.now() - startedAt);
    if (!acceptPolish(raw, polished)) {
      // Not an error — the guard doing its job. Logged at info because a run of
      // these means the prompt or the lane's model is wrong, and that is only
      // ever visible here.
      log.info("voice-typing: polish rejected, keeping raw", {
        ms,
        rawChars: raw.trim().length,
        polishedChars: polished.length,
      });
      return null;
    }
    log.info("voice-typing: polished", { ms, rawChars: raw.trim().length, chars: polished.length });
    return polished;
  } catch (error) {
    // Includes the timeout. Everything here means the same thing to the caller,
    // so it is logged for us and swallowed for them.
    logAiError("voice-typing.polish", { rawChars: raw.trim().length }, error);
    return null;
  }
}
