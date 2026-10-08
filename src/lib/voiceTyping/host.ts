//! Voice-typing host: runs in the main window. Listens for the global
//! push-to-talk events from Rust, drives the streaming session + overlay, and
//! once the recognizer has answered the release, has the result typed into the
//! frontmost app's focused field. Rust does that through the clipboard and
//! gives the clipboard back a moment later (`insert_text`, see
//! src-tauri/src/voice_typing/clipboard.rs), so a dictation never costs the
//! user what they had copied.
//!
//! The host keeps its own transcript of each session: it folds the same
//! `transcript://segment` events the overlay renders through the same pipeline
//! (Simplified→Traditional, the dictionary, pause-made full stops), so the text
//! it delivers never waits on another window. It used to paste whatever the
//! overlay had last reported over an IPC hop — a hop that could lag the final
//! tokens, or never come from a suspended overlay. The overlay is told what was
//! delivered on `done` and ends on exactly that.
//!
//! Esc cancels the dictation on screen until its text is sent to the field:
//! the mic stops as on a release, the text still settles, and the host holds
//! it instead of delivering it, for an Undo that copies it to the clipboard.
//! The rules are in cancel.ts; the orderings are here.

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
import {
  DONE_ACTION_EVENT,
  showOverlay,
  hideOverlay,
  prewarmOverlay,
  doneMessage,
  recoveredMessage,
  type DoneActionPayload,
} from "./overlay";
import { SessionOwner, SessionTranscript, type Segment, type SessionEvent } from "./transcript";
import { settleVerdict, type SettleReason } from "./settle";
import { appendVoiceEntry, type PolishedStyle } from "./history";
import {
  canPolish,
  polishSkipReason,
  polishTranscriptOutcome,
  type PolishOutcome,
} from "./polish";
import {
  CANCEL_ACTION_EVENT,
  CANCEL_EVENT,
  CANCEL_UNDO_MS,
  CancelLedger,
  type CancelActionPayload,
  type CancelPayload,
} from "./cancel";
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

// After the key is released the session stays open until the recognizer has
// answered the closing finalize — `stt://closed` — with a bounded fallback for
// a close that never comes. settle.ts holds the policy and its reasoning.

/** Keep the closing confirmation ("Inserted", or what to do instead) floating
 *  a beat so the user clearly registers it before the overlay fades out. The
 *  overlay animates its own fade in the final stretch (see VoiceTypingApp's
 *  fade timing) — this sits comfortably AFTER that fade completes (dwell +
 *  fade ≈ 2600ms, plus event/IPC latency before the overlay's clock even
 *  starts) so the native hide always lands on an already-invisible window. */
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
/** When the current session's socket opened (`stt://connected`, 0 = not yet),
 *  and whether its provider answers the closing finalize (settle.ts). */
let connectedAt = 0;
let acksFinalize = false;
/** When the current session's last segment arrived (0 = none yet), and how
 *  many it has sent — the settle rule and the "ended empty" log need both. */
let lastSegmentAt = 0;
let segmentCount = 0;
/** Deliveries (polish → insert → history) run one at a time, in the
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
/** Session generation. A delivery that was still awaiting its insert when
 *  a NEW session started must not run its tail (emit "done" + schedule hide)
 *  against the new session's overlay. */
let gen = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** Hosted-only: fires HOSTED_VOICE_TYPING_MAX_SECONDS after a "parley" session
 *  starts to auto-finalize it (the free plan caps a single dictation). Cleared
 *  whenever the session ends by any other path. */
let capTimer: ReturnType<typeof setTimeout> | undefined;
/** Serialize press/release handling: a quick tap used to run endSession's
 *  `stop_voice_typing` while startSession's invoke was still in flight, so
 *  the stop reached Rust FIRST and no-op'd — leaving a live, ownerless
 *  backend session (mic claimed, socket open) behind. Chaining guarantees
 *  start has resolved before its matching stop is issued. Esc's cancel runs
 *  on it too, so it lands between a press and its release, never inside. */
let pttChain: Promise<void> = Promise.resolve();

