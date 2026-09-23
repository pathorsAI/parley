import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { Check, Loader2, Mic, Sparkles } from "lucide-react";
import { preloadZhConverter } from "../lib/zhConvert";
import { normalizeTranscriptText } from "../lib/textNormalize";
import { useI18n, type TranslationKey } from "../i18n";
import { useThemePreference } from "../lib/theme";
import { formatChordLabel, modChordCap } from "../lib/commands/format";
import { log } from "../lib/log";
import { SessionTranscript, type Segment } from "../lib/voiceTyping/transcript";
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
  session?: number;
}
interface SessionPayload {
  phase: "start" | "stop" | "polishing" | "done" | "error" | "limit";
  message?: string;
  session?: number;
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

/** listening = recording; finalizing = waiting for the STT final flush; done =
 *  copied. */
/** `polishing` is a second, longer wait after `finalizing`: the transcript has
 *  settled and is being cleaned up by the model before it is pasted. It gets
 *  its own phase rather than reusing `finalizing` because it is the only part
 *  of the pipeline the user waits a noticeable beat for, and a spinner that
 *  does not say why reads as a hang. */
type Phase = "listening" | "finalizing" | "polishing" | "done";

/** Report a bubble button back to the host, which owns every decision. */
function suggestAct(action: SuggestActionPayload["action"]): void {
  emit(SUGGEST_ACTION_EVENT, { action } satisfies SuggestActionPayload).catch((error) =>
    log.warn("voice typing overlay: suggest action emit failed", {
      action,
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

/**
 * The floating dictation overlay. Listens to the same realtime transcription
 * events as a meeting (tagged source "voice-typing"), normalizes them for
 * display (Simplified → Traditional, then the user's phrase dictionary), and
 * reports the current text back to the host so the clipboard matches what's
 * shown. A waveform tracks the live mic level.
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

  const transcript = useRef(new SessionTranscript());
  // Stable per-position keys for the waveform bars (values shift, positions don't).
  const barKeys = useRef(Array.from({ length: BAR_COUNT }, (_, i) => `bar-${i}`));

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

  // Render the transcript, show it, and report it to the host.
  const publish = useRef(async () => {});
  publish.current = async () => {
    const full = await transcript.current.render(normalizeTranscriptText);
    setText(full);
    emit("voicetyping://text", { text: full }).catch((error) =>
      log.warn("voice typing overlay: text publish failed", { error: String(error) }),
    );
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

    // Warm the S→T dictionary while the overlay is prewarmed/idle, so the
    // first dictation's publish doesn't stall on the dictionary parse.
    preloadZhConverter();

    track(
      listen<Segment>("transcript://segment", (e) => {
        const p = e.payload;
        if (!transcript.current.accept(p)) return;
        publish.current().catch((error) =>
          log.warn("voice typing overlay: transcript publish failed", {
            segmentId: p.id,
            error: String(error),
          }),
        );
      }),
    );

    track(
      listen<LevelPayload>("audio://level", (e) => {
        if (!transcript.current.owns(e.payload)) return;
        setBars(instantWaveform(e.payload.level));
      }),
    );

    track(
      listen<SessionPayload>("voicetyping://session", (e) => {
        const { phase: p, message } = e.payload;
        if (p === "start") {
          transcript.current.reset(e.payload.session ?? 0);
          setText("");
          setError(null);
          setLimited(false);
          setFading(false);
          setPasteBlocked(false);
          setSuggest(null);
          setSuggestAdded(false);
          setPhase("listening");
        } else if (p === "stop") {
          setPhase("finalizing");
        } else if (p === "polishing") {
          setPhase("polishing");
        } else if (p === "limit") {
          // Cap hit while the key was held: the transcript still flushes and
          // pastes; flag the note and fall through the normal finalize path.
          setLimited(true);
          setPhase("finalizing");
        } else if (p === "done") {
          // "clipboard-only" = the transcript was copied but the synthetic
          // paste was refused (no Accessibility on macOS, UIPI on Windows).
          // The confirmation has to change, or the user watches "Copied" go by
          // while nothing appears where they were typing.
          setPasteBlocked(message === "clipboard-only");
          setPhase("done");
        } else if (p === "error") {
          setError(message || "error");
          setPhase("done");
        }
      }),
    );

    // The host noticed the user fixing a word in whatever they pasted into and
    // is bringing the overlay back to ask about it. The window may still be
    // showing (and fading out) the last dictation — reset that presentation so
    // the question is what's on screen.
    track(
      listen<SuggestPayload>(SUGGEST_EVENT, (e) => {
        setSuggest(e.payload);
        setSuggestAdded(false);
        setText("");
        setError(null);
        setLimited(false);
        setFading(false);
        setPhase("done");
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

  const errorKey = (error && ERROR_KEYS[error]) || "voiceTyping.error";
  const bubble = error ? t(errorKey) : text;

  let phaseIcon = <Mic className="size-2.5" />;
  if (phase === "polishing") {
    phaseIcon = <Sparkles className="size-2.5 animate-pulse" />;
  } else if (phase === "finalizing") {
    phaseIcon = <Loader2 className="size-2.5 animate-spin" />;
  } else if (phase === "done") {
    phaseIcon = <Check className="size-2.5" strokeWidth={3} />;
  }

  return (
    <div
      className="flex h-screen w-screen select-none flex-col items-center justify-end gap-2 pb-4"
      style={{ opacity: fading ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-in` }}
    >
      {/* Hosted single-dictation cap note: shown above the transcript, which is
          still delivered. Amber to read as a limit, not an error. */}
      {limited && !error && (
        <div className="rounded-full bg-amber-500 px-3 py-1 text-center text-[12px] font-medium text-white shadow-md">
          {t("voiceTyping.limit")}
        </div>
      )}

      {/* Layer 1 — transcript. Inverted theme colours (foreground bg / background
          text) for high contrast against whatever's behind the overlay. */}
      {bubble && (
        <div
          className={`flex max-h-[84px] max-w-[420px] flex-col justify-end overflow-hidden rounded-[14px] px-3.5 py-1.5 text-center text-[14px] font-medium leading-snug shadow-md ${
            error ? "bg-red-600 text-white" : "bg-foreground text-background"
          }`}
        >
          {/* Bottom-anchored + clipped: the newest words stay visible while a
              long dictation scrolls older lines off the top, so the preview
              never outgrows the fixed overlay window. */}
          <span>{bubble}</span>
        </div>
      )}

      {/* Polishing note. The one beat in the pipeline the user actually waits
          for, so it says what it is waiting on rather than spinning silently.
          Same pill language as the "copied" confirmation below. */}
      {phase === "polishing" && !error && (
        <div className="flex items-center gap-1 rounded-full bg-sky-500 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-md">
          <Sparkles className="size-2.5 animate-pulse" />
          {t("voiceTyping.polishing")}
        </div>
      )}

      {/* Copied-to-clipboard confirmation. The transcript is always on the
          clipboard, so the "done" state announces it near the overlay. When the
          auto-paste was refused as well (no Accessibility on macOS, UIPI
          refusing an elevated window on Windows) it turns amber and names the
          paste key — otherwise the user reads "Copied", sees nothing appear
          where they were typing, and assumes the dictation was lost. */}
      {phase === "done" && !error && text && (
        <div
          className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white shadow-md ${
            pasteBlocked ? "bg-amber-500" : "bg-emerald-500"
          }`}
        >
          {!pasteBlocked && <Check className="size-2.5" strokeWidth={3} />}
          {pasteBlocked
            ? t("voiceTyping.pasteBlocked", { paste: modChordCap("V") })
            : t("voiceTyping.copied")}
        </div>
      )}

      {/* Learn-from-correction bubble. Same dark pill language as the
          transcript; the panel is non-activating, so the buttons act on
          pointer-down rather than assuming a focused window's click. Every
          decision (write, undo, ignore, the timers) belongs to the host — this
          only reports which button was hit. */}
      {suggest && !suggestAdded && (
        <div className="flex max-w-[420px] flex-col items-center gap-1.5 rounded-[14px] bg-foreground px-3.5 py-2 text-background shadow-md">
          <span className="text-center text-[13px] font-medium leading-snug">
            {t("dict.suggest.question", { from: suggest.from, to: suggest.to })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onPointerDown={() => suggestAct("add")}
              className="flex items-center gap-1 rounded-full bg-sky-500 px-2.5 py-0.5 text-[11px] font-medium text-white"
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
        <div className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-md">
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

      {/* Layer 2 — audio waver pill: same inverted bg as the transcript, blue
          bars, with a small state indicator. */}
      <div className="flex items-center gap-2 rounded-full bg-foreground px-3 py-1.5 shadow-md">
        <div
          className={`grid size-4 place-items-center rounded-full text-white transition-colors ${
            phase === "done" ? "bg-emerald-500" : "bg-sky-500"
          }`}
        >
          {phaseIcon}
        </div>
        <div className="flex h-6 items-center gap-[2px]">
          {bars.map((b, i) => (
            <span
              key={barKeys.current[i]}
              className="w-[2px] rounded-full bg-sky-500"
              style={{ height: `${Math.max(2, Math.round(b * BAR_MAX_PX))}px` }}
            />
          ))}
        </div>
      </div>

      {/* Layer 3 — brand wordmark (no logo). White with a shadow so it reads on
          any background behind the transparent overlay. */}
      <span className="text-[15px] font-semibold tracking-wide text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
        {t("app.name")}
      </span>
    </div>
  );
};
