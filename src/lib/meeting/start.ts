import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useStore } from "../store";
import { STT_BY_ID, sttApiKey, sttRelayUrl } from "../transcription/providers";
import { startMockStream } from "../mockStream";
import { isTauri } from "../tauriEvents";
import { translate, type TranslationKey } from "../../i18n/messages";
import { log } from "../log";

/**
 * Open the capture session for the meeting the user just set up in pre-flight.
 *
 * Extracted from the titlebar so the pre-flight footer and the titlebar's
 * "record now" escape hatch run the SAME sequence — two copies of the
 * provider/translation preflight checks would drift, and the checks are the
 * only thing standing between a missing key and a silently untranslated call.
 *
 * Callers own their own re-entrancy guard (a double-click here would race two
 * transcription sessions open).
 */
export async function beginMeeting(): Promise<void> {
  const s = useStore.getState();
  const { settings } = s;
  const sttKey = sttApiKey(settings, settings.transcriptionProvider);
  const t = (key: TranslationKey) => translate(settings.language, key);
  const useRealPipeline = isTauri() && !!sttKey.trim();

  // Meeting translation needs its own (Gemini) key on top of the STT key;
  // refuse loudly rather than silently starting an untranslated meeting.
  if (useRealPipeline && settings.meetingTranslateEnabled && !settings.geminiApiKey.trim()) {
    toast.error(t("meeting.translate.noKey"));
    return;
  }

  s.startMeeting();

  if (useRealPipeline) {
    log.info("meeting: start requested", {
      provider: settings.transcriptionProvider,
      model: STT_BY_ID[settings.transcriptionProvider].label,
      diarization: STT_BY_ID[settings.transcriptionProvider].diarization,
      inputDevice: settings.inputDevice,
      translate: settings.meetingTranslateEnabled ? settings.translateTargetLanguage : "off",
      pipeline: "real",
    });
    try {
      // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL +
      // the session token as apiKey, via sttApiKey). BYOK providers send no
      // relay URL and connect straight to their vendor.
      await invoke("start_meeting", {
        provider: settings.transcriptionProvider,
        apiKey: sttKey,
        diarization: STT_BY_ID[settings.transcriptionProvider].diarization,
        inputDevice: settings.inputDevice,
        relayUrl: sttRelayUrl(settings.transcriptionProvider),
        // Meeting translation (off → nulls): "me" runs through Gemini
        // live-translate; the voice goes out the translate output device.
        translateLanguage: settings.meetingTranslateEnabled
          ? settings.translateTargetLanguage
          : null,
        translateOutputDevice: settings.meetingTranslateEnabled
          ? settings.translateOutputDevice || null
          : null,
        translateApiKey: settings.meetingTranslateEnabled ? settings.geminiApiKey : null,
      });
    } catch (e) {
      log.error("meeting: start failed", {
        provider: settings.transcriptionProvider,
        inputDevice: settings.inputDevice,
        error: String(e),
      });
      useStore.getState().stopMeeting();
    }
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
