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
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isMac } from "../platform";
import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { sttApiKey, sttRelayUrl } from "../transcription/providers";
import { languageHintsFromSettings } from "../transcription/languageHints";
import { HOSTED_VOICE_TYPING_MAX_SECONDS } from "../limits";
import { log } from "../log";
import { showOverlay, hideOverlay, prewarmOverlay } from "./overlay";
import { appendVoiceEntry } from "./history";
import {
  addEntry,
  isIgnoredTwice,
  recordIgnore,
  removeEntry,
  removeVariant,
  vocabularyTerms,
  whenDictionaryReady,
  type AddResult,
} from "../dictionary";
import { detectCorrection } from "../dictionary/diffCorrection";
import {
  CORRECTION_CANDIDATE_EVENT,
  SUGGEST_ACTION_EVENT,
  SUGGEST_EVENT,
  SUGGEST_STATE_EVENT,
  type CorrectionCandidatePayload,
  type SuggestActionPayload,
} from "./suggestEvents";

/** localStorage flag: the boot-time Accessibility prompt has been shown once
 *  for this install (see initVoiceTyping — later launches must not re-nag). */
const AX_BOOT_PROMPTED_KEY = "parley:ax-boot-prompted";

// After the key is released we keep the session open and wait for the STT to
// flush its final tokens. FAST PATH: the backend emits `stt://closed` once the
// session is fully over (socket closed, every final token emitted) — from
// there we only wait CLOSE_DRAIN_MS for those last tokens to cross the
// overlay's S→T convert-and-report hop before pasting. FALLBACK (a provider or
// relay that never closes the socket): finalize once the text has been quiet
// for SETTLE_MS, capped at MAX_WAIT_MS after release.
const CLOSE_DRAIN_MS = 150;
const SETTLE_MS = 500;
const MAX_WAIT_MS = 3000;
/** Keep the "Copied to clipboard" confirmation floating a beat so the user
 *  clearly registers it before the overlay fades out. The overlay animates its
 *  own fade in the final stretch (see VoiceTypingApp's fade timing) — this sits
 *  comfortably AFTER that fade completes (dwell + fade ≈ 2600ms, plus event/IPC
 *  latency before the overlay's clock even starts) so the native hide always
 *  lands on an already-invisible window. */
const HIDE_DELAY_MS = 2900;

/** How long the "add this correction to the dictionary?" bubble waits for an
 *  answer before it gives up. Silence is NOT a "no" — the counter that stops us
 *  asking again only moves on an explicit Ignore. */
const SUGGEST_TIMEOUT_MS = 8000;
/** How long the "added · undo" confirmation stays up afterwards. */
const SUGGEST_ADDED_MS = 4000;
/** Accepts the suggestion without reaching for the mouse. Registered only while
 *  a bubble is on screen — the combo belongs to whatever app the user is typing
 *  in the rest of the time. */
const SUGGEST_SHORTCUT = "Alt+Enter";

/** Toggle mode: a press only toggles while "armed"; each release re-arms. So a
 *  tap is a key-down that FOLLOWS a key-up, and OS key-repeat (repeated downs
 *  with no intervening release, which the combo path can emit while held) is
 *  ignored — without a timing heuristic that could swallow a deliberate quick
 *  stop. Starts armed so the very first press acts. */
let toggleArmed = true;

let latestText = "";
let lastTextAt = 0;
let releasedAt = 0;
/** When `stt://closed` arrived for the current session (0 = not yet). */
let closedAt = 0;
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
/** Hosted-only: fires HOSTED_VOICE_TYPING_MAX_SECONDS after a "parley" session
 *  starts to auto-finalize it (the free plan caps a single dictation). Cleared
 *  whenever the session ends by any other path. */
let capTimer: ReturnType<typeof setTimeout> | undefined;

// ── Correction → dictionary suggestion ──────────────────────────────────────
/** Listener for the one correction candidate the current observation may
 *  report (null while nothing is being observed). */
let correctionUnlisten: UnlistenFn | null = null;
/** Listener for the overlay's button clicks (null while no bubble is up). */
let suggestActionUnlisten: UnlistenFn | null = null;
/** Either the 8 s "answer me" timeout or the 4 s "added" dwell — never both. */
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestShortcutOn = false;
/** The correction currently being offered (null once answered). */
let suggestion: { from: string; to: string } | null = null;
/** Exactly what the last accept wrote, so undo can take back that and nothing
 *  else: a whole new entry, or just the variant merged into an existing one. */
let lastAdd: AddResult | null = null;

