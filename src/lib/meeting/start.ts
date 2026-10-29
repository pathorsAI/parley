import { toast } from "sonner";
import { isMeetingActive, useStore } from "../store";
import { meetingUsesRealPipeline, prepareTranscription, type TranscriptionRequest } from "../transcription/prepare";
import { blockMessageKey } from "../transcription/errors";
import { startMockStream } from "../mockStream";
import { translate, type TranslationKey } from "../../i18n/messages";
import type { Settings } from "../types";
import { log } from "../log";
import { openSettings } from "../nav/settings";
import * as ipc from "../ipc/commands";
import { isTauri } from "../platform";
import { liveSaves } from "../history/history";
import { endMeeting, recoverOrphanedMeeting } from "./controls";

/** How long Start waits for the previous meeting's save before going ahead
 *  anyway. Its Stop-time snapshot keeps that save correct regardless; the
 *  wait only keeps the two meetings from overlapping on screen. */
export const PREVIOUS_SAVE_WAIT_MS = 30_000;

/** In-flight latch: a double-click (or two start buttons hit in quick
 *  succession) would otherwise race two transcription sessions open. */
let starting = false;

/**
 * Open the capture session and start recording.
 *
 * THE one start path — the titlebar, Home and the sidebar all call it, because
 * two copies of the provider checks would drift, and those checks are the only
 * thing standing between a missing key and a recorder that isn't recording.
 * The checks themselves are `prepareTranscription("meeting", …)`, shared with
 * voice typing and uploads; this only decides how a refusal is shown.
 */
export async function beginMeeting(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    if (!(await readyToStart())) return;
    await start();
  } finally {
    starting = false;
  }
}

/**
 * Clear the way for a new meeting. Start never lands silently on top of one
 * that is still going: a meeting this window is running is surfaced (with
 * the explicit "end it and start a new one"); a recording the backend is
 * making for a meeting this window lost is stopped and saved first — that
 * silent no-op is how one desktop's evening meeting absorbed the next
 * morning's; and a previous meeting still being saved is waited for, briefly.
 */
async function readyToStart(): Promise<boolean> {
  const s = useStore.getState();
  const t = (key: TranslationKey) => translate(s.settings.language, key);
  if (isMeetingActive(s.meetingStatus)) {
    log.info("meeting: start pressed while a meeting is recording");
    // Its own window holds it: bring that up beside the explanation.
    if (isTauri()) {
      void import("./meetingWindow")
        .then((m) => m.focusMeetingWindow())
        .catch((error) => log.warn("meeting: focusing the meeting window failed", { error: String(error) }));
    }
    toast.message(t("meeting.start.alreadyRecording"), {
      action: { label: t("meeting.start.endAndStartNew"), onClick: () => void endAndStartNew() },
    });
    return false;
  }
  if (isTauri() && meetingUsesRealPipeline(s.settings)) {
    await recoverOrphanedMeeting().catch((error) =>
      log.warn("meeting: orphaned recording check before start failed", { error: String(error) }),
    );
  }
  if (liveSaves.hasPending()) {
    log.info("meeting: start waits for the previous meeting to finish saving");
    const id = toast.loading(t("meeting.start.savingPrevious"));
    try {
      if (!(await liveSaves.whenSettled(PREVIOUS_SAVE_WAIT_MS))) {
        log.warn("meeting: previous save still running, starting anyway");
      }
    } finally {
      toast.dismiss(id);
    }
  }
  return true;
}

/** "End it and start a new one": the explicit way to start over a meeting
 *  that is running. The new one waits for the old one's save. */
export async function endAndStartNew(): Promise<void> {
  log.info("meeting: ending the running meeting to start a new one");
  await endMeeting();
  await beginMeeting();
}

const openTranscriptionSettings = () => openSettings("transcription");

async function start(): Promise<void> {
  const s = useStore.getState();
  const { settings } = s;
  const t = (key: TranslationKey) => translate(settings.language, key);
  const prepared = await prepareTranscription("meeting", settings);

  // On-device STT whose model isn't downloaded: refused before the UI flips
  // to "recording".
  if (!prepared.ok && prepared.code === "no-local-model") {
    log.info("meeting: start blocked (local model not ready)", { model: settings.localSttModel });
    toast.error(t(blockMessageKey("meeting", "no-local-model")), {
      duration: 8000,
      action: { label: t("ai.fail.openSettings"), onClick: openTranscriptionSettings },
    });
    return;
  }

  s.startMeeting();

  if (prepared.ok) {
    await openCaptureSession(settings, prepared.request);
  } else if (prepared.code === "signin") {
    // Hosted STT selected but no usable cloud session — never fake it with a
    // mock transcript; tell the user to sign in and back out of "recording".
    log.info("meeting: start blocked (parley, no session)");
    useStore.getState().stopMeeting();
    toast.error(t(blockMessageKey("meeting", "signin")));
  } else if (import.meta.env.DEV) {
    // Dev-only: a scripted transcript so the UI can be exercised without a key.
    log.info("meeting: start (mock stream)");
    startMockStream();
  } else {
    // Production with no transcription configured. This used to fall through to
    // the mock stream, which played a fake English transcript and saved
    // nothing — a recorder that looked like it worked but didn't. Refuse and
    // point at the fix instead.
    log.info("meeting: start blocked (no STT key)", { provider: settings.transcriptionProvider });
    useStore.getState().stopMeeting();
    toast.error(t(blockMessageKey("meeting", "no-key")), {
      duration: 8000,
      action: { label: t("ai.fail.openSettings"), onClick: openTranscriptionSettings },
    });
  }
}

/** The real capture path: hand the configured provider to Rust. Any failure
 *  backs the UI out of "recording" rather than leaving a recorder that isn't
 *  recording. */
async function openCaptureSession(settings: Settings, request: TranscriptionRequest): Promise<void> {
  const meetingId = useStore.getState().liveMeetingId;
  // Before the call: an End pressed while the start is in flight must still
  // find this meeting's snapshot waiting for its recording.
  if (meetingId) liveSaves.markRecording(meetingId);
  log.info("meeting: start requested", {
    provider: request.provider,
    model: request.info.label,
    diarization: request.diarization,
    inputDevice: settings.inputDevice,
    pipeline: "real",
  });
  try {
    // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL +
    // the session token as apiKey, via sttApiKey). BYOK providers send no
    // relay URL and connect straight to their vendor.
    //
    // Unlike voice typing and uploads, a meeting does not send
    // `request.languageHints` (start_meeting accepts them). Kept as is here:
    // closing that gap is a behavior change of its own.
    await ipc.startMeeting({
      provider: request.provider,
      apiKey: request.apiKey,
      diarization: request.diarization,
      inputDevice: settings.inputDevice,
      relayUrl: request.relayUrl,
      // Which on-device model to run for "local"; null = provider default.
      model: request.model,
      // Bias the recognizer with the user's own name and company, then the
      // phrase dictionary — the terms it keeps mishearing in dictation are the
      // same ones it mishears in a meeting.
      vocabulary: request.vocabulary,
      meetingId,
    });
  } catch (e) {
    // Nothing is recording, so no recording event will settle a save.
    if (meetingId) liveSaves.forget(meetingId);
    log.error("meeting: start failed", {
      provider: settings.transcriptionProvider,
      inputDevice: settings.inputDevice,
      error: String(e),
    });
    useStore.getState().stopMeeting();
    // A start refused because the backend is still recording (a race with
    // the check above) must not leave that recording running unseen.
    void recoverOrphanedMeeting().catch(() => {});
  }
}
