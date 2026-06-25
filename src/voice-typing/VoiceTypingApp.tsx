import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { Check, Loader2, Mic } from "lucide-react";
import { toTraditional } from "../lib/zhConvert";
import { useI18n } from "../i18n";
import { useThemePreference } from "../lib/theme";

const BAR_COUNT = 20;
const BAR_FLOOR = 0.05;

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

/** listening = recording; finalizing = waiting for the STT final flush; done =
 *  copied. */
type Phase = "listening" | "finalizing" | "done";

/** Numeric index from a "voice-typing-{n}" segment id (tail sorts last). */
function idIndex(id: string): number {
  const m = id.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * The floating dictation overlay. Listens to the same realtime transcription
 * events as a meeting (tagged source "voice-typing"), converts Simplified →
 * Traditional for display, and reports the current text back to the host so the
 * clipboard matches what's shown. A waveform tracks the live mic level.
 */
export function VoiceTypingApp() {
  const { t } = useI18n();
  useThemePreference(); // so `foreground`/`background` reflect the user's theme
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("listening");
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(BAR_FLOOR));

  const finalsRef = useRef<Map<string, string>>(new Map());
  const interimRef = useRef("");

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
  const publish = useRef(async () => {});
  publish.current = async () => {
    const ordered = [...finalsRef.current.entries()]
      .sort((a, b) => idIndex(a[0]) - idIndex(b[0]))
      .map(([, v]) => v);
    const raw = ordered.join("") + interimRef.current;
    const converted = (await toTraditional(raw)).trim();
    setText(converted);
    void emit("voicetyping://text", { text: converted });
  };

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    void listen<SegPayload>("transcript://segment", (e) => {
      const p = e.payload;
      if (p.source !== "voice-typing") return;
      if (p.is_final) {
        finalsRef.current.set(p.id, p.text);
        interimRef.current = ""; // the committed run supersedes the tail
      } else {
        interimRef.current = p.text;
      }
      void publish.current();
    }).then((u) => unsubs.push(u));

    void listen<LevelPayload>("audio://level", (e) => {
      if (e.payload.source !== "voice-typing") return;
      const v = Math.min(1, Math.sqrt(Math.max(0, e.payload.level)));
      setBars((prev) => {
        const next = prev.slice(1);
        next.push(BAR_FLOOR + v * (1 - BAR_FLOOR));
        return next;
      });
    }).then((u) => unsubs.push(u));

    void listen<SessionPayload>("voicetyping://session", (e) => {
      const { phase: p, message } = e.payload;
      if (p === "start") {
        finalsRef.current.clear();
        interimRef.current = "";
        setText("");
        setError(null);
        setPhase("listening");
      } else if (p === "stop") {
        setPhase("finalizing");
      } else if (p === "done") {
        setPhase("done");
      } else if (p === "error") {
        setError(message === "no-key" ? "noKey" : "error");
        setPhase("done");
      }
    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());
  }, []);

  // Let the waveform settle back to the floor when not actively listening.
  useEffect(() => {
    if (phase === "listening") return;
    const id = window.setInterval(() => {
      setBars((prev) => prev.map((b) => Math.max(BAR_FLOOR, b * 0.8)));
    }, 90);
    return () => window.clearInterval(id);
  }, [phase]);

  const bubble = error ? t(error === "noKey" ? "voiceTyping.noKey" : "voiceTyping.error") : text;

  return (
    <div className="flex h-screen w-screen select-none flex-col items-center justify-end gap-2 pb-4">
      {/* Layer 1 — transcript. Inverted theme colours (foreground bg / background
          text) for high contrast against whatever's behind the overlay. */}
      {bubble && (
        <div
          className={`max-w-[420px] rounded-[14px] px-3.5 py-1.5 text-center text-[14px] font-medium leading-snug shadow-md ${
            error ? "bg-red-600 text-white" : "bg-foreground text-background"
          }`}
        >
          {bubble}
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
          {phase === "finalizing" ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : phase === "done" ? (
            <Check className="size-2.5" strokeWidth={3} />
          ) : (
            <Mic className="size-2.5" />
          )}
        </div>
        <div className="flex h-4 items-center gap-[2px]">
          {bars.map((b, i) => (
            <span
              key={i}
              className="w-[2px] rounded-full bg-sky-500"
              style={{ height: `${Math.max(2, Math.round(b * 16))}px` }}
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
}
