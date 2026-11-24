// Pick-time decisions for an uploaded recording, made from its metadata before
// any heavy work starts: whether hosted transcription needs it split into
// parts (one upload is capped at 6 hours), or whether it can't be sent at all
// (an uncompressible format over the upload size limit).

import type { AppLanguage } from "../types";
import type { AudioProbe } from "../ipc/commands";
import { HOSTED_MAX_PART_SECONDS, HOSTED_UPLOAD_LIMIT_BYTES } from "../limits";
import { translate, type TranslationKey } from "../../i18n/messages";

/** How a long recording is cut: `parts` equal parts of `partSeconds` each. */
export interface SplitPlan {
  parts: number;
  partSeconds: number;
}

/** The equal split hosted transcription needs for `durationSeconds`, or null
 *  when the recording fits in one upload (or its length is unknown — then it
 *  goes up whole and the server's own limit message applies). */
export function splitPlan(durationSeconds: number | null | undefined): SplitPlan | null {
  if (durationSeconds == null || !Number.isFinite(durationSeconds)) return null;
  if (durationSeconds <= HOSTED_MAX_PART_SECONDS) return null;
  const parts = Math.ceil(durationSeconds / HOSTED_MAX_PART_SECONDS);
  return { parts, partSeconds: durationSeconds / parts };
}

/** What the import wizard does with a picked file before transcribing it. */
export type ImportDecision =
  | { kind: "proceed" }
  | { kind: "split"; durationSeconds: number; plan: SplitPlan }
  | { kind: "refuse"; key: TranslationKey };

/**
 * Decide from a file's probe. Only hosted (Parley Cloud) transcription has the
 * 6-hour and 100 MB limits; BYOK vendors set their own, so their uploads always
 * proceed as before. A failed probe (null) proceeds too: compression streams,
 * so nothing crashes, and the server's errors still explain any refusal.
 */
export function decideImport(probe: AudioProbe | null, hosted: boolean): ImportDecision {
  if (!probe || !hosted) return { kind: "proceed" };
  if (!probe.compressible) {
    return probe.bytes > HOSTED_UPLOAD_LIMIT_BYTES
      ? { kind: "refuse", key: "ingest.error.uncompressibleTooLarge" }
      : { kind: "proceed" };
  }
  const durationSeconds = probe.durationMs == null ? null : probe.durationMs / 1000;
  const plan = splitPlan(durationSeconds);
  return plan && durationSeconds != null ? { kind: "split", durationSeconds, plan } : { kind: "proceed" };
}

/** A long length in hours and minutes: 「7 小時 12 分」 / "7 h 12 min". */
export function formatLongDuration(seconds: number, language: AppLanguage): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return translate(language, "ingest.split.duration.hm", { h, m });
  if (h > 0) return translate(language, "ingest.split.duration.h", { h });
  return translate(language, "ingest.split.duration.m", { m });
}

/** The title of part `k` of `n`: 「name（1/3）」 / "name (1/3)". */
export function partTitle(name: string, k: number, n: number, language: AppLanguage): string {
  return translate(language, "ingest.split.partTitle", { name, k, n });
}

/** What the wizard's first step shows for a decision: still probing, the
 *  refusal, the split notice awaiting a yes, or the usual start form. */
export type WizardGate = "probing" | "refuse" | "splitNotice" | "ready";

export function wizardGate(decision: ImportDecision | null, splitConfirmed: boolean): WizardGate {
  if (!decision) return "probing";
  if (decision.kind === "refuse") return "refuse";
  if (decision.kind === "split" && !splitConfirmed) return "splitNotice";
  return "ready";
}
