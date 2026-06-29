//! Voice-typing host: runs in the main window. Listens for the global fn-key
//! push-to-talk events from Rust, drives the streaming session + overlay, and on
//! release copies the (Simplified→Traditional converted) result to the clipboard
//! and — when enabled — pastes it into the frontmost app.
//!
//! The overlay window owns the live text (it converts S→T and renders it) and
//! reports the current text back over `voicetyping://text`; we copy exactly what
//! the user saw.

import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { sttApiKey } from "../transcription/providers";
import { log } from "../log";
import { showOverlay, hideOverlay, prewarmOverlay } from "./overlay";
import { appendVoiceEntry } from "./history";

// After the key is released we keep the session open and wait for the STT to
// flush its final tokens — finalizing only once the text has been quiet for
// SETTLE_MS (so the last words aren't cut off), capped at MAX_WAIT_MS.
const SETTLE_MS = 500;
const MAX_WAIT_MS = 3000;
/** Keep the result visible briefly before hiding the overlay. */
const HIDE_DELAY_MS = 1100;

let latestText = "";
let lastTextAt = 0;
let releasedAt = 0;
let down = false;
let busy = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

/** Wire up the host. Returns a cleanup function. No-op outside Tauri. */
export function initVoiceTyping(): () => void {
  if (!isTauri()) return () => {};
  let unPtt: UnlistenFn = () => {};
  let unText: UnlistenFn = () => {};
  listen<{ down: boolean }>("voicetyping://ptt", (e) => {
    onPtt(e.payload.down).catch(() => {});
  })
    .then((u) => (unPtt = u))
    .catch(() => {});
  listen<{ text: string }>("voicetyping://text", (e) => {
    latestText = e.payload.text;
    lastTextAt = Date.now();
  })
    .then((u) => (unText = u))
    .catch(() => {});
  // Warm the overlay window so it's listening before the first key press.
  // The native listener is started by Rust at launch; this applies the user's
  // persisted trigger key and keeps Rust in sync when Settings changes it.
  syncShortcut(useStore.getState().settings.voiceTypingShortcut).catch(() => {});
  const unShortcut = useStore.subscribe((state, prev) => {
    const next = state.settings.voiceTypingShortcut;
    if (next !== prev.settings.voiceTypingShortcut) syncShortcut(next).catch(() => {});
  });
  prewarmOverlay().catch(() => {});
  return () => {
    unPtt();
    unText();
    unShortcut();
  };
}

async function syncShortcut(shortcut: string) {
  await invoke("set_voice_typing_shortcut", { shortcut }).catch((e) => {
    log.warn("voice-typing: hotkey listener not active", { error: String(e), shortcut });
  });
}

async function onPtt(isDown: boolean) {
  if (isDown === down) return; // ignore key repeats / duplicates
  down = isDown;
  if (isDown) await startSession();
  else await endSession();
}

async function startSession() {
  if (busy) return;
  const { settings } = useStore.getState();
  const provider = settings.transcriptionProvider;
  const apiKey = sttApiKey(settings, provider);
  if (!apiKey.trim()) {
    log.warn("voice-typing: no STT API key configured");
    await showOverlay();
    await emit("voicetyping://session", { phase: "error", message: "no-key" });
    scheduleHide();
    return;
  }
  busy = true;
  latestText = "";
  lastTextAt = Date.now();
  clearTimeout(settleTimer);
  clearTimeout(hideTimer);
  await showOverlay();
  await emit("voicetyping://session", { phase: "start" });
  try {
    await invoke("start_voice_typing", {
      provider,
      apiKey,
      languageHints: [],
      inputDevice: settings.inputDevice || null,
    });
    log.info("voice-typing: session started", { provider });
  } catch (e) {
    log.error("voice-typing: start failed", { error: String(e) });
    busy = false;
    await emit("voicetyping://session", { phase: "error", message: String(e) });
    scheduleHide();
  }
}

async function endSession() {
  if (!busy) return;
  releasedAt = Date.now();
  // Closing the mic tells the STT adapter to finalize; the trailing final tokens
  // arrive over the next moments and keep updating the text. We wait for them.
  try {
    await invoke("stop_voice_typing");
  } catch (e) {
    log.warn("voice-typing: stop failed", { error: String(e) });
  }
  await emit("voicetyping://session", { phase: "stop" });
  waitForSettle();
}

/** Finalize once the transcript has been quiet for SETTLE_MS (final flush done),
 *  or MAX_WAIT_MS after release as a hard stop. */
function waitForSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    const quietFor = Date.now() - lastTextAt;
    const elapsed = Date.now() - releasedAt;
    if (quietFor >= SETTLE_MS || elapsed >= MAX_WAIT_MS) {
      finalize().catch(() => {});
    } else {
      waitForSettle();
    }
  }, 120);
}

async function finalize() {
  busy = false;
  const text = latestText.trim();
  if (text) {
    try {
      await invoke("copy_to_clipboard", { text });
      if (useStore.getState().settings.voiceTypingAutoPaste) {
        const pasted = await invoke<boolean>("paste_to_frontmost");
        if (!pasted) log.warn("voice-typing: auto-paste skipped (Accessibility not granted)");
      }
      log.info("voice-typing: copied", { chars: text.length });
    } catch (e) {
      log.error("voice-typing: copy/paste failed", { error: String(e) });
    }
    appendVoiceEntry(text).catch(() => {});
  }
  await emit("voicetyping://session", { phase: "done", message: text ? "ok" : "empty" });
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideOverlay().catch(() => {});
  }, HIDE_DELAY_MS);
}
