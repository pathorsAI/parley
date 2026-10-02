import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { Check, Loader2, Mic, Sparkles, X } from "lucide-react";
import { preloadZhConverter } from "../lib/zhConvert";
import { normalizeTranscriptText } from "../lib/textNormalize";
import { useI18n, type TranslationKey } from "../i18n";
import { useThemePreference } from "../lib/theme";
import { formatChordLabel, modChordCap } from "../lib/commands/format";
import { log } from "../lib/log";
import { isTauri } from "../lib/platform";
import { sameHitRects, toHitRects, type HitRect } from "../lib/voiceTyping/hitRegions";
import { SessionTranscript, type Segment, type SessionEvent } from "../lib/voiceTyping/transcript";
import type { DoneMessage } from "../lib/voiceTyping/overlay";
import {
  CANCEL_ACTION_EVENT,
  CANCEL_UNDO_MS,
  type CancelActionPayload,
} from "../lib/voiceTyping/cancel";
import {
  SUGGEST_ACTION_EVENT,
  SUGGEST_EVENT,
  SUGGEST_STATE_EVENT,
  type SuggestActionPayload,
  type SuggestPayload,
  type SuggestStatePayload,
} from "../lib/voiceTyping/suggestEvents";

const BAR_COUNT = 20;
const BAR_FLOOR = 0.05;
/** Perceptual gain on the mic level before it drives the bars. `level` is a raw
 *  peak ratio (peak / 32767) that sits low for normal speech, so without a lift
 *  the bars barely leave the floor. Applied on top of the sqrt curve. */
const LEVEL_GAIN = 1.7;
/** Tallest a bar can draw, in px (the pill grows to fit — see the bars row). */
const BAR_MAX_PX = 22;
const WAVE_PROFILE = [
  0.28, 0.44, 0.62, 0.38, 0.72, 0.5, 0.86, 0.64, 0.95, 0.74, 0.74, 0.95, 0.64, 0.86, 0.5, 0.72,
  0.38, 0.62, 0.44, 0.28,
];

/** Once copied, hold the confirmation fully visible this long, then fade out
 *  over FADE_MS. The sum must land at/before the host's HIDE_DELAY_MS so the
 *  window is already invisible when it's ordered out (no abrupt pop). */
const DONE_DWELL_MS = 2150;
const FADE_MS = 450;

interface LevelPayload {
  source: string;
  level: number;
  session: number | null;
}

/** Overlay message per error phase `message`: the host's own "no-key", or a
 *  backend failure code from `voicetyping://error` (see capture.rs). Anything
 *  unrecognized falls back to the generic error string. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  "no-key": "voiceTyping.noKey",
  quota: "voiceTyping.error.quota",
  auth: "voiceTyping.error.auth",
  key: "voiceTyping.error.key",
};

/** listening = recording; finalizing = waiting for the STT's answer to the
 *  release; cancelled = Esc called it off, and Undo is on offer until the host
 *  takes the overlay down (see cancel.ts); done = delivered (or nothing was
 *  heard — see `verdict`). */
/** `polishing` is a second, longer wait after `finalizing`: the transcript has
 *  settled and is being cleaned up by the model before it is pasted. It gets
 *  its own phase rather than reusing `finalizing` because it is the only part
 *  of the pipeline the user waits a noticeable beat for, and a spinner that
 *  does not say why reads as a hang. */
type Phase = "listening" | "finalizing" | "polishing" | "cancelled" | "done";

/** Report a bubble button back to the host, which owns every decision. */
function suggestAct(action: SuggestActionPayload["action"]): void {
  emit(SUGGEST_ACTION_EVENT, { action } satisfies SuggestActionPayload).catch((error) =>
    log.warn("voice typing overlay: suggest action emit failed", {
      action,
      error: String(error),
    }),
  );
}

/** Report the cancelled pill's Undo to the host, which owns every decision. */
function cancelAct(action: CancelActionPayload["action"]): void {
  emit(CANCEL_ACTION_EVENT, { action } satisfies CancelActionPayload).catch((error) =>
    log.warn("voice typing overlay: cancel action emit failed", {
      action,
      error: String(error),
    }),
  );
}

