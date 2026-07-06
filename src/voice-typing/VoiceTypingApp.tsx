import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { Check, Loader2, Mic } from "lucide-react";
import { preloadZhConverter, toTraditional } from "../lib/zhConvert";
import { useI18n, type TranslationKey } from "../i18n";
import { useThemePreference } from "../lib/theme";

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

interface SegPayload {
  id: string;
  source: string;
  text: string;
  is_final: boolean;
}
interface LevelPayload {
  source: string;
  level: number;
}
interface SessionPayload {
  phase: "start" | "stop" | "done" | "error";
  message?: string;
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
type Phase = "listening" | "finalizing" | "done";

/** Numeric index from a "voice-typing-{n}" segment id (tail sorts last). */
function idIndex(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
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
 * events as a meeting (tagged source "voice-typing"), converts Simplified →
 * Traditional for display, and reports the current text back to the host so the
 * clipboard matches what's shown. A waveform tracks the live mic level.
 */
export const VoiceTypingApp = () => {
  const { t } = useI18n();
  useThemePreference(); // so `foreground`/`background` reflect the user's theme
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("listening");
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(() =>
    Array.from({ length: BAR_COUNT }, () => BAR_FLOOR),
  );

  const finalsRef = useRef<Map<string, string>>(new Map());
  const interimRef = useRef("");
  // Cache the Simplified→Traditional conversion per final segment so a long
  // dictation doesn't re-convert the whole transcript on every incoming token.
  const convertedRef = useRef<Map<string, { raw: string; conv: string }>>(new Map());
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

  // Recompute display text from the raw refs, convert, and publish to the host.
  // Final segments are converted once and cached; only the live interim tail is
  // converted every token, so cost stays flat no matter how long the dictation.
  const publish = useRef(async () => {});
  publish.current = async () => {
    const entries = [...finalsRef.current.entries()].sort((a, b) => idIndex(a[0]) - idIndex(b[0]));
    let finals = "";
    for (const [id, raw] of entries) {
      const cached = convertedRef.current.get(id);
      let conv: string;
      if (cached && cached.raw === raw) {
        conv = cached.conv;
      } else {
        conv = await toTraditional(raw);
        convertedRef.current.set(id, { raw, conv });
      }
      finals += conv;
    }
    const interim = interimRef.current ? await toTraditional(interimRef.current) : "";
    const full = (finals + interim).trim();
    setText(full);
    emit("voicetyping://text", { text: full }).catch(() => {});
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
      }).catch(() => {});
    };

    // Warm the S→T dictionary while the overlay is prewarmed/idle, so the
    // first dictation's publish doesn't stall on the dictionary parse.
    preloadZhConverter();

    track(
      listen<SegPayload>("transcript://segment", (e) => {
        const p = e.payload;
        if (p.source !== "voice-typing") return;
        if (p.is_final) {
          finalsRef.current.set(p.id, p.text);
          interimRef.current = ""; // the committed run supersedes the tail
        } else {
          interimRef.current = p.text;
        }
        publish.current().catch(() => {});
      }),
    );

    track(
      listen<LevelPayload>("audio://level", (e) => {
        if (e.payload.source !== "voice-typing") return;
        setBars(instantWaveform(e.payload.level));
      }),
    );

    track(
      listen<SessionPayload>("voicetyping://session", (e) => {
        const { phase: p, message } = e.payload;
        if (p === "start") {
          finalsRef.current.clear();
          convertedRef.current.clear();
          interimRef.current = "";
          setText("");
          setError(null);
          setPhase("listening");
        } else if (p === "stop") {
          setPhase("finalizing");
        } else if (p === "done") {
          setPhase("done");
        } else if (p === "error") {
          setError(message || "error");
          setPhase("done");
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

  const errorKey = (error && ERROR_KEYS[error]) || "voiceTyping.error";
  const bubble = error ? t(errorKey) : text;

  let phaseIcon = <Mic className="size-2.5" />;
  if (phase === "finalizing") {
    phaseIcon = <Loader2 className="size-2.5 animate-spin" />;
  } else if (phase === "done") {
    phaseIcon = <Check className="size-2.5" strokeWidth={3} />;
  }

  return (
    <div className="flex h-screen w-screen select-none flex-col items-center justify-end gap-2 pb-4">
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

      {/* Copied-to-clipboard confirmation. The transcript is already on the
          clipboard (and pasted at the cursor when Accessibility is granted), so
          the "done" state announces it near the overlay — the user knows they
          can paste it anywhere even if auto-paste was blocked. */}
      {phase === "done" && !error && text && (
        <div className="flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-md">
          <Check className="size-2.5" strokeWidth={3} />
          {t("voiceTyping.copied")}
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
