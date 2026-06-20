import { useStore, visibleSegments } from "../store";
import { hasProviderKey } from "../ai/settings";
import { log } from "../log";
import { translate } from "../../i18n/messages";

let wargameBusy = false;

/**
 * Auto-detect THEM's key arguments from the (playhead-masked) transcript and
 * write the result into the store. Store-based — like `runAllEvaluations` — so it
 * can be triggered from the War-game tab AND from the replay "re-evaluate at this
 * moment" button, and the panel is just a view of the result. Messages are
 * localized here (engine isn't a React component) via `translate(...)`.
 */
export async function runWargameDetect(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, meetingContext, setWargame } = state;
  const lang = settings.language;
  if (wargameBusy) {
    log.debug("wargame: skip", { reason: "busy" });
    return;
  }

  // Replay-aware: only analyze what was said up to the playhead.
  const segments = visibleSegments(state);

  if (!hasProviderKey(settings)) {
    log.debug("wargame: skip", { reason: "no key" });
    setWargame({ wargameStatus: "error", wargameArgs: [], wargameMessage: translate(lang, "wargame.missingKey") });
    return;
  }
  if (!segments.some((s) => s.isFinal && s.text.trim())) {
    log.debug("wargame: skip", { reason: "no transcript" });
    setWargame({ wargameStatus: "error", wargameArgs: [], wargameMessage: translate(lang, "wargame.noTranscript") });
    return;
  }

  wargameBusy = true;
  setWargame({ wargameStatus: "running", wargameMessage: null });
  try {
    log.info("wargame: detect start", { segments: segments.length });
    const { detectArguments } = await import("../ai/wargame");
    const args = await detectArguments({ settings, segments, names: speakerNames, meetingContext });
    log.info("wargame: detect done", { arguments: args.length });
    setWargame({
      wargameStatus: "done",
      wargameArgs: args,
      wargameMessage: args.length === 0 ? translate(lang, "wargame.none") : null,
    });
  } catch (err) {
    log.error("wargame: detect failed", { error: String(err) });
    const { describeAiError } = await import("../ai/errors");
    setWargame({
      wargameStatus: "error",
      wargameArgs: [],
      wargameMessage: translate(lang, "wargame.failed", { error: describeAiError(err) }),
    });
  } finally {
    wargameBusy = false;
  }
}