// ── Esc cancels, Undo copies (see cancel.ts) ────────────────────────────────
/** The generation Esc cancels right now; null when nothing is cancellable.
 *  Bound to a generation rather than a flag: dictation N can still be
 *  polishing while N+1 records, and N reaching its field must not disarm
 *  Esc for N+1 — nor may an Esc meant for N touch N+1's key state. */
let cancellable: number | null = null;
/** The mic is open for `gen` (from the start until a release, the cap or an
 *  Esc cuts it). An Esc cuts it like a release, whatever else has happened —
 *  a server close can settle the dictation while the mic is still open. */
let capturing = false;
const cancels = new CancelLedger();
/** Closes the Undo offer CANCEL_UNDO_MS after the Esc. */
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
/** The polish round trip in flight, so an Esc can abandon it. */
let polishing: { gen: number; ctl: AbortController } | null = null;

/** What the last delivery sent to the field, for the Copy on its confirmation
 *  (see onCopyAction). Tagged with its generation: a click that arrives after
 *  the next press is about a dictation the user has moved on from. */
let lastInserted: { gen: number; text: string } | null = null;

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
  // A fresh host has nothing to cancel, but Rust keeps the Esc arming across
  // a page that started over without running the old cleanup: macOS reloads
  // a terminated WebContent process, lib.rs rebuilds a destroyed main window,
  // a dev full reload. The shortcut call below would even register Esc again
  // for a dictation this host knows nothing about, and every Esc in every app
  // would be swallowed until the next dictation's delivery. Hand it back now;
  // the order against that call does not matter (either way the last word is
  // "disarmed"), and Rust ignores the repeat on a normal launch.
  armCancel(false);
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
  track(
    listen<{ down: boolean }>("voicetyping://ptt", (e) => {
      const isDown = e.payload.down;
      onPttChain("push-to-talk handler", () => onPtt(isDown), { isDown });
    }),
  );
  // The Windows tray's "Start/Stop voice typing" item (see src-tauri/src/tray.rs).
  // Queued on the same chain as the hotkey, and served by the same session
  // start/end code — only the trigger differs.
  track(listen(TRAY_VOICE_TOGGLE_EVENT, () => onPttChain("tray toggle", onTrayToggle)));
  // Esc while a dictation is cancellable. Rust only holds the Esc shortcut
  // while the host arms it (see armCancel), so an Esc at any other time still
  // reaches the app in front.
  track(
    listen<CancelPayload>(CANCEL_EVENT, (e) => onEscape(e.payload?.fromTrigger === true)),
  );
  // The overlay's Undo.
  track(
    listen<CancelActionPayload>(CANCEL_ACTION_EVENT, (e) => {
      if (e.payload.action !== "undo") return;
      onUndoCancel().catch((error) =>
        log.error("voice-typing: cancel undo failed", { error: String(error) }),
      );
    }),
  );
  // The Copy on an inserted dictation's confirmation.
  track(
    listen<DoneActionPayload>(DONE_ACTION_EVENT, (e) => {
      if (e.payload.action !== "copy") return;
      onCopyAction().catch((error) =>
        log.error("voice-typing: copy action failed", { error: String(error) }),
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
      // A cancelled dictation keeps its Undo on screen: the failure only means
      // the text it holds is final.
      if (!cancels.isCancelled(gen)) {
        emit("voicetyping://session", { phase: "error", message: e.payload.code }).catch(
          (error) => log.warn("voice-typing: error event emit failed", { error: String(error) }),
        );
      }
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
  // The socket is open: the audio buffered since the press is on its way, so
  // the wait for the final answer can start counting (settle.ts). A short tap
  // is often released before this — the hosted relay takes seconds to accept.
  track(
    listen<{ source: string; session: number | null; acksFinalize?: boolean }>(
      "stt://connected",
      (e) => {
        if (!busy || !owner.owns(e.payload)) return;
        connectedAt = Date.now();
        acksFinalize = e.payload.acksFinalize === true;
        if (releasedAt > 0) waitForSettle();
      },
    ),
  );
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
    clearTimeout(cancelTimer);
    armCancel(false);
    cancelSuggestion();
    stopObserving();
    unsubs.forEach((u) => u());
  };
}

/** Run `task` behind every press, release and cancel queued before it (see
 *  `pttChain`); `what` and `ctx` name it in the log if it throws. */
function onPttChain(
  what: string,
  task: () => Promise<void>,
  ctx: Record<string, unknown> = {},
): void {
  pttChain = pttChain
    .then(task)
    .catch((error) => log.error(`voice-typing: ${what} failed`, { ...ctx, error: String(error) }));
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
    // Stop only a dictation that is still recording, as the tray does. A tap
    // while the last one settles (the recognizer's final answer takes 1–3 s,
    // up to the 6 s cap) starts the next dictation, as a re-press does in
    // hold mode: startSession delivers the settling one with reason
    // "restart", or holds it for its Undo when Esc cancelled it. Swallowing
    // that tap left the user talking into nothing, and their next tap, meant
    // as a stop, started a recording.
    //
    // `down`, not the cancel ledger: `down` only changes on this chain, while
    // an Esc marks the ledger the moment it arrives. A stop tap queued behind
    // a slow mic open, with the Esc after it, must still be a stop (endSession
    // leaves the cut to the cancel queued behind it), not a fresh dictation
    // that throws the cancelled one away.
    if (busy && down) {
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
  // A new dictation replaces a cancelled one still offering Undo (its text is
  // dropped; one whose Undo was already clicked is still recovered).
  dropCancel();
  busy = true;
  failed = false;
  gen += 1;
  cancellable = gen;
  capturing = false;
  owner.begin();
  transcript = new SessionTranscript();
  pressedAt = pressed;
  releasedAt = 0;
  closedAt = 0;
  connectedAt = 0;
  acksFinalize = false;
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
  // Esc cancels from here on — claimed right behind the mic, never before it.
  armCancel(true);
  const shown = showOverlay().catch((error) =>
    log.warn("voice-typing: overlay show failed", { error: String(error) }),
  );
  try {
    await starting;
    // Even when an Esc already landed: its cancel is queued behind this, and
    // cuts the capture once this returns.
    capturing = true;
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
    // No dictation, nothing to cancel: an Esc already pressed for it must not
    // cover the error below with an Undo (applyCancel finds it forgotten).
    cancellable = null;
    cancels.forget(gen);
    armCancel(false);
    // The overlay is this failure's only surface, so let it finish coming up
    // before the error is announced — it raced the start, and a message sent
    // to a window that never appeared is a silent dead session.
    await shown;
    await emit("voicetyping://session", { phase: "error", message: String(e) });
    scheduleHide();
  }
}

async function endSession() {
  // Once per dictation: every trigger clears `down` when it ends one, so a
  // second end should not get here, but if one does it must not restart the
  // wait (or cut a second time). A cancelled one is applyCancel's to cut,
  // with no tail and no "finalizing" spinner over its Undo.
  if (!busy || releasedAt > 0 || cancels.isCancelled(gen)) return;
  const myGen = gen;
  clearTimeout(capTimer);
  releasedAt = Date.now();
  log.info("voice-typing: released", { heldMs: releasedAt - pressedAt });
  // Rust keeps a short tail of audio, then cuts the capture, which tells the
  // STT adapter to finalize; the final tokens arrive over the next moments.
  await stopCapture({ tail: true });
  // The close (or a failure) may have settled it while the stop was in flight,
  // or an Esc cancelled it (its applyCancel, queued behind this, settles it).
  if (!busy || gen !== myGen || cancels.isCancelled(myGen)) return;
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
  if (!busy || releasedAt > 0 || cancels.isCancelled(gen)) return;
  const myGen = gen;
  clearTimeout(capTimer);
  log.info("voice-typing: hosted single-session cap reached; finalizing");
  down = false;
  releasedAt = Date.now();
  await stopCapture({ tail: false });
  if (!busy || gen !== myGen || cancels.isCancelled(myGen)) return;
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
  capturing = false;
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
    connectedAt,
    acksFinalize,
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
  /** Press → socket open, for the log (null if it never connected). A value
   *  above the hold time means the release beat the connect. */
  connectMs: number | null;
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
    connectMs: connectedAt > 0 ? connectedAt - pressedAt : null,
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
 * The clean-up pass, run between the transcript settling and the insert.
 *
 * This is the last moment the text is still ours: ⌘V into somebody else's app
 * is one-way — no undo, no re-selection — so polishing after the paste would
 * mean typing over a window we do not own. Total by construction: `text` is
 * the text to paste, which is the polished version when everything went right
 * and the raw transcript in every other case, so `deliver` has nothing to
 * handle. `outcome` says which, for the overlay's note. `signal` abandons the
 * round trip (resolving to `"cancelled"` with the raw text). See `polish.ts`.
 * `recovering` is an Undo bringing a cancelled dictation back, which may say
 * "polishing" over the cancelled pill; nothing else may. `gateText` is what the
 * length gate measures: the transcript before its pause-made marks were
 * softened (`TranscriptText.sttText`), so the softening never decides whether
 * a dictation is polished.
 */
async function polishForPaste(
  raw: string,
  myGen: number,
  opts: { signal?: AbortSignal; recovering?: boolean; gateText?: string } = {},
): Promise<{ text: string; outcome: PolishOutcome; polishStyle?: PolishedStyle }> {
  const { signal, recovering = false, gateText = raw } = opts;
  const settings = useStore.getState().settings;
  // Checked here as well as in polish.ts so the overlay is never told
  // "polishing" for a pass that is not going to run.
  if (!canPolish(settings)) return { text: raw, outcome: "off" };
  const skip = polishSkipReason(raw, gateText);
  if (skip) return { text: raw, outcome: skip };
  // Read once, before the round trip: the history records the style that
  // produced the text even if the setting changes while the request is out.
  const style = settings.voiceTypingPolishStyle;
  // Only claim the overlay while it is still ours to claim; a press during the
  // round trip owns it from here (the gen check in `deliver` is the same guard
  // for the "done" tail). A cancelled dictation's overlay is its Undo, which
  // only that Undo bringing it back may replace.
  if (gen === myGen && (recovering || !cancels.isCancelled(myGen))) {
    await emit("voicetyping://session", { phase: "polishing" });
  }
  const { text, outcome } = await polishTranscriptOutcome({
    raw,
    settings,
    protectedTerms: vocabularyTerms(),
    speakerTerms: profileTerms(settings),
    signal,
    gateText,
  });
  // The raw text already went through the dictionary (normalizeTranscriptText
  // in the transcript's report); the polished text never did, and a model can
  // turn a dictionary term back into a misheard variant that the prompt's
  // "preserve" line does not catch. Run the same deterministic pass over it
  // (idempotent, so a term that is already right stays right). Unpolished text
  // goes out exactly as the overlay showed it.
  if (text === null || style === "off") return { text: raw, outcome };
  return { text: applyReplacements(text), outcome, polishStyle: style };
}

/** Polish, insert and record one settled dictation, then tell the overlay
 *  what was delivered. Runs on `deliveryChain`, one at a time. */
async function deliver(d: Delivery): Promise<void> {
  try {
    await deliverSettled(d);
  } finally {
    // However the delivery ended, a throw before the insert included, this
    // dictation can no longer be cancelled: give Esc back to the app in front
    // unless a newer press has claimed it. Without this, a failure between
    // the settle and the insert left Esc swallowed in every app until the
    // next dictation's delivery (Rust also releases it a while after the
    // session ends, for a host that never gets here at all).
    if (cancellable === d.myGen) {
      cancellable = null;
      armCancel(false);
    }
  }
}

async function deliverSettled(d: Delivery): Promise<void> {
  // Settled dictations only exist after a press, which already waited for
  // this — but the report below reads the dictionary cache, so say so here.
  await whenDictionaryReady();
  const report = await d.t.report(normalizeTranscriptText);
  const raw = (report?.text ?? "").trim();
  // The polish length gate measures the text before softening: dropping the
  // space after a full-width mark must not also drop it below
  // MIN_POLISH_CHARS (punctuation.ts).
  const gateText = report?.sttText ?? raw;
  // Never the text itself (user data): how and when it settled, and how much.
  const timing = { reason: d.reason, waitMs: d.waitMs, connectMs: d.connectMs, closed: d.closed };
  if (raw) {
    log.info("voice-typing: settled", { ...timing, chars: raw.length });
  } else {
    log.warn("voice-typing: dictation ended empty", { ...timing, segments: d.segments });
  }
  // Esc came first (while it recorded or settled, or while an earlier
  // delivery held this one up): hold the text for Undo, deliver nothing.
  if (cancels.isCancelled(d.myGen)) return holdCancelled(d.myGen, raw, false, gateText);
  let text = raw;
  /** Did the paste go out? Stays true when the insert threw, because then we
   *  don't know what reached the clipboard and must not tell the user to
   *  paste something that isn't there. */
  let pasted = true;
  let outcome: PolishOutcome = "off";
  /** The style that produced `text`, when it is the polish. */
  let polishStyle: PolishedStyle | undefined;
  if (raw) {
    // Esc during the round trip abandons it (outcome "cancelled", not a
    // failure) — the user is no longer waiting on this text.
    const ctl = new AbortController();
    polishing = { gen: d.myGen, ctl };
    try {
      ({ text, outcome, polishStyle } = await polishForPaste(raw, d.myGen, {
        signal: ctl.signal,
        gateText,
      }));
    } finally {
      if (polishing?.ctl === ctl) polishing = null;
    }
    // A polish that ran to its end (whatever came of it) is not redone on
    // Undo; one the Esc abandoned is.
    if (cancels.isCancelled(d.myGen)) {
      return holdCancelled(d.myGen, text, outcome !== "cancelled", gateText);
    }
  }
  // The point of no return: from here the text goes into the field, so Esc
  // goes back to the app in front. Only this dictation's arming — a newer
  // press may own Esc already.
  if (cancellable === d.myGen) {
    cancellable = null;
    armCancel(false);
  }
  if (raw) {
    let appBundleId: string | null = null;
    try {
      // Auto-paste is the default behaviour (no setting). Rust posts the
      // paste into the frontmost app through the clipboard, then puts the
      // user's own clipboard back; when it cannot paste, it leaves the text
      // on the clipboard instead.
      const r = await invoke<{ pasted: boolean; appBundleId: string | null }>("insert_text", {
        text,
      });
      appBundleId = r.appBundleId;
      pasted = r.pasted;
      // Three refusals, one outcome: on macOS the Accessibility grant is
      // missing or stale; on Windows UIPI blocks injection into a window
      // running at a higher integrity level (anything launched as
      // administrator), or the foreground window is Parley's own hidden tray
      // window, which the tray menu leaves in front and where a paste lands
      // nowhere. None is recoverable from here and all leave the text on the
      // clipboard, so the overlay stops claiming an insert and names the
      // paste key instead. Rust's log says which it was. One of Parley's own
      // windows in front is not one of them: the overlay never activates
      // Parley, so that is the user dictating into the Ask box, a meeting's
      // context or Settings, and the paste lands there like anywhere else.
      if (!pasted) {
        log.warn("voice-typing: not pasted; text left on the clipboard", { appBundleId });
      }
      log.info("voice-typing: inserted", {
        chars: text.length,
        pasted,
        appBundleId,
        polish: outcome,
      });
      // Only a text that actually landed somewhere can be corrected in place.
      if (pasted) {
        observePastedField(text, d.myGen).catch((error) =>
          log.warn("voice-typing: field observation failed", { error: String(error) }),
        );
      }
    } catch (e) {
      log.error("voice-typing: insert failed", { error: String(e) });
    }
    lastInserted = { gen: d.myGen, text };
    appendVoiceEntry(text, appBundleId, polishStyle).catch((error) =>
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

// ── Esc and Undo ────────────────────────────────────────────────────────────

/** Claim Esc for the cancel, or hand it back to the app in front. Never
 *  awaited — arming must not hold up a press — and Rust ignores a repeat of
 *  the current state, so no mirror of it is kept here. */
function armCancel(armed: boolean): void {
  invoke("set_voice_typing_cancel_armed", { armed }).catch((error) =>
    log.warn("voice-typing: escape cancel arming failed", { armed, error: String(error) }),
  );
}

/**
 * Mark the cancellable dictation cancelled and hand Esc back. Only marks — so
 * it is safe synchronously, ahead of anything queued: what the cancel does to
 * the session runs on the chain (applyCancel), where it cannot interleave
 * with a press or a release. Its polish, if one is in flight, is abandoned
 * here, not when the chain gets to it. The generation, or null when nothing
 * was cancellable.
 */
function markCancel(fromTrigger: boolean): number | null {
  const g = cancellable;
  if (g === null || !cancels.cancel(g)) return null;
  cancellable = null;
  armCancel(false);
  if (polishing?.gen === g) polishing.ctl.abort();
  // Where it was: still recording, released but not settled, or already
  // in its delivery (neither).
  log.info("voice-typing: cancelled (Escape)", {
    capturing: g === gen && capturing,
    busy: g === gen && busy,
    fromTrigger,
  });
  return g;
}

/** Esc from Rust: the global shortcut, or the Windows keyboard hook under the
 *  held trigger (`fromTrigger`, see CancelPayload). */
function onEscape(fromTrigger: boolean): void {
  const marked = markCancel(fromTrigger);
  onPttChain(
    "escape cancel",
    async () => {
      // Nothing was cancellable when the key came, but a press queued ahead
      // of it may have armed a dictation since (the Esc raced its arming).
      const g = marked ?? markCancel(fromTrigger);
      if (g !== null) await applyCancel(g);
      // The hook swallowed this Esc under the held trigger, which turns the
      // hold into a chord whose release Rust never reports. Settle that
      // key-up here: a no-op after a cancel in hold mode (down is already
      // false), the re-arm in toggle mode, and — when there was nothing to
      // cancel — the plain stop that key used to be.
      if (fromTrigger) await onPtt(false);
    },
    { fromTrigger },
  );
}

/** What an Esc does to its dictation. On the chain, so the press that started
 *  it (or its release) has finished first. */
async function applyCancel(g: number): Promise<void> {
  // A newer press owns the session and the overlay — it already withdrew g's
  // offer, and g's delivery will drop the text — or g's start failed.
  if (gen !== g || !cancels.isCancelled(g)) return;
  // Hold mode: the trigger's key-up is now a no-op. Toggle mode and the
  // tray: the next press starts a fresh dictation.
  down = false;
  clearTimeout(hideTimer);
  clearTimeout(cancelTimer);
  cancelTimer = setTimeout(expireCancel, CANCEL_UNDO_MS);
  await emit("voicetyping://session", { phase: "cancelled" });
  if (capturing) {
    // A release with no tail, whether or not the dictation has settled
    // meanwhile (a server close can do that with the mic still open). The
    // recognizer still answers what it heard: that is what Undo brings back.
    clearTimeout(capTimer);
    releasedAt = Date.now();
    await stopCapture({ tail: false });
  }
  // Still open: it settles like any released dictation, and its delivery
  // holds the text (as does one already under way).
  if (busy) waitForSettle();
}

/** A cancelled dictation's delivery reached its text: keep it on offer,
 *  recover it now (Undo was asked before it settled), or drop it. `gateText`
 *  travels with it for the recovery's polish gate (see polishForPaste). */
async function holdCancelled(
  g: number,
  text: string,
  polished: boolean,
  gateText: string,
): Promise<void> {
  const verdict = cancels.settle(g, text, polished, gateText);
  log.info("voice-typing: cancelled dictation held", { chars: text.length, verdict });
  if (verdict === "recover") {
    await deliverRecovered(g, text, polished, gateText);
  } else if (verdict === "hold" && gen === g) {
    // Put the Undo back on screen in case a "polishing" sent just before the
    // Esc reached the overlay after the "cancelled" that followed it.
    await emit("voicetyping://session", { phase: "cancelled" });
  }
}

/** The overlay's Undo: the cancelled dictation goes to the clipboard — now if
 *  it has settled, otherwise the moment it does (see holdCancelled). */
async function onUndoCancel(): Promise<void> {
  const r = cancels.undo();
  if (r.kind === "none") return;
  clearTimeout(cancelTimer);
  log.info("voice-typing: cancel undone", { settled: r.kind === "now" });
  if (r.kind === "wait") {
    // The "finalizing" spinner until it settles.
    if (gen === r.gen) await emit("voicetyping://session", { phase: "stop" });
    return;
  }
  await enqueueRecovery(r.gen, r.text, r.polished, r.gateText);
}

/** Queue a recovery behind every earlier delivery, so the clipboard ends on
 *  the most recent text. */
function enqueueRecovery(
  g: number,
  text: string,
  polished: boolean,
  gateText: string,
): Promise<void> {
  deliveryChain = deliveryChain
    .then(() => deliverRecovered(g, text, polished, gateText))
    .catch((error) => log.error("voice-typing: recovery failed", { error: String(error) }));
  return deliveryChain;
}

/**
 * Undo's delivery: the clipboard and the history, never a paste — seconds
 * have passed, the caret may have moved, and the click that asked for it
 * landed on the overlay. Polished first unless the polish pass already ran to
 * its end, so it reads as it would have; when that pass breaks, the overlay
 * says the text went out as dictated, as `deliver` does. Runs on
 * `deliveryChain`. An explicit copy, so Rust calls off any clipboard restore
 * still pending from an earlier insert: the recovered text stays.
 */
async function deliverRecovered(
  g: number,
  text: string,
  polished: boolean,
  gateText: string,
): Promise<void> {
  let out = text;
  let outcome: PolishOutcome = "off";
  let polishStyle: PolishedStyle | undefined;
  if (text && !polished) {
    ({
      text: out,
      outcome,
      polishStyle,
    } = await polishForPaste(text, g, { recovering: true, gateText }));
  }
  if (out) {
    try {
      await invoke("copy_to_clipboard", { text: out });
    } catch (e) {
      log.error("voice-typing: recovered copy failed", { error: String(e) });
    }
    appendVoiceEntry(out, null, polishStyle).catch((error) =>
      log.warn("voice-typing: append history failed", { error: String(error) }),
    );
    log.info("voice-typing: recovered to clipboard", { chars: out.length });
  }
  if (gen !== g) return;
  await emit("voicetyping://session", {
    phase: "done",
    message: recoveredMessage({ text: out, outcome }),
    text: out,
  });
  scheduleHide();
}

/** The Undo offer ran out: drop the text (never saved) and take the overlay
 *  down, unless a newer dictation owns it. */
function expireCancel(): void {
  const g = cancels.expire();
  if (g === null) return;
  log.info("voice-typing: cancelled dictation discarded", { reason: "undo window closed" });
  if (gen === g) {
    hideOverlay().catch((error) =>
      log.warn("voice-typing: cancel hide failed", { error: String(error) }),
    );
  }
}

/** A new press withdraws the Undo offer (see startSession). */
function dropCancel(): void {
  clearTimeout(cancelTimer);
  if (cancels.supersede()) {
    log.info("voice-typing: cancelled dictation discarded", { reason: "new press" });
  }
}

// ── Copy on the confirmation ────────────────────────────────────────────────

/**
 * The Copy on an inserted dictation's confirmation: its text goes to the
 * clipboard. The safety net for a paste that landed nowhere — no field had
 * focus — because the insert does not leave the text on the clipboard. Only
 * for the dictation the overlay is showing: a click that arrives after the
 * next press is about one the user has moved on from. An explicit copy, so
 * Rust calls off the insert's pending clipboard restore and the text stays.
 */
async function onCopyAction(): Promise<void> {
  const last = lastInserted;
  if (!last || last.gen !== gen) return;
  try {
    await invoke("copy_to_clipboard", { text: last.text });
  } catch (e) {
    log.error("voice-typing: copy failed", { error: String(e) });
    return;
  }
  log.info("voice-typing: copied on request", { chars: last.text.length });
  // The overlay may have moved on while the copy ran: a new dictation, or the
  // dictionary's question (which keeps the overlay up on its own clock).
  if (gen !== last.gen || suggestion || suggestTimer !== undefined) return;
  await emit("voicetyping://session", { phase: "done", message: "copied", text: last.text });
  // A fresh dwell, so the confirmation can be read; the overlay restarts its
  // fade on the new verdict to match.
  scheduleHide();
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
