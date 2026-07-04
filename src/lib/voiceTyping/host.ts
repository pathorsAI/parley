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
import { sttApiKey, sttRelayUrl } from "../transcription/providers";
import { log } from "../log";
import { showOverlay, hideOverlay, prewarmOverlay } from "./overlay";
import { appendVoiceEntry } from "./history";

/** localStorage flag: the boot-time Accessibility prompt has been shown once
 *  for this install (see initVoiceTyping — later launches must not re-nag). */
const AX_BOOT_PROMPTED_KEY = "parley:ax-boot-prompted";

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
/** The backend reported the STT session dead (voicetyping://error). */
let failed = false;
/** Session generation. A finalize that was still awaiting its copy/paste when
 *  a NEW session started must not run its tail (emit "done" + schedule hide)
 *  against the new session's overlay. */
let gen = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

/** Wire up the host. Returns a cleanup function. No-op outside Tauri. */
export function initVoiceTyping(): () => void {
  if (!isTauri()) return () => {};
  let unPtt: UnlistenFn = () => {};
  let unText: UnlistenFn = () => {};
  let unErr: UnlistenFn = () => {};
  // Serialize press/release handling: a quick tap used to run endSession's
  // `stop_voice_typing` while startSession's invoke was still in flight, so
  // the stop reached Rust FIRST and no-op'd — leaving a live, ownerless
  // backend session (mic claimed, socket open) behind. Chaining guarantees
  // start has resolved before its matching stop is issued.
  let pttChain: Promise<void> = Promise.resolve();
  listen<{ down: boolean }>("voicetyping://ptt", (e) => {
    const isDown = e.payload.down;
    pttChain = pttChain.then(() => onPtt(isDown)).catch(() => {});
  })
    .then((u) => (unPtt = u))
    .catch(() => {});
  listen<{ text: string }>("voicetyping://text", (e) => {
    latestText = e.payload.text;
    lastTextAt = Date.now();
  })
    .then((u) => (unText = u))
    .catch(() => {});
  // Backend STT failure (rejected key, expired hosted session, out of
  // credits). The host owns the session lifecycle, so it bridges the event
  // into the overlay's one error surface (`voicetyping://session`) — the code
  // picks the overlay message (quota/auth/…). Without this, a dead session
  // looks like successful silence: frozen waveform, no transcript, no
  // explanation. The mic stays claimed until release; endSession still stops
  // it, and finalize still delivers whatever text arrived before the death.
  listen<{ code: string }>("voicetyping://error", (e) => {
    if (!busy) return; // stale event from an already-finished session
    failed = true;
    log.warn("voice-typing: session failed", { code: e.payload.code });
    emit("voicetyping://session", { phase: "error", message: e.payload.code }).catch(() => {});
  })
    .then((u) => (unErr = u))
    .catch(() => {});
  // Apply the saved push-to-talk key so the right trigger is live from launch
  // (registers Option+Space, or arms the HID tap for a modifier key). The
  // Settings panel re-applies it whenever the user changes the selection.
  invoke("set_voice_typing_shortcut", {
    shortcut: useStore.getState().settings.voiceTypingShortcut,
  }).catch(() => {});
  // Voice typing always auto-pastes on release, which needs Accessibility —
  // while the feature is enabled (it defaults on), ask for that grant on the
  // FIRST launch instead of failing quietly on the first dictation. At most
  // once per install: an untrusted result here does not mean "never asked" —
  // the user may have declined, or the grant went stale because the TCC
  // identity changed (every dev rebuild, a moved or re-signed app) — and
  // re-prompting on every launch nags exactly those users forever. Later
  // launches only log; Settings keeps the explicit re-grant paths (the enable
  // toggle and the grant button), and auto-paste degrades to clipboard-only
  // meanwhile.
  if (useStore.getState().settings.voiceTypingEnabled) {
    invoke<boolean>("accessibility_status", { prompt: false })
      .then((trusted) => {
        if (trusted) return;
        log.warn("voice-typing: Accessibility not granted; auto-paste falls back to clipboard");
        if (localStorage.getItem(AX_BOOT_PROMPTED_KEY)) return;
        localStorage.setItem(AX_BOOT_PROMPTED_KEY, "1");
        return invoke("accessibility_status", { prompt: true }).then(() => {});
      })
      .catch(() => {});
  }
  // Warm the overlay window so it's listening before the first key press.
  prewarmOverlay().catch(() => {});
  return () => {
    unPtt();
    unText();
    unErr();
  };
}

async function onPtt(isDown: boolean) {
  if (isDown === down) return; // ignore key repeats / duplicates
  down = isDown;
  if (isDown) await startSession();
  else await endSession();
}

async function startSession() {
  if (busy) {
    // A press during the previous dictation's settle window. Swallowing it
    // (the old behavior) left the user talking into nothing — instead deliver
    // the pending text now and fall through to a fresh session. The backend
    // start also aborts any session task still flushing, so the old session
    // cannot leak tokens into the new overlay.
    clearTimeout(settleTimer);
    await finalize().catch(() => {});
  }
  const { settings } = useStore.getState();
  if (!settings.voiceTypingEnabled) return;
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
  failed = false;
  gen += 1;
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
      inputDevice: settings.inputDevice ?? null,
      relayUrl: sttRelayUrl(provider),
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
  if (failed) {
    // The session already died — no final flush is coming, and emitting
    // "stop" would replace the overlay's error state with a spinner. Deliver
    // whatever text arrived before the death right away.
    finalize().catch(() => {});
    return;
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
  const myGen = gen;
  busy = false;
  const text = latestText.trim();
  if (text) {
    try {
      await invoke("copy_to_clipboard", { text });
      // Auto-paste is the default behaviour (no setting): simulate ⌘V into the
      // frontmost app; without Accessibility it degrades to clipboard-only.
      const pasted = await invoke<boolean>("paste_to_frontmost");
      if (!pasted) log.warn("voice-typing: auto-paste skipped (Accessibility not granted)");
      log.info("voice-typing: copied", { chars: text.length, pasted });
    } catch (e) {
      log.error("voice-typing: copy/paste failed", { error: String(e) });
    }
    appendVoiceEntry(text).catch(() => {});
  }
  // A new press may have started a session while the copy/paste above was in
  // flight — its overlay is live, and this finalize's tail must not flip it to
  // "done" or hide it. The text above was still delivered (it predates the
  // new session).
  if (gen !== myGen) return;
  await emit("voicetyping://session", { phase: "done", message: text ? "ok" : "empty" });
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideOverlay().catch(() => {});
  }, HIDE_DELAY_MS);
}
