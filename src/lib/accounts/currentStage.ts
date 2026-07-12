import { useStore } from "../store";
import { useAccounts } from "./store";
import { translate, type TranslationKey } from "../../i18n/messages";
import {
  buildBuiltinBundles,
  mergeBundles,
  readStageBundleOverrides,
  type StageBundle,
} from "./bundles";
import { SALES_STAGES, type SalesStage } from "./types";
import type { Settings } from "../types";

/**
 * THIS call's stage and bundle (S19), resolved imperatively for non-React
 * callers (live intel extraction). Precedence: the user's per-call choice →
 * the linked thread's stage → the pipeline's first stage. StageBoard derives
 * the same thing reactively — keep the two in step.
 */
export function resolveMeetingStage(): SalesStage {
  const s = useStore.getState();
  if (s.meetingStage) return s.meetingStage;
  const thread = useAccounts.getState().threads.find((t) => t.id === s.meetingThreadId);
  return (thread?.kind === "sales" ? thread.stage : undefined) ?? SALES_STAGES[0];
}

/** The current call's stage bundle (builtins + user overrides, i18n'd). */
export async function resolveMeetingBundle(settings: Settings): Promise<StageBundle> {
  const t = (key: string) => translate(settings.language, key as TranslationKey);
  const bundles = mergeBundles(buildBuiltinBundles(t), await readStageBundleOverrides());
  return bundles[resolveMeetingStage()];
}