/** Tell the native side which parts of this window catch clicks (see
 *  hitRegions.ts); everywhere else passes them through to the app behind.
 *  Outside Tauri (`bun run dev` in a browser) there is no window to make
 *  click-through, so nothing is sent. */
function sendHitRects(rects: HitRect[]): void {
  if (!isTauri()) return;
  invoke("set_voice_overlay_hit_rects", { rects }).catch((error) =>
    log.warn("voice typing overlay: hit rects report failed", {
      count: rects.length,
      error: String(error),
    }),
  );
}

/** Decay the waveform bars toward the floor (extracted to keep nesting shallow). */
function decayBars(bars: number[]): number[] {
  return bars.map((b) => Math.max(BAR_FLOOR, b * 0.8));
}

/** Convert the current mic level into a full instantaneous waveform, not history. */
function instantWaveform(level: number): number[] {
  const energy = Math.min(1, Math.sqrt(Math.max(0, level)) * LEVEL_GAIN);
  const lift = BAR_FLOOR + energy * (1 - BAR_FLOOR);

  return WAVE_PROFILE.map((shape, index) => {
    const ripple = 0.08 * Math.sin(energy * Math.PI * 2 + index * 1.7);
    return Math.max(BAR_FLOOR, Math.min(1, lift * (0.24 + shape * 0.76 + ripple)));
  });
}

/** The verdicts that mean the text reached the clipboard (see doneMessage) —
 *  an Undo's recovered text included. */
const COPIED_VERDICTS: ReadonlySet<string> = new Set([
  "ok",
  "ok-unpolished",
  "clipboard-only",
  "recovered",
] satisfies DoneMessage[]);

/**
 * The floating dictation overlay. Listens to the same realtime transcription
 * events as a meeting (tagged source "voice-typing") and normalizes them for
 * display (Simplified → Traditional, then the user's phrase dictionary). It is
 * display only: the host keeps its own transcript of the same events and
 * delivers from that, then tells this window what it delivered on `done` —
 * the text, polished or not, and a verdict. From then on the pill is frozen on
 * exactly that. A waveform tracks the live mic level while listening.
 *
 * It also renders the "add this correction to the dictionary?" bubble the host
 * pushes here after the user fixes a word in the app they pasted into.
 */