/** Wire up the host. Returns a cleanup function. No-op outside Tauri. */
export function initVoiceTyping(): () => void {
  if (!isTauri()) return () => {};
  // macOS-only for now: the Alt+Space global shortcut would fire on Windows
  // too, but the delivery layer (clipboard + synthetic paste) isn't wired
  // there yet — a session that transcribes and then drops the text is worse
  // than no session.
  if (!isMac()) return () => {};
  // listen() resolves asynchronously — a cleanup that runs before it resolves
  // (StrictMode's dev double-mount of App) must still unlisten the late
  // arrival, or the second init's handlers double up for the app's lifetime.
  let cancelled = false;
  const unsubs: UnlistenFn[] = [];
  const track = (p: Promise<UnlistenFn>) => {
    p.then((u) => {
      if (cancelled) u();
      else unsubs.push(u);
    }).catch((error) => log.warn("voice-typing: listener setup failed", { error: String(error) }));
  };
  // Serialize press/release handling: a quick tap used to run endSession's
  // `stop_voice_typing` while startSession's invoke was still in flight, so
  // the stop reached Rust FIRST and no-op'd — leaving a live, ownerless
  // backend session (mic claimed, socket open) behind. Chaining guarantees
  // start has resolved before its matching stop is issued.
  let pttChain: Promise<void> = Promise.resolve();
  track(
    listen<{ down: boolean }>("voicetyping://ptt", (e) => {
      const isDown = e.payload.down;
      pttChain = pttChain
        .then(() => onPtt(isDown))
        .catch((error) =>
          log.error("voice-typing: push-to-talk handler failed", {
            isDown,
            error: String(error),
          }),
        );
    }),
  );
  track(
    listen<{ text: string }>("voicetyping://text", (e) => {
      latestText = e.payload.text;
      lastTextAt = Date.now();
    }),
  );
  // Backend STT failure (rejected key, expired hosted session, out of
  // credits). The host owns the session lifecycle, so it bridges the event
  // into the overlay's one error surface (`voicetyping://session`) — the code
  // picks the overlay message (quota/auth/…). Without this, a dead session
  // looks like successful silence: frozen waveform, no transcript, no
  // explanation. The mic stays claimed until release; endSession still stops
  // it, and finalize still delivers whatever text arrived before the death.
  track(
    listen<{ code: string }>("voicetyping://error", (e) => {
      if (!busy) return; // stale event from an already-finished session
      failed = true;
      log.warn("voice-typing: session failed", { code: e.payload.code });
      emit("voicetyping://session", { phase: "error", message: e.payload.code }).catch((error) =>
        log.warn("voice-typing: error event emit failed", { error: String(error) }),
      );
    }),
  );
  // The backend session is fully over — every final token has been emitted.
  // Re-arm the settle loop: it sees `closedAt` and finalizes after the short
  // CLOSE_DRAIN_MS instead of the SETTLE_MS quiet poll. Ignored unless we're
  // between release and finalize: while the key is DOWN the event is either a
  // server-side close mid-hold (which then ends on the normal release path)
  // or — after a fast re-press — a STALE close from the previous session
  // whose delivery slipped past startSession's `closedAt = 0` reset, and
  // honoring that one would cut the new session's flush short. Failed
  // sessions are finalized immediately by endSession already.
  track(
    listen<{ source: string }>("stt://closed", (e) => {
      if (e.payload.source !== "voice-typing") return;
      if (!busy || down || failed) return;
      closedAt = Date.now();
      waitForSettle();
    }),
  );
  // Apply the saved push-to-talk key so the right trigger is live from launch
  // (registers Option+Space, or arms the HID tap for a modifier key). The
  // Settings panel re-applies it whenever the user changes the selection.
  invoke("set_voice_typing_shortcut", {
    shortcut: useStore.getState().settings.voiceTypingShortcut,
  }).catch((error) =>
    log.warn("voice-typing: startup shortcut apply failed", { error: String(error) }),
  );
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
      .catch((error) =>
        log.warn("voice-typing: startup Accessibility check failed", { error: String(error) }),
      );
  }
  // Warm the overlay window so it's listening before the first key press.
  prewarmOverlay().catch((error) =>
    log.warn("voice-typing: overlay prewarm failed", { error: String(error) }),
  );
  return () => {
    cancelled = true;
    clearTimeout(capTimer);
    cancelSuggestion();
    stopObserving();
    unsubs.forEach((u) => u());
  };
}

