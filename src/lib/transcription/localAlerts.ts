import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useStore } from "../store";
import { log } from "../log";
import { isTauri } from "../platform";
import { openSettings } from "../nav/settings";
import { translate, type TranslationKey } from "../../i18n/messages";
import type { AppLanguage, SttProviderId } from "../types";
import { LOCAL_STT_SLOW_EVENT, type LocalFailureCode, type LocalSttSlowPayload } from "./localModels";
import { usesLocalModel } from "./registry";

/**
 * The on-device provider's two runtime alerts, both pointing at Settings ›
 * Transcription:
 *
 * - a session that failed for good (`meeting://error` codes "local",
 *   "local-memory", "local-missing" — see `local_stt::failure_code`);
 * - `local-stt://slow`: the decoder cannot keep up with real time on this
 *   machine. One toast per app run, and only while "local" is still the
 *   provider (a late event from a session that has since been switched away
 *   from says nothing useful).
 */

/** Toast text per local failure code. */
export const LOCAL_FAILURE_TOAST_KEY: Record<LocalFailureCode, TranslationKey> = {
  "local-missing": "localStt.error.notReady",
  "local-memory": "localStt.error.memory",
  local: "localStt.error.failed",
};

export function isLocalFailureCode(code: string): code is LocalFailureCode {
  return Object.prototype.hasOwnProperty.call(LOCAL_FAILURE_TOAST_KEY, code);
}

const openTranscriptionSettings = () => openSettings("transcription");

/** The failure toast for a local code, with the start gates' Open settings action. */
export function showLocalFailureToast(language: AppLanguage, code: LocalFailureCode): void {
  toast.error(translate(language, LOCAL_FAILURE_TOAST_KEY[code]), {
    duration: 10_000,
    action: { label: translate(language, "ai.fail.openSettings"), onClick: openTranscriptionSettings },
  });
}

/** Decides whether a slow event gets the toast: only for the local provider,
 *  and only the first time per gate (= per app run). Pure, for the tests. */
export function createSlowToastGate(): (provider: SttProviderId) => boolean {
  let shown = false;
  return (provider) => {
    if (shown || !usesLocalModel(provider)) return false;
    shown = true;
    return true;
  };
}

const slowToastGate = createSlowToastGate();

/**
 * Subscribe to `local-stt://slow` (the main window hosts both meetings and
 * voice typing, so one listener covers both) and show the "switch to a smaller
 * model" toast once. No-op outside Tauri.
 */
export async function listenForLocalSttSlow(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<LocalSttSlowPayload>(LOCAL_STT_SLOW_EVENT, (event) => {
    const { settings } = useStore.getState();
    log.warn("local-stt: decoding slower than real time", {
      model: event.payload.model,
      rtf: event.payload.rtf,
      provider: settings.transcriptionProvider,
    });
    if (!slowToastGate(settings.transcriptionProvider)) return;
    toast.warning(translate(settings.language, "localStt.slow.toast"), {
      duration: 15_000,
      action: { label: translate(settings.language, "ai.fail.openSettings"), onClick: openTranscriptionSettings },
    });
  });
}
