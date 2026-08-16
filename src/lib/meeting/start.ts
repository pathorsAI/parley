import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useStore } from "../store";
import { STT_BY_ID, sttApiKey, sttRelayUrl } from "../transcription/providers";
import { startMockStream } from "../mockStream";
import { isTauri } from "../tauriEvents";
import { translate, type TranslationKey } from "../../i18n/messages";
import type { Settings } from "../types";
import { log } from "../log";

/** In-flight latch: a double-click (or two start buttons hit in quick
 *  succession) would otherwise race two transcription sessions open. */
let starting = false;

/**
 * Open the capture session and start recording.
 *
 * THE one start path — the titlebar, Home and the sidebar all call it, because
 * two copies of the provider checks would drift, and those checks are the only
 * thing standing between a missing key and a recorder that isn't recording.
 */
export async function beginMeeting(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    await start();
  } finally {
    starting = false;
  }
}

async function start(): Promise<void> {
  const s = useStore.getState();
  const { settings } = s;
  const sttKey = sttApiKey(settings, settings.transcriptionProvider);
  const t = (key: TranslationKey) => translate(settings.language, key);
  const useRealPipeline = isTauri() && !!sttKey.trim();

  s.startMeeting();

  if (useRealPipeline) {
    await openCaptureSession(settings, sttKey);
  } else if (settings.transcriptionProvider === "parley") {
    // Hosted STT selected but no usable cloud session — never fake it with a
    // mock transcript; tell the user to sign in and back out of "recording".
    log.info("meeting: start blocked (parley, no session)");
    useStore.getState().stopMeeting();
    toast.error(t("meeting.error.signin"));
  } else {
    log.info("meeting: start (mock stream)");
    startMockStream();
  }
}

/** The real capture path: hand the configured provider to Rust. Any failure
 *  backs the UI out of "recording" rather than leaving a recorder that isn't
 *  recording. */
async function openCaptureSession(settings: Settings, sttKey: string): Promise<void> {
  const provider = STT_BY_ID[settings.transcriptionProvider];
  log.info("meeting: start requested", {
    provider: settings.transcriptionProvider,
    model: provider.label,
    diarization: provider.diarization,
    inputDevice: settings.inputDevice,
    pipeline: "real",
  });
  try {
    // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL +
    // the session token as apiKey, via sttApiKey). BYOK providers send no
    // relay URL and connect straight to their vendor.
    await invoke("start_meeting", {
      provider: settings.transcriptionProvider,
      apiKey: sttKey,
      diarization: provider.diarization,
      inputDevice: settings.inputDevice,
      relayUrl: sttRelayUrl(settings.transcriptionProvider, "meeting"),
    });
  } catch (e) {
    log.error("meeting: start failed", {
      provider: settings.transcriptionProvider,
      inputDevice: settings.inputDevice,
      error: String(e),
    });
    useStore.getState().stopMeeting();
  }
}