async function onPtt(isDown: boolean) {
  // Toggle mode: a key PRESS starts a session and the next press ends it; the
  // release only re-arms (see `toggleArmed`). Not relying on the release to stop
  // also means a dropped key-up can't leave the session recording — the "still
  // transcribing after I let go" symptom.
  if (useStore.getState().settings.voiceTypingMode === "toggle") {
    if (!isDown) {
      toggleArmed = true; // release re-arms the next tap
      return;
    }
    if (!toggleArmed) return; // key-repeat while held — ignore
    toggleArmed = false;
    if (busy) {
      down = false; // mirror hold-mode release so the flush fast-path applies
      await endSession();
    } else {
      down = true; // guard a stale stt://closed during startup, like hold mode
      await startSession();
      down = busy; // clear if the start didn't actually take
    }
    return;
  }
  // Hold mode (default): press starts, release ends.
  if (isDown === down) return; // ignore key repeats / duplicates
  down = isDown;
  if (isDown) await startSession();
  else await endSession();
}

async function startSession() {
  // A new dictation supersedes anything still pending from the last one: the
  // overlay is about to be reused for this session, and a stale ⌥↩ must not
  // silently learn a correction the user has moved on from.
  cancelSuggestion();
  if (busy) {
    // A press during the previous dictation's settle window. Swallowing it
    // (the old behavior) left the user talking into nothing — instead deliver
    // the pending text now and fall through to a fresh session. The backend
    // start also aborts any session task still flushing, so the old session
    // cannot leak tokens into the new overlay.
    clearTimeout(settleTimer);
    await finalize().catch((error) =>
      log.error("voice-typing: finalize before restart failed", { error: String(error) }),
    );
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
  closedAt = 0;
  clearTimeout(settleTimer);
  clearTimeout(hideTimer);
  clearTimeout(capTimer);
  // The hosted "parley" plan caps a single dictation; BYOK is uncapped. Pass
  // the cap to the backend as a safety net (a hung webview can't stream the
  // paid relay forever) and mirror it with a frontend timer that finalizes
  // gracefully (delivering the transcript). null = no cap for BYOK.
  const hosted = provider === "parley";
  // MIC FIRST, overlay second. Placing the overlay costs four round-trips to
  // the app's main thread (cursor position → monitor list → setPosition →
  // present), and the capture used to wait behind all of them — so roughly the
  // first second of every dictation was never recorded, and any main-thread
  // work elsewhere in the app stretched that window arbitrarily. The overlay
  // webview is prewarmed and already subscribed, so it can be told the session
  // started before its window is on screen and simply catch up.
  const starting = invoke("start_voice_typing", {
    provider,
    apiKey,
    languageHints: languageHintsFromSettings(settings),
    // The user's phrase dictionary, as recognition bias: the terms they've
    // taught us are exactly the ones the model keeps getting wrong.
    vocabulary: vocabularyTerms(),
    inputDevice: settings.inputDevice ?? null,
    relayUrl: sttRelayUrl(provider, "voice_typing"),
    maxDurationSecs: hosted ? HOSTED_VOICE_TYPING_MAX_SECONDS : null,
  });
  const shown = showOverlay().catch((error) =>
    log.warn("voice-typing: overlay show failed", { error: String(error) }),
  );
  await emit("voicetyping://session", { phase: "start" });
  try {
    await starting;
    log.info("voice-typing: session started", { provider });
    if (hosted) {
      capTimer = setTimeout(() => {
        onCapReached().catch((error) =>
          log.error("voice-typing: cap handler failed", { error: String(error) }),
        );
      }, HOSTED_VOICE_TYPING_MAX_SECONDS * 1000);
    }
  } catch (e) {
    log.error("voice-typing: start failed", { error: String(e) });
    busy = false;
    // The overlay is this failure's only surface, so let it finish coming up
    // before the error is announced — it raced the start, and a message sent
    // to a window that never appeared is a silent dead session.
    await shown;
    await emit("voicetyping://session", { phase: "error", message: String(e) });
    scheduleHide();
  }
}

async function endSession() {
  if (!busy) return;
  clearTimeout(capTimer);
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
    finalize().catch((error) =>
      log.error("voice-typing: finalize after failed session failed", { error: String(error) }),
    );
    return;
  }
  await emit("voicetyping://session", { phase: "stop" });
  waitForSettle();
}

/** The hosted single-dictation cap elapsed while the key was still held. Treat
 *  it as a release: stop the backend session, mark the key up so the real
 *  key-up is a no-op, tell the overlay the limit ended it, then finalize (the
 *  transcript captured so far is still copied/pasted). */
