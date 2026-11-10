import type { TranslationKey } from "../../i18n";

/** Map a speaking rate (syllables/sec ≈ value × 60 字/分) to a band label +
 *  whether it warrants a watch (warning) accent. Reference points for Mandarin:
 *  ~180 字/分 normal conversation, ~240–300 presentation, 300+ fast. The single
 *  tuning knob is `FAST_HZ`: lower it to make "too fast" trigger sooner.
 *  4.0/s ≈ 240 字/分 (upper-presentation — deliberately on the sensitive side). */
export const FAST_HZ = 4;
export function paceBand(hz: number): { key: TranslationKey; watch: boolean } {
  if (hz > FAST_HZ) return { key: "delivery.pace.fast", watch: true };
  if (hz >= 2) return { key: "delivery.pace.comfortable", watch: false };
  return { key: "delivery.pace.slow", watch: false };
}

/** Talk-share band: ≥65% of the talking reads as steamrolling, ≤35% as quiet. */
export function talkBand(me: number): { key: TranslationKey; watch: boolean } {
  if (me >= 0.65) return { key: "delivery.talk.high", watch: true };
  if (me <= 0.35) return { key: "delivery.talk.low", watch: false };
  return { key: "delivery.talk.balanced", watch: false };
}
