//! Voice-typing host: runs in the main window. Listens for the global
//! push-to-talk events from Rust, drives the streaming session + overlay, and
//! once the recognizer has answered the release, copies the result to the
//! clipboard and pastes it into the frontmost app.
//!
//! The host keeps its own transcript of each session: it folds the same
//! `transcript://segment` events the overlay renders through the same pipeline
//! (Simplified→Traditional, the dictionary, pause-made full stops), so the text
//! it delivers never waits on another window. It used to paste whatever the
//! overlay had last reported over an IPC hop — a hop that could lag the final
//! tokens, or never come from a suspended overlay. The overlay is told what was
//! delivered on `done` and ends on exactly that.

import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isMac } from "../platform";
import { TRAY_VOICE_TOGGLE_EVENT } from "../tray";
import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { sttApiKey, sttRelayUrl } from "../transcription/providers";
import { languageHintsFromSettings } from "../transcription/languageHints";
import { HOSTED_VOICE_TYPING_MAX_SECONDS } from "../limits";
import { log } from "../log";
import { normalizeTranscriptText } from "../textNormalize";
import { preloadZhConverter } from "../zhConvert";
import { showOverlay, hideOverlay, prewarmOverlay, doneMessage } from "./overlay";
import { SessionOwner, SessionTranscript, type Segment, type SessionEvent } from "./transcript";
import { settleVerdict, type SettleReason } from "./settle";
import { appendVoiceEntry } from "./history";
import { canPolish, polishTranscriptOutcome, shouldPolish, type PolishOutcome } from "./polish";
import {
  addEntry,
  applyReplacements,
  isIgnoredTwice,
  profileTerms,
  recognitionTerms,
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

/** Parley's own bundle id. A paste that lands here went nowhere the user was
 *  typing: Parley was frontmost (a click on one of its windows), so the text is
 *  on the clipboard and the overlay should say to paste it by hand. */
const PARLEY_BUNDLE_ID = "com.pathors.parley";

// After the key is released the session stays open until the recognizer has
// answered the closing finalize — `stt://closed` — with a bounded fallback for
// a close that never comes. settle.ts holds the policy and its reasoning.

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

/** The current session's transcript: a fresh instance per press, so a delivery
 *  still reading the previous one is never reset under it. */
let transcript = new SessionTranscript();
/** When the current dictation's key went down / came up (0 = not yet). */
let pressedAt = 0;
let releasedAt = 0;
/** When `stt://closed` arrived for the current session (0 = not yet). */
let closedAt = 0;
/** When the current session's last segment arrived (0 = none yet), and how
 *  many it has sent — the settle rule and the "ended empty" log need both. */
let lastSegmentAt = 0;
let segmentCount = 0;
/** Deliveries (polish → copy → paste → history) run one at a time, in the
 *  order their dictations ended. A re-press hands the previous dictation over
 *  without waiting for it, so a polish round trip can still be in flight when
 *  the next one settles — and two pastes must land in the order spoken. */
let deliveryChain: Promise<void> = Promise.resolve();
let down = false;
let busy = false;
/** The backend reported the STT session dead (voicetyping://error). */
let failed = false;
/** Which backend session the events we act on must come from. */
const owner = new SessionOwner();
/** Session generation. A delivery that was still awaiting its copy/paste when
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
  // Runs on macOS AND Windows. The whole dictation path — global shortcut,
  // overlay, STT, polish, clipboard, synthetic paste — is wired on both.
  //
  // The hold-a-modifier trigger differs by keyboard: macOS holds fn / right
  // ⌥⌘⌃ through an HID event tap, Windows holds right Ctrl / right Alt through
  // a low-level keyboard hook (no fn or ⌘ there). Both emit the same
  // `voicetyping://ptt` as a recorded combo, so nothing below can tell them
  // apart.
  //
  // The correction-learning loop below (observe the field we pasted into, diff
  // it, offer to remember the fix) runs on both: Rust reads the field through
  // the Accessibility API on macOS and UI Automation on Windows, and emits the
  // same event. A field that can't be read (Accessibility not granted, or a
  // Windows app exposing neither ValuePattern nor TextPattern) just means no
  // bubble for that dictation.
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
  // The Windows tray's "Start/Stop voice typing" item (see src-tauri/src/tray.rs).
  // Queued on the same chain as the hotkey, and served by the same session
  // start/end code — only the trigger differs.
  track(
    listen(TRAY_VOICE_TOGGLE_EVENT, () => {
      pttChain = pttChain
        .then(onTrayToggle)
        .catch((error) =>
          log.error("voice-typing: tray toggle failed", { error: String(error) }),
        );
    }),
  );
  // The host's own copy of the transcript (see the header). Only while the
  // dictation is open: once it settles, the instance its delivery reads is
  // final, and a straggler must not change the text being pasted.
  track(
    listen<Segment>("transcript://segment", (e) => {
      if (!busy || !owner.owns(e.payload)) return;
      if (!transcript.accept(e.payload)) return;
      lastSegmentAt = Date.now();
      segmentCount += 1;
      if (releasedAt > 0) waitForSettle();
    }),
  );
  track(
    listen<SessionEvent>("voicetyping://session", (e) => {
      if (e.payload.phase !== "start") return;
      owner.start(e.payload.session);
      transcript = new SessionTranscript();
      transcript.reset(e.payload.session);
    }),
  );
  // Backend STT failure (rejected key, expired hosted session, out of
  // credits). The host owns the session lifecycle, so it bridges the event
  // into the overlay's one error surface (`voicetyping://session`) — the code
  // picks the overlay message (quota/auth/…). Without this, a dead session
  // looks like successful silence: frozen waveform, no transcript, no
  // explanation. The mic stays claimed until release; endSession still stops
  // it, and the delivery still pastes whatever text arrived before the death.
  track(
    listen<{ code: string; session: number | null }>("voicetyping://error", (e) => {
      if (!busy || !owner.owns(e.payload)) return;
      failed = true;
      log.warn("voice-typing: session failed", { code: e.payload.code });
      emit("voicetyping://session", { phase: "error", message: e.payload.code }).catch((error) =>
        log.warn("voice-typing: error event emit failed", { error: String(error) }),
      );
      if (releasedAt > 0) waitForSettle();
    }),
  );
  // The backend session is over: the recognizer answered the closing finalize
  // (or the socket closed, or the drain grace ran out), and every segment it
  // produced was emitted BEFORE this — one task emits both, and each webview
  // receives events in order — so the transcript is complete and the settle
  // rule delivers at once. A close before the release is remembered too: a
  // dead connection comes with an error first (`failed`), and a stream that
  // really ended mid-hold (a meeting tapped for its mic stopped) has nothing
  // more to say at the release. A previous session's close after a fast
  // re-press carries that session's id and `owner` drops it.
  track(
    listen<{ source: string; session: number | null }>("stt://closed", (e) => {
      if (!busy || !owner.owns(e.payload)) return;
      closedAt = Date.now();
      if (releasedAt > 0) waitForSettle();
    }),
  );
  // Apply the saved push-to-talk key so the right trigger is live from launch
  // (registers the combo, or arms the HID tap / keyboard hook for a modifier
  // key). The
  // Settings panel re-applies it whenever the user changes the selection.
  invoke("set_voice_typing_shortcut", {
    shortcut: useStore.getState().settings.voiceTypingShortcut,
  }).catch((error) =>
    log.warn("voice-typing: startup shortcut apply failed", { error: String(error) }),
  );
  // Voice typing always auto-pastes on release, which on macOS needs
  // Accessibility — while the feature is enabled (it defaults on), ask for that
  // grant on the FIRST launch instead of failing quietly on the first
  // dictation. At most once per install: an untrusted result here does not mean
  // "never asked" — the user may have declined, or the grant went stale because
  // the TCC identity changed (every dev rebuild, a moved or re-signed app) —
  // and re-prompting on every launch nags exactly those users forever. Later
  // launches only log; Settings keeps the explicit re-grant paths (the enable
  // toggle and the grant button), and auto-paste degrades to clipboard-only
  // meanwhile.
  //
  // Explicitly macOS-only rather than relying on `accessibility_status`
  // answering true on Windows: there is no Windows permission to ask for, so
  // running this block there would be a request that can neither fail nor
  // succeed — and a reader would have to know the Rust stub to see that. When
  // a Windows paste IS refused it is UIPI blocking injection into an elevated
  // window, which no prompt can fix; the overlay says so at delivery instead.
  if (isMac() && useStore.getState().settings.voiceTypingEnabled) {
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
  // The host converts S→T itself now (see the header): load OpenCC before the
  // first delivery needs it, not during it.
  preloadZhConverter();
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
    // A tap while the last dictation is still settling lands in endSession
    // and is a no-op there — it was already ended.
    if (busy) {
      down = false; // mirror the hold-mode release (the tray reads `down`)
      await endSession();
    } else {
      down = true; // recording, as in hold mode
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

/**
 * The tray item. A menu click cannot be held, so it toggles whatever the
 * hold/toggle setting says: the first click starts a dictation, the next one
 * ends it (the tray relabels itself to match). `down` mirrors the hotkey paths
 * so the two triggers can be mixed — releasing the hotkey, or tapping it in
 * toggle mode, ends a dictation the tray started.
 */
async function onTrayToggle() {
  if (busy && down) {
    down = false;
    await endSession();
    return;
  }
  down = true;
  await startSession();
  down = busy; // clear if the start didn't actually take
}

async function startSession() {
  const pressed = Date.now();
  // The recognition bias below is read synchronously from the dictionary
  // cache, which is empty until this window's boot read lands — a press in the
  // first moments after launch would otherwise go out without it. Resolved for
  // the rest of the app's life, so this costs a microtask. Ahead of every state
  // change, so nothing here is half-done while it waits.
  await whenDictionaryReady();
  // A new dictation supersedes anything still pending from the last one: the
  // overlay is about to be reused for this session, and a stale ⌥↩ must not
  // silently learn a correction the user has moved on from.
  cancelSuggestion();
  if (busy) {
    // A press during the previous dictation's settle window. Swallowing it
    // (the old behavior) left the user talking into nothing — instead settle
    // the pending text now and fall through to a fresh session. Its delivery
    // is queued, not awaited: the mic only opens below, and a polish round
    // trip in front of it would cost the start of the next utterance. The
    // backend start also aborts the old session's task, so the old session
    // cannot leak tokens into the new overlay — and whatever it had not
    // flushed yet is lost, which the log records as reason "restart".
    const d = settleNow("restart");
    if (d) void enqueueDelivery(d);
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
  owner.begin();
  transcript = new SessionTranscript();
  pressedAt = pressed;
  releasedAt = 0;
  closedAt = 0;
  lastSegmentAt = 0;
  segmentCount = 0;
  clearTimeout(settleTimer);
  clearTimeout(hideTimer);
  clearTimeout(capTimer);
  // The hosted "parley" plan caps a single dictation; BYOK is uncapped. Pass
  // the cap to the backend as a safety net (a hung webview can't stream the
  // paid relay forever) and mirror it with a frontend timer that ends the
  // dictation gracefully (delivering the transcript). null = no cap for BYOK.
  const hosted = provider === "parley";
  // MIC FIRST, overlay second. Placing the overlay costs four round-trips to
  // the app's main thread (cursor position → monitor list → setPosition →
  // present), and the capture used to wait behind all of them — so roughly the
  // first second of every dictation was never recorded, and any main-thread
  // work elsewhere in the app stretched that window arbitrarily. The overlay
  // webview is prewarmed and already subscribed, so Rust's `start` event can
  // reset it before its window is on screen and it simply catches up.
  const starting = invoke("start_voice_typing", {
    provider,
    apiKey,
    languageHints: languageHintsFromSettings(settings),
    // Recognition bias: the user's own name and company (Settings › Basic),
    // then the phrase dictionary — the terms they've taught us are exactly the
    // ones the model keeps getting wrong.
    vocabulary: recognitionTerms(settings),
    inputDevice: settings.inputDevice ?? null,
    relayUrl: sttRelayUrl(provider, "voice_typing"),
    maxDurationSecs: hosted ? HOSTED_VOICE_TYPING_MAX_SECONDS : null,
  });
  const shown = showOverlay().catch((error) =>
    log.warn("voice-typing: overlay show failed", { error: String(error) }),
  );
  try {
    await starting;
    log.info("voice-typing: session started", { provider, startMs: Date.now() - pressed });
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
  // Once per dictation: a toggle-mode tap while it settles must not restart
  // the wait (or cut a second time).
  if (!busy || releasedAt > 0) return;
  const myGen = gen;
  clearTimeout(capTimer);
  releasedAt = Date.now();
  log.info("voice-typing: released", { heldMs: releasedAt - pressedAt });
  // Rust keeps a short tail of audio, then cuts the capture, which tells the
  // STT adapter to finalize; the final tokens arrive over the next moments.
  await stopCapture({ tail: true });
  // The close (or a failure) may have settled it while the stop was in flight.
  if (!busy || gen !== myGen) return;
  // A failed session already shows its error, and a closed one is about to
  // be delivered: neither gets the "finalizing" spinner.
  if (!failed && closedAt === 0) await emit("voicetyping://session", { phase: "stop" });
  waitForSettle();
}

/** The hosted single-dictation cap elapsed while the key was still held. Treat
 *  it as a release: stop the backend session at once (no release tail — the
 *  limit is the limit), mark the key up so the real key-up is a no-op, tell
 *  the overlay the limit ended it, then settle as usual (the transcript
 *  captured so far is still copied/pasted). */
async function onCapReached() {
  if (!busy || releasedAt > 0) return;
  const myGen = gen;
  clearTimeout(capTimer);
  log.info("voice-typing: hosted single-session cap reached; finalizing");
  down = false;
  releasedAt = Date.now();
  await stopCapture({ tail: false });
  if (!busy || gen !== myGen) return;
  if (!failed) {
    await emit("voicetyping://session", { phase: "limit" }).catch((error) =>
      log.warn("voice-typing: limit event emit failed", { error: String(error) }),
    );
  }
  waitForSettle();
}

/**
 * Cut the backend session's audio: after Rust's short release tail
 * (`tail: true`, a key-up), or at once (`tail: false`). Only the capture ends
 * here — the session task keeps running to deliver the recognizer's final
 * answer, `owner` keeps accepting it, and `stt://closed` settles the
 * dictation. Resolves as soon as Rust has scheduled the cut.
 */
async function stopCapture(opts: { tail: boolean }): Promise<void> {
  try {
    await invoke("stop_voice_typing", { tail: opts.tail });
  } catch (e) {
    log.warn("voice-typing: stop failed", { tail: opts.tail, error: String(e) });
  }
}

/**
 * Ask settle.ts whether the released dictation is done, and either deliver it
 * or check again when its verdict says to. Called on the release and on every
 * event that can change the answer (a segment, the close, an error), so the
 * only timer is the one fallback deadline — never a polling chain, which a
 * hidden main window (macOS hides it on close, Windows to the tray) throttles.
 */
function waitForSettle() {
  clearTimeout(settleTimer);
  if (!busy || releasedAt === 0) return;
  const v = settleVerdict({
    now: Date.now(),
    releasedAt,
    closedAt,
    failed,
    lastSegmentAt,
    tailPending: transcript.hasPendingTail(),
  });
  if ("finalize" in v) {
    const d = settleNow(v.finalize);
    if (d) void enqueueDelivery(d);
    return;
  }
  settleTimer = setTimeout(waitForSettle, v.waitMs);
}

/** One settled dictation, handed from the session (which may already be
 *  running the next one) to delivery. Captured in one synchronous step, so
 *  nothing in it changes while the delivery awaits. */
interface Delivery {
  reason: SettleReason | "restart";
  /** Its session generation: a newer one owns the overlay. */
  myGen: number;
  /** Its own transcript instance; the next press makes a fresh one. */
  t: SessionTranscript;
  /** Release → settle, for the log (null if it was never released). */
  waitMs: number | null;
  closed: boolean;
  segments: number;
}

/**
 * End the open dictation and hand it over for delivery. Synchronous, so the
 * next press can start right behind it, and idempotent: whichever of the
 * close, the settle timer or a re-press gets here first owns the delivery,
 * and everything after it finds `busy` false.
 */
function settleNow(reason: Delivery["reason"]): Delivery | null {
  if (!busy) return null;
  const d: Delivery = {
    reason,
    myGen: gen,
    t: transcript,
    waitMs: releasedAt > 0 ? Date.now() - releasedAt : null,
    closed: closedAt > 0,
    segments: segmentCount,
  };
  busy = false;
  clearTimeout(settleTimer);
  clearTimeout(capTimer);
  return d;
}

/** Queue `d` behind every earlier delivery (see `deliveryChain`). */
function enqueueDelivery(d: Delivery): Promise<void> {
  deliveryChain = deliveryChain
    .then(() => deliver(d))
    .catch((error) =>
      log.error("voice-typing: delivery failed", { reason: d.reason, error: String(error) }),
    );
  return deliveryChain;
}

/**
 * The clean-up pass, run between the transcript settling and the clipboard.
 *
 * This is the last moment the text is still ours: ⌘V into somebody else's app
 * is one-way — no undo, no re-selection — so polishing after the paste would
 * mean typing over a window we do not own. Total by construction: `text` is
 * the text to paste, which is the polished version when everything went right
 * and the raw transcript in every other case, so `deliver` has nothing to
 * handle. `outcome` says which, for the overlay's note. `signal` abandons the
 * round trip (resolving to `"cancelled"` with the raw text). See `polish.ts`.
 */
async function polishForPaste(
  raw: string,
  myGen: number,
  signal?: AbortSignal,
): Promise<{ text: string; outcome: PolishOutcome }> {
  const settings = useStore.getState().settings;
  // Checked here as well as in polish.ts so the overlay is never told
  // "polishing" for a pass that is not going to run.
  if (!canPolish(settings)) return { text: raw, outcome: "off" };
  if (!shouldPolish(raw)) return { text: raw, outcome: "tooShort" };
  // Only claim the overlay while it is still ours to claim; a press during the
  // round trip owns it from here (the gen check in `deliver` is the same guard
  // for the "done" tail).
  if (gen === myGen) await emit("voicetyping://session", { phase: "polishing" });
  const { text, outcome } = await polishTranscriptOutcome({
    raw,
    settings,
    protectedTerms: vocabularyTerms(),
    speakerTerms: profileTerms(settings),
    signal,
  });
  // The raw text already went through the dictionary (normalizeTranscriptText
  // in the transcript's report); the polished text never did, and a model can
  // turn a dictionary term back into a misheard variant that the prompt's
  // "preserve" line does not catch. Run the same deterministic pass over it
  // (idempotent, so a term that is already right stays right). Unpolished text
  // goes out exactly as the overlay showed it.
  return { text: text === null ? raw : applyReplacements(text), outcome };
}

/** Polish, copy, paste and record one settled dictation, then tell the
 *  overlay what was delivered. Runs on `deliveryChain`, one at a time. */
async function deliver(d: Delivery): Promise<void> {
  // Settled dictations only exist after a press, which already waited for
  // this — but the report below reads the dictionary cache, so say so here.
  await whenDictionaryReady();
  const raw = ((await d.t.report(normalizeTranscriptText))?.text ?? "").trim();
  // Never the text itself (user data): how and when it settled, and how much.
  const timing = { reason: d.reason, waitMs: d.waitMs, closed: d.closed };
  if (raw) {
    log.info("voice-typing: settled", { ...timing, chars: raw.length });
  } else {
    log.warn("voice-typing: dictation ended empty", { ...timing, segments: d.segments });
  }
  let text = raw;
  /** Did the synthetic paste actually land? Stays true when the copy/paste
   *  round trip threw, because then we don't know what reached the clipboard
   *  and must not tell the user to paste something that isn't there. */
  let pasted = true;
  let outcome: PolishOutcome = "off";
  if (raw) {
    ({ text, outcome } = await polishForPaste(raw, d.myGen));
    let appBundleId: string | null = null;
    try {
      await invoke("copy_to_clipboard", { text });
      // Auto-paste is the default behaviour (no setting): simulate ⌘V into the
      // frontmost app; without Accessibility it degrades to clipboard-only.
      const paste = await invoke<{ pasted: boolean; appBundleId: string | null }>(
        "paste_to_frontmost",
      );
      appBundleId = paste.appBundleId;
      pasted = paste.pasted;
      // Two different refusals, one outcome: on macOS the Accessibility grant
      // is missing or stale; on Windows UIPI blocks injection into a window
      // running at a higher integrity level (anything launched as
      // administrator). Neither is recoverable from here and both leave the
      // text on the clipboard, so the overlay stops claiming the paste
      // happened and names the manual key instead.
      if (!paste.pasted) {
        log.warn("voice-typing: auto-paste refused; text left on the clipboard", { appBundleId });
      } else if (appBundleId === PARLEY_BUNDLE_ID) {
        // Posted, but into Parley itself — frontmost because one of its own
        // windows took the click — usually with no text field focused, so
        // the text landed nowhere. It is on the clipboard: say so, and do not
        // watch a field the user was not typing in.
        log.warn("voice-typing: paste went to Parley itself; reporting clipboard-only");
        pasted = false;
      }
      log.info("voice-typing: copied", { chars: text.length, pasted, appBundleId });
      // Only a text that actually landed somewhere can be corrected in place.
      if (pasted) {
        observePastedField(text, d.myGen).catch((error) =>
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
  // A new press may have started a session while the delivery above was in
  // flight — its overlay is live, and this delivery's tail must not flip it
  // to "done" or hide it. The text above was still delivered (it predates the
  // new session).
  if (gen !== d.myGen) return;
  await emit("voicetyping://session", {
    phase: "done",
    message: doneMessage({ text, pasted, outcome }),
    text,
  });
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

/** The observation the current dictation owns. `rearmsLeft` lets a rejected
 *  candidate re-arm with a fresh baseline — a target app that transforms the
 *  paste (smart quotes, autocapitalize) or an unrelated multi-word edit would
 *  otherwise spend the single Rust event and go deaf to the real correction. */
let observation: { insertedText: string; sessionGen: number; rearmsLeft: number } | null = null;

/**
 * Ask Rust to watch the field we just pasted into. Each armed observation
 * reports AT MOST ONE candidate; `sessionGen` pins the dictation it belongs
 * to: a new one starting while the setup is in flight makes this stale.
 */
async function observePastedField(text: string, sessionGen: number): Promise<void> {
  // 3 re-arms, not fewer: in Chromium-family fields the paste itself lands as
  // a replace (never matching Rust's splice check), so the first candidate of
  // EVERY dictation is a rejected paste-landing that costs one re-arm.
  observation = { insertedText: text, sessionGen, rearmsLeft: 3 };
  await armObservation();
}

async function armObservation(): Promise<void> {
  stopObserving();
  if (!observation || gen !== observation.sessionGen) return;
  let started = false;
  try {
    started = await invoke<boolean>("observe_pasted_field", {
      insertedText: observation.insertedText,
    });
  } catch (e) {
    log.warn("voice-typing: observe_pasted_field failed", { error: String(e) });
    return;
  }
  if (!started) {
    // Rust already logged why (no AX trust, no foreground app, UI Automation
    // unavailable). Note it here too so the TS log tells the whole story.
    log.info("voice-typing: field observation not armed");
    return;
  }
  if (gen !== observation.sessionGen) return;
  const un = await listen<CorrectionCandidatePayload>(CORRECTION_CANDIDATE_EVENT, (e) => {
    stopObserving(); // one candidate per observation, then we're done listening
    onCorrectionCandidate(e.payload).catch((error) =>
      log.warn("voice-typing: correction candidate failed", { error: String(error) }),
    );
  });
  // listen() resolves asynchronously — a dictation that started meanwhile owns
  // the overlay now, so drop this subscription instead of leaking it.
  if (observation && gen === observation.sessionGen) correctionUnlisten = un;
  else un();
}

function stopObserving(): void {
  correctionUnlisten?.();
  correctionUnlisten = null;
}

async function onCorrectionCandidate(p: CorrectionCandidatePayload): Promise<void> {
  // A candidate from a dictation the user has already moved past must not
  // hijack the overlay — it may be showing the NEXT dictation's live text
  // right now. Rust's generation guard covers most of this, but a candidate
  // emitted just before the next paste can still arrive after startSession.
  if (!observation || gen !== observation.sessionGen) {
    log.info("voice-typing: correction candidate dropped (stale dictation)");
    return;
  }
  // The ignore counter (and the write that may follow) only mean something once
  // this window has read the dictionary file.
  await whenDictionaryReady();
  // Anchored to the user's known terms, so a one-character fix inside a name
  // is learned as the whole name (see detectCorrection).
  const hit = detectCorrection(
    p.baseline,
    p.current,
    p.insertedText,
    recognitionTerms(useStore.getState().settings),
  );
  if (!hit) {
    log.info("voice-typing: correction candidate rejected by diff", {
      baselineChars: p.baseline.length,
      currentChars: p.current.length,
      insertedChars: p.insertedText.length,
    });
    // Watch again from the field's CURRENT state — the change we just rejected
    // becomes part of the new baseline, so a real one-word fix can still land.
    if (observation && gen === observation.sessionGen && observation.rearmsLeft > 0) {
      observation.rearmsLeft -= 1;
      await armObservation();
    }
    return;
  }
  // Declined twice already — the answer isn't going to change.
  if (isIgnoredTwice(hit.from, hit.to)) {
    log.info("voice-typing: correction candidate suppressed (ignored twice)");
    return;
  }
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