export const VoiceTypingApp = () => {
  const { t } = useI18n();
  useThemePreference(); // so `foreground`/`background` reflect the user's theme
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("listening");
  const [error, setError] = useState<string | null>(null);
  // Set when the hosted single-dictation cap ended the session: a note shown
  // alongside the (still delivered) transcript so the abrupt stop is explained.
  const [limited, setLimited] = useState(false);
  // Set when the transcript reached the clipboard but the auto-paste did not
  // land, so the confirmation can name the key the user has to press instead.
  const [pasteBlocked, setPasteBlocked] = useState(false);
  // Set when the text went out as dictated because the polish pass was tried
  // and did not come back (timed out or failed) — the confirmation says so
  // instead of letting the user wonder why "polishing" changed nothing.
  const [unpolished, setUnpolished] = useState(false);
  // Drives the graceful fade-out of the whole overlay after the copied
  // confirmation has dwelled — reset whenever a new session starts.
  const [fading, setFading] = useState(false);
  // The dictionary suggestion the host asked us to offer, and whether it has
  // been accepted (the confirmation + undo state). Null = no bubble.
  const [suggest, setSuggest] = useState<SuggestPayload | null>(null);
  const [suggestAdded, setSuggestAdded] = useState(false);
  const [bars, setBars] = useState<number[]>(() =>
    Array.from({ length: BAR_COUNT }, () => BAR_FLOOR),
  );

  // What the host said about the delivery (a DoneMessage), null until `done`.
  const [verdict, setVerdict] = useState<string | null>(null);

  const transcript = useRef(new SessionTranscript());
  // Set on `done`: the pill shows what was delivered, and a straggling
  // segment (or a conversion still in flight) must not replace it.
  const frozen = useRef(false);
  // The phase as the event handlers see it (they are bound once).
  const phaseRef = useRef<Phase>("listening");
  // Stable per-position keys for the waveform bars (values shift, positions don't).
  const barKeys = useRef(Array.from({ length: BAR_COUNT }, (_, i) => `bar-${i}`));

  // Every block marked `data-overlay-hit` under the root is reported to the
  // native side as a part of this window that catches clicks; the rest of it
  // lets them through. So anything visible the user might click, or click
  // beside, carries the attribute.
  const rootRef = useRef<HTMLDivElement>(null);
  // The last report, so an unchanged layout costs no IPC — the waveform alone
  // re-renders this window many times a second.
  const reportedHits = useRef<HitRect[] | null>(null);
  const reportHits = useRef(() => {});
  reportHits.current = () => {
    const root = rootRef.current;
    if (!root) return;
    // Fading out: nothing on screen is worth catching a click for.
    const boxes = fading
      ? []
      : Array.from(root.querySelectorAll("[data-overlay-hit]"), (el) =>
          el.getBoundingClientRect(),
        );
    const rects = toHitRects(boxes, {
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    });
    if (reportedHits.current && sameHitRects(reportedHits.current, rects)) return;
    reportedHits.current = rects;
    sendHitRects(rects);
  };

  // After every render (no deps): a render is what moves a block — the
  // transcript grows, a note comes or goes. A layout effect, so the report
  // goes out before the frame that shows the change is painted.
  useLayoutEffect(() => {
    reportHits.current();
  });

  // …and after what moves blocks without a render: a window resize, and the
  // web font arriving (it changes every line's width).
  useEffect(() => {
    const report = () => reportHits.current();
    let live = true;
    globalThis.addEventListener("resize", report);
    void document.fonts.ready.then(() => {
      if (live) report();
    });
    return () => {
      live = false;
      globalThis.removeEventListener("resize", report);
    };
  }, []);

  // This window must be see-through; the shared stylesheet paints an opaque
  // app background, so strip it for the overlay only.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.background;
    const prevBody = document.body.style.background;
    html.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  const publish = useRef(async () => {});
  publish.current = async () => {
    const report = await transcript.current.report(normalizeTranscriptText);
    if (!report || frozen.current) return;
    setText(report.text);
  };

  // Back to a blank pill: the last dictation's text, verdict, and fade are
  // gone, whatever comes next.
  const resetPresentation = () => {
    setText("");
    setError(null);
    setLimited(false);
    setFading(false);
    setPasteBlocked(false);
    setUnpolished(false);
    setVerdict(null);
    setSuggest(null);
    setSuggestAdded(false);
  };

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    // listen() resolves asynchronously, so an unmount that lands before it
    // resolves (StrictMode's dev double-mount, any overlay remount) would push
    // the unlisten into an already-drained array — a leaked duplicate listener
    // that double-fires setState for the lifetime of this long-lived window.
    // Track through a cancellation flag instead: late arrivals unlisten
    // themselves immediately.
    let cancelled = false;
    const track = (p: Promise<() => void>) => {
      p.then((u) => {
        if (cancelled) u();
        else unsubs.push(u);
      }).catch((error) =>
        log.warn("voice typing overlay: listener setup failed", { error: String(error) }),
      );
    };

    const enterPhase = (p: Phase) => {
      phaseRef.current = p;
      setPhase(p);
    };

    // Warm the S→T dictionary while the overlay is prewarmed/idle, so the
    // first dictation's publish doesn't stall on the dictionary parse.
    preloadZhConverter();

    track(
      listen<Segment>("transcript://segment", (e) => {
        const p = e.payload;
        if (frozen.current) return;
        if (!transcript.current.accept(p)) return;
        publish.current().catch((error) =>
          log.warn("voice typing overlay: transcript publish failed", {
            segmentId: p.id,
            error: String(error),
          }),
        );
      }),
    );

    // Only while listening: Rust keeps streaming a short tail of audio after
    // the release, which would otherwise flicker the bars under "finalizing".
    track(
      listen<LevelPayload>("audio://level", (e) => {
        if (phaseRef.current !== "listening") return;
        if (!transcript.current.owns(e.payload)) return;
        setBars(instantWaveform(e.payload.level));
      }),
    );

    track(
      listen<SessionEvent>("voicetyping://session", (e) => {
        const ev = e.payload;
        if (ev.phase === "start") {
          transcript.current.reset(ev.session);
          frozen.current = false;
          resetPresentation();
          enterPhase("listening");
          return;
        }
        if (ev.phase === "done") {
          // The host's word on what was delivered: from here the pill shows
          // exactly that (the polished text, when polish ran) and ignores any
          // straggler — before, late tokens kept arriving under a green
          // "Copied" that no longer matched the clipboard, or had nothing on
          // it at all.
          frozen.current = true;
          if (typeof ev.text === "string") setText(ev.text);
          setVerdict(ev.message ?? null);
          // "clipboard-only" = the transcript was copied but the synthetic
          // paste was refused (no Accessibility on macOS, UIPI on Windows), or
          // it went to Parley itself. The confirmation has to change, or the
          // user watches "Copied" go by while nothing appears where they were
          // typing.
          setPasteBlocked(ev.message === "clipboard-only");
          // "ok-unpolished" = pasted, but raw: the polish pass timed out or
          // failed. Never set together with "clipboard-only" (see doneMessage).
          setUnpolished(ev.message === "ok-unpolished");
          enterPhase("done");
          return;
        }
        const { phase: p, message } = ev;
        if (p === "cancelled") {
          // The host re-sends it in case a "polishing" overtook it; a repeat
          // must not restart the Undo pill's fade clock.
          if (phaseRef.current === "cancelled") return;
          // Undo stays reachable even over a session that had failed.
          setError(null);
          setFading(false);
          enterPhase("cancelled");
        } else if (p === "stop") {
          // Also an Undo clicked before the text settled, possibly as the
          // cancelled pill had started to fade.
          setFading(false);
          enterPhase("finalizing");
        } else if (p === "polishing") {
          enterPhase("polishing");
        } else if (p === "limit") {
          // Cap hit while the key was held: the transcript still flushes and
          // pastes; flag the note and fall through the normal settle path.
          setLimited(true);
          enterPhase("finalizing");
        } else if (p === "error") {
          resetPresentation();
          setError(message || "error");
          enterPhase("done");
        }
      }),
    );

    // The host noticed the user fixing a word in whatever they pasted into and
    // is bringing the overlay back to ask about it. The window may still be
    // showing (and fading out) the last dictation — reset that presentation so
    // the question is what's on screen.
    track(
      listen<SuggestPayload>(SUGGEST_EVENT, (e) => {
        resetPresentation();
        setSuggest(e.payload);
        enterPhase("done");
      }),
    );

    track(
      listen<SuggestStatePayload>(SUGGEST_STATE_EVENT, (e) => {
        if (e.payload.state === "added") {
          setSuggestAdded(true);
        } else {
          setSuggest(null);
          setSuggestAdded(false);
        }
      }),
    );

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  // Let the waveform settle back to the floor when not actively listening.
  useEffect(() => {
    if (phase === "listening") return;
    const id = setInterval(() => setBars(decayBars), 90);
    return () => clearInterval(id);
  }, [phase]);

  // Once copied, let the confirmation dwell, then fade the overlay out just
  // before the host orders the window hidden. Only the genuine "copied" state
  // fades: an error also lands on the "done" phase but must stay visible until
  // the session is dismissed (toggle mode has no release to hide it), so never
  // fade an error out from under the user.
  // A suggestion bubble is interactive and lives on the host's own clock — never
  // fade one out from under the user's cursor.
  useEffect(() => {
    if (phase !== "done" || error || suggest) return;
    const id = setTimeout(() => setFading(true), DONE_DWELL_MS);
    return () => clearTimeout(id);
  }, [phase, error, suggest]);

  // A cancelled dictation is not "done": its Undo stays fully visible for
  // (almost) the whole offer, then fades just before the host takes the
  // overlay down at CANCEL_UNDO_MS.
  useEffect(() => {
    if (phase !== "cancelled") return;
    const id = setTimeout(() => setFading(true), CANCEL_UNDO_MS - FADE_MS - 300);
    return () => clearTimeout(id);
  }, [phase]);

  const errorKey = (error && ERROR_KEYS[error]) || "voiceTyping.error";
  const bubble = error ? t(errorKey) : text;

  // The "done" confirmation's wording. A refused paste outranks everything: it
  // is the one note that asks the user to do something.
  let doneNote = t("voiceTyping.copied");
  if (pasteBlocked) {
    doneNote = t("voiceTyping.pasteBlocked", { paste: modChordCap("V") });
  } else if (unpolished) {
    doneNote = t("voiceTyping.copiedUnpolished");
  }

  let phaseIcon = <Mic className="size-2.5" />;
  if (phase === "polishing") {
    phaseIcon = <Sparkles className="size-2.5 animate-pulse" />;
  } else if (phase === "finalizing") {
    phaseIcon = <Loader2 className="size-2.5 animate-spin" />;
  } else if (phase === "cancelled") {
    phaseIcon = <X className="size-2.5" strokeWidth={3} />;
  } else if (phase === "done") {
    phaseIcon = <Check className="size-2.5" strokeWidth={3} />;
  }
  let indicatorTone = "bg-primary text-primary-foreground";
  let barTone = "bg-primary";
  if (phase === "listening") {
    indicatorTone = "bg-recording text-white";
    barTone = "bg-recording";
  } else if (phase === "cancelled") {
    // Neutral: nothing is happening and nothing went wrong.
    indicatorTone = "bg-background/25 text-background";
    barTone = "bg-background/40";
  } else if (phase === "done") {
    indicatorTone = "bg-success text-success-foreground";
  }

  return (
    <div
      ref={rootRef}
      className="flex h-screen w-screen select-none flex-col items-center justify-end gap-2 pb-4"
      style={{ opacity: fading ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-in` }}
    >
      {/* Hosted single-dictation cap note: shown above the transcript, which is
          still delivered (unless Esc cancels it — then the Undo is the news).
          Warning tone to read as a limit, not an error. */}
      {limited && !error && phase !== "cancelled" && (
        <div
          data-overlay-hit
          className="rounded-full border border-warning-border bg-warning px-3 py-1 text-center text-[12px] font-medium text-warning-foreground shadow-md"
        >
          {t("voiceTyping.limit")}
        </div>
      )}

      {/* Layer 1 — transcript. Inverted theme colours (foreground bg / background
          text) for high contrast against whatever's behind the overlay. */}
      {bubble && (
        <div
          data-overlay-hit
          className={`flex max-h-[84px] max-w-[420px] flex-col justify-end overflow-hidden rounded-[14px] px-3.5 py-1.5 text-center text-[14px] font-medium leading-snug shadow-md ${
            error ? "bg-destructive text-white" : "bg-foreground text-background"
          } ${phase === "cancelled" ? "opacity-50" : ""}`}
        >
          {/* Bottom-anchored + clipped: the newest words stay visible while a
              long dictation scrolls older lines off the top, so the preview
              never outgrows the fixed overlay window. */}
          <span>{bubble}</span>
        </div>
      )}

      {/* Polishing note. The one beat in the pipeline the user actually waits
          for, so it says what it is waiting on rather than spinning silently.
          Primary: processing is what is happening now. */}
      {phase === "polishing" && !error && (
        <div
          data-overlay-hit
          className="flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground shadow-md"
        >
          <Sparkles className="size-2.5 animate-pulse" />
          {t("voiceTyping.polishing")}
        </div>
      )}

      {/* Esc called the dictation off: nothing was pasted, and Undo copies it
          to the clipboard instead. One row, so it never crowds the window.
          The panel is non-activating, so Undo acts on pointer-down rather
          than assuming a focused window's click; the host owns every
          decision. It stops catching clicks as it fades — the offer is
          closing, and a click then would silently do nothing. */}
      {phase === "cancelled" && (
        <div
          data-overlay-hit
          className={`flex items-center gap-1.5 rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-medium text-background shadow-md ${
            fading ? "pointer-events-none" : ""
          }`}
        >
          <X className="size-2.5" strokeWidth={3} />
          {t("voiceTyping.cancelled")}
          <span className="opacity-60">·</span>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              cancelAct("undo");
            }}
            className="underline underline-offset-2"
          >
            {t("voiceTyping.cancelled.undo")}
          </button>
        </div>
      )}

      {/* Copied-to-clipboard confirmation, shown only on the host's word that
          the text reached the clipboard (not merely because there is text on
          screen). When the auto-paste was refused as well (no Accessibility
          on macOS, UIPI refusing an elevated window on Windows) it turns
          warning and names the paste key — otherwise the user reads "Copied",
          sees nothing appear where they were typing, and assumes the
          dictation was lost. A dictation whose polish did not come back still
          reads as a success (it was delivered), but says it went out as
          dictated. */}
      {phase === "done" && !error && COPIED_VERDICTS.has(verdict ?? "") && (
        <div
          data-overlay-hit
          className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium shadow-md ${
            pasteBlocked
              ? "border-warning-border bg-warning text-warning-foreground"
              : "border-success-border bg-success text-success-foreground"
          }`}
        >
          {!pasteBlocked && <Check className="size-2.5" strokeWidth={3} />}
          {doneNote}
        </div>
      )}

      {/* Nothing was heard, so nothing was copied: say so plainly, instead of
          an empty pill that leaves the user guessing. Neutral, not an error. */}
      {phase === "done" && !error && !suggest && verdict === "empty" && (
        <div
          data-overlay-hit
          className="rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-medium text-background shadow-md"
        >
          {t("voiceTyping.empty")}
        </div>
      )}

      {/* Undo on a cancelled dictation that had no text to bring back. */}
      {phase === "done" && !error && !suggest && verdict === "nothing" && (
        <div
          data-overlay-hit
          className="rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-medium text-background shadow-md"
        >
          {t("voiceTyping.cancelled.nothing")}
        </div>
      )}

      {/* Learn-from-correction bubble. Same dark pill language as the
          transcript; the panel is non-activating, so the buttons act on
          pointer-down rather than assuming a focused window's click. Every
          decision (write, undo, ignore, the timers) belongs to the host — this
          only reports which button was hit. */}
      {suggest && !suggestAdded && (
        <div
          data-overlay-hit
          className="flex max-w-[420px] flex-col items-center gap-1.5 rounded-[14px] bg-foreground px-3.5 py-2 text-background shadow-md"
        >
          <span className="text-center text-[13px] font-medium leading-snug">
            {t("dict.suggest.question", { from: suggest.from, to: suggest.to })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onPointerDown={() => suggestAct("add")}
              className="flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground"
            >
              {t("dict.suggest.add")}
              {/* The cap for host.ts's SUGGEST_SHORTCUT ("Alt+Enter"), computed
                  rather than translated: a keycap is not prose, and as a
                  dictionary string it spelled the mac "⌥" and "↩" in BOTH
                  locales — two keys a Windows user does not have. */}
              <span className="opacity-70">{formatChordLabel({ alt: true, key: "Enter" })}</span>
            </button>
            <button
              type="button"
              onPointerDown={() => suggestAct("ignore")}
              className="rounded-full bg-background/15 px-2.5 py-0.5 text-[11px] font-medium text-background"
            >
              {t("dict.suggest.ignore")}
            </button>
          </div>
        </div>
      )}

      {/* Accepted: confirm it landed, and keep an undo within reach for a beat. */}
      {suggest && suggestAdded && (
        <div
          data-overlay-hit
          className="flex items-center gap-1.5 rounded-full border border-success-border bg-success px-2.5 py-0.5 text-[11px] font-medium text-success-foreground shadow-md"
        >
          <Check className="size-2.5" strokeWidth={3} />
          {t("dict.suggest.added")}
          <span className="opacity-60">·</span>
          <button
            type="button"
            onPointerDown={() => suggestAct("undo")}
            className="underline underline-offset-2"
          >
            {t("dict.suggest.undo")}
          </button>
        </div>
      )}

      {/* Layer 2 — audio waver pill: same inverted bg as the transcript, with a
          small state indicator. Recording red while dictation is live, primary
          while finalizing/polishing, success once done. */}
      <div
        data-overlay-hit
        className="flex items-center gap-2 rounded-full bg-foreground px-3 py-1.5 shadow-md"
      >
        <div
          className={`grid size-4 place-items-center rounded-full transition-colors ${indicatorTone}`}
        >
          {phaseIcon}
        </div>
        <div className="flex h-6 items-center gap-[2px]">
          {bars.map((b, i) => (
            <span
              key={barKeys.current[i]}
              className={`w-[2px] rounded-full ${barTone}`}
              style={{ height: `${Math.max(2, Math.round(b * BAR_MAX_PX))}px` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
