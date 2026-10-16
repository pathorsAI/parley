import type { Settings } from "../types";
import { sttApiKey } from "../transcription/providers";
import {
  anyLocalBusy,
  isLocalModelReady,
  type LocalDownloads,
  type LocalSttModel,
} from "../transcription/localModels";

/** What the onboarding account step knows about on-device models. `models` is
 *  null while the catalog is loading (or when the provider isn't "local"). */
export interface LocalGateInput {
  models: readonly LocalSttModel[] | null;
  downloads: LocalDownloads;
}

/** Why the account step can't be left yet; `null` = it can. */
export type AccountGateBlock = "credential" | "localDownload" | "localDownloading";

/**
 * The account gate: transcription must be able to run before the wizard lets
 * the user go — the same conditions `beginMeeting` checks before it opens a
 * capture session.
 *
 * - "local" (on-device): the selected model is downloaded and verified, and no
 *   download is still in flight. Signing in does not bypass this — the user
 *   chose to transcribe on this device, so that has to work.
 * - Otherwise: a Parley session (hosted STT) or a key for the selected BYOK
 *   provider.
 */
export function accountGateBlock(
  settings: Settings,
  signedIn: boolean,
  local: LocalGateInput,
): AccountGateBlock | null {
  if (settings.transcriptionProvider === "local") {
    if (anyLocalBusy(local.models, local.downloads)) return "localDownloading";
    return isLocalModelReady(local.models, settings.localSttModel) ? null : "localDownload";
  }
  return signedIn || !!sttApiKey(settings, settings.transcriptionProvider).trim() ? null : "credential";
}

export function transcriptionReady(settings: Settings, signedIn: boolean, local: LocalGateInput): boolean {
  return accountGateBlock(settings, signedIn, local) === null;
}
