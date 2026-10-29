import type { Settings } from "../types";
import { sttApiKey } from "../transcription/providers";
import { usesCloudSession, usesLocalModel } from "../transcription/registry";
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
 * - Parley's hosted STT: a signed-in session.
 * - A bring-your-own provider: its key. Being signed in doesn't stand in for
 *   it — a signed-in user who picks their own models still needs the key, or
 *   the first meeting is refused with "no transcription key".
 */
export function accountGateBlock(
  settings: Settings,
  signedIn: boolean,
  local: LocalGateInput,
): AccountGateBlock | null {
  if (usesLocalModel(settings.transcriptionProvider)) {
    if (anyLocalBusy(local.models, local.downloads)) return "localDownloading";
    return isLocalModelReady(local.models, settings.localSttModel) ? null : "localDownload";
  }
  if (usesCloudSession(settings.transcriptionProvider)) return signedIn ? null : "credential";
  return sttApiKey(settings, settings.transcriptionProvider).trim() ? null : "credential";
}

export function transcriptionReady(settings: Settings, signedIn: boolean, local: LocalGateInput): boolean {
  return accountGateBlock(settings, signedIn, local) === null;
}