async function onCapReached() {
  if (!busy) return;
  clearTimeout(capTimer);
  log.info("voice-typing: hosted single-session cap reached; finalizing");
  down = false;
  releasedAt = Date.now();
  try {
    await invoke("stop_voice_typing");
  } catch (e) {
    log.warn("voice-typing: stop failed at cap", { error: String(e) });
  }
  await emit("voicetyping://session", { phase: "limit" }).catch((error) =>
    log.warn("voice-typing: limit event emit failed", { error: String(error) }),
  );
  if (failed) {
    finalize().catch((error) =>
      log.error("voice-typing: finalize after cap failed", { error: String(error) }),
    );
    return;
  }
  waitForSettle();
}

/** Finalize as soon as the flush is provably over: CLOSE_DRAIN_MS after the
 *  backend's `stt://closed` (fast path), else once the transcript has been
 *  quiet for SETTLE_MS, else MAX_WAIT_MS after release as a hard stop. */
function waitForSettle() {
  clearTimeout(settleTimer);
  // Once closed, one short drain tick is all that's left; while still waiting
  // on the STT flush, poll on a small interval so no path adds avoidable lag.
  const delay = closedAt > 0 ? CLOSE_DRAIN_MS : 60;
  settleTimer = setTimeout(() => {
    const now = Date.now();
    const drained = closedAt > 0 && now - closedAt >= CLOSE_DRAIN_MS;
    const quietFor = now - lastTextAt;
    const elapsed = now - releasedAt;
    if (drained || quietFor >= SETTLE_MS || elapsed >= MAX_WAIT_MS) {
      finalize().catch((error) =>
        log.error("voice-typing: settle finalize failed", { error: String(error) }),
      );
    } else {
      waitForSettle();
    }
  }, delay);
}

async function finalize() {
  const myGen = gen;
  busy = false;
  clearTimeout(capTimer);
  const text = latestText.trim();
  if (text) {
    let appBundleId: string | null = null;
    try {
      await invoke("copy_to_clipboard", { text });
      // Auto-paste is the default behaviour (no setting): simulate ⌘V into the
      // frontmost app; without Accessibility it degrades to clipboard-only.
      const paste = await invoke<{ pasted: boolean; appBundleId: string | null }>(
        "paste_to_frontmost",
      );
      appBundleId = paste.appBundleId;
      if (!paste.pasted) log.warn("voice-typing: auto-paste skipped (Accessibility not granted)");
      log.info("voice-typing: copied", {
        chars: text.length,
        pasted: paste.pasted,
        appBundleId,
      });
      // Only a text that actually landed somewhere can be corrected in place.
      if (paste.pasted) {
        observePastedField(text, myGen).catch((error) =>
          log.warn("voice-typing: field observation failed", { error: String(error) }),
        );
      }
    } catch (e) {
      log.error("voice-typing: copy/paste failed", { error: String(e) });
    }
    appendVoiceEntry(text, appBundleId).catch((error) =>
      log.warn("voice-typing: append history failed", { error: String(error) }),
    );
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
    hideOverlay().catch((error) =>
      log.warn("voice-typing: scheduled hide failed", { error: String(error) }),
    );
  }, HIDE_DELAY_MS);
}

// ── Learn from an in-place correction ───────────────────────────────────────
//
// We pasted; the user fixed a word we got wrong; Rust — watching only that one
// field, only for a minute — reports the settled value. The diff is computed
// here, offered once in the overlay, and forgotten unless the user says yes.

/**
 * Ask Rust to watch the field we just pasted into, and take AT MOST ONE
 * candidate from it. `sessionGen` pins the dictation this observation belongs
 * to: a new one starting while the setup is in flight makes this stale.
 */
async function observePastedField(text: string, sessionGen: number): Promise<void> {
  stopObserving();
  let started = false;
  try {
    started = await invoke<boolean>("observe_pasted_field", { insertedText: text });
  } catch (e) {
    log.warn("voice-typing: observe_pasted_field failed", { error: String(e) });
    return;
  }
  if (!started || gen !== sessionGen) return;
  const un = await listen<CorrectionCandidatePayload>(CORRECTION_CANDIDATE_EVENT, (e) => {
    stopObserving(); // one candidate per observation, then we're done listening
    onCorrectionCandidate(e.payload).catch((error) =>
      log.warn("voice-typing: correction candidate failed", { error: String(error) }),
    );
  });
  // listen() resolves asynchronously — a dictation that started meanwhile owns
  // the overlay now, so drop this subscription instead of leaking it.
  if (gen !== sessionGen) un();
  else correctionUnlisten = un;
}

function stopObserving(): void {
  correctionUnlisten?.();
  correctionUnlisten = null;
}

async function onCorrectionCandidate(p: CorrectionCandidatePayload): Promise<void> {
  // The ignore counter (and the write that may follow) only mean something once
  // this window has read the dictionary file.
  await whenDictionaryReady();
  const hit = detectCorrection(p.baseline, p.current, p.insertedText);
  if (!hit) return;
  // Declined twice already — the answer isn't going to change.
  if (isIgnoredTwice(hit.from, hit.to)) return;
  log.info("voice-typing: correction candidate", { chars: hit.from.length });
  await showSuggestion(hit);
}

/** Bring the overlay back with the question bubble, and give the user 8 s. */
async function showSuggestion(hit: { from: string; to: string }): Promise<void> {
  cancelSuggestion();
  // A candidate can settle before the last dictation's overlay has been ordered
  // out — that pending hide would take the question down with it.
  clearTimeout(hideTimer);
  suggestion = hit;
  lastAdd = null;
  suggestActionUnlisten = await listen<SuggestActionPayload>(SUGGEST_ACTION_EVENT, (e) =>
    onSuggestAction(e.payload.action),
  );
  await showOverlay();
  await emit(SUGGEST_EVENT, hit);
  await register(SUGGEST_SHORTCUT, (event) => {
    if (event.state === "Pressed") onSuggestAction("add");
  })
    .then(() => {
      suggestShortcutOn = true;
    })
    .catch((error) =>
      // Another app owns ⌥↩ — the buttons still work.
      log.warn("voice-typing: suggest shortcut register failed", { error: String(error) }),
    );
  suggestTimer = setTimeout(() => {
    // Silence is not an answer: hide, but never count it as an ignore.
    hideSuggestion().catch((error) =>
      log.warn("voice-typing: suggest timeout hide failed", { error: String(error) }),
    );
  }, SUGGEST_TIMEOUT_MS);
}

function onSuggestAction(action: SuggestActionPayload["action"]): void {
  if (action === "add") {
    acceptSuggestion();
    return;
  }
  if (action === "ignore" && suggestion) {
    // Only an explicit dismissal counts — twice and we stop offering this pair.
    recordIgnore(suggestion.from, suggestion.to);
  }
  if (action === "undo" && lastAdd) {
    if (lastAdd.kind === "entry") removeEntry(lastAdd.entryId);
    else removeVariant(lastAdd.entryId, lastAdd.variant);
    lastAdd = null;
  }
  hideSuggestion().catch((error) =>
    log.warn("voice-typing: suggest hide failed", { action, error: String(error) }),
  );
}

/** Write the correction, then hold the confirmation (with undo) for a beat. */
function acceptSuggestion(): void {
  if (!suggestion) return;
  const { from, to } = suggestion;
  suggestion = null;
  lastAdd = addEntry({ phrase: to, variants: [from], source: "correction" });
  clearTimeout(suggestTimer);
  // ⌥↩ has done its job; the undo is a click.
  void unregisterSuggestShortcut();
  emit(SUGGEST_STATE_EVENT, { state: "added" }).catch((error) =>
    log.warn("voice-typing: suggest added emit failed", { error: String(error) }),
  );
  suggestTimer = setTimeout(() => {
    hideSuggestion().catch((error) =>
      log.warn("voice-typing: suggest dwell hide failed", { error: String(error) }),
    );
  }, SUGGEST_ADDED_MS);
}

/** Take the bubble away and put the overlay back to sleep. */
async function hideSuggestion(): Promise<void> {
  cancelSuggestion();
  await emit(SUGGEST_STATE_EVENT, { state: "hidden" }).catch((error) =>
    log.warn("voice-typing: suggest hidden emit failed", { error: String(error) }),
  );
  await hideOverlay();
}

/** Drop every side effect the bubble owns — timers, the global shortcut, the
 *  action listener — without touching the overlay window itself. */
function cancelSuggestion(): void {
  clearTimeout(suggestTimer);
  suggestTimer = undefined;
  suggestion = null;
  lastAdd = null;
  suggestActionUnlisten?.();
  suggestActionUnlisten = null;
  void unregisterSuggestShortcut();
}

async function unregisterSuggestShortcut(): Promise<void> {
  if (!suggestShortcutOn) return;
  suggestShortcutOn = false;
  await unregister(SUGGEST_SHORTCUT).catch((error) =>
    log.warn("voice-typing: suggest shortcut unregister failed", { error: String(error) }),
  );
}
