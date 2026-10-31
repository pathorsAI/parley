import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, RotateCcw, Square } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import * as ipc from "../../lib/ipc/commands";
import {
  MIC_CHECK_ERROR_EVENT,
  STT_CLOSED_EVENT,
  TRANSCRIPT_SEGMENT_EVENT,
  listenEvent,
} from "../../lib/ipc/events";
import { prepareTranscription } from "../../lib/transcription/prepare";
import { blockMessageKey, failureMessageKey } from "../../lib/transcription/errors";
import { normalizeTranscriptText } from "../../lib/textNormalize";
import {
  CheckTranscript,
  MIC_CHECK_MAX_MS,
  MIC_CHECK_SOURCE,
  addTerms,
  completeIntro,
  fixProductName,
  profileFill,
  summarizeIntro,
  withProductName,
  undoMicRun,
  type AddedTerm,
  type MicRun,
} from "../../lib/onboarding/micCheck";
import { removeEntry } from "../../lib/dictionary";
import { appendBackground } from "../../lib/onboarding/memoryImport";
import { WaveformTrack } from "./WaveformTrack";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DEFAULT_DEVICE = "__default__";
/** After Stop, how long to wait for the provider's last words before using what arrived. */
const CLOSE_WAIT_MS = 4000;

type Phase = "idle" | "listening" | "stopping" | "saving" | "saved" | "empty" | "error";

/**
 * The microphone check: pick the input, read one self-introduction, watch it
 * transcribe live. It runs the configured STT provider end to end
 * (start_mic_check), so a key or session that doesn't work shows up here, not
 * in the first meeting; and the sentence becomes the first line of the
 * speaker background, the user's name and company (when Settings has none),
 * and dictionary terms (handed up through `onTermsAdded` so the context step
 * can list them).
 */
export function MicStep({
  onTermsAdded,
  onTermsRemoved,
  lastRun,
}: Readonly<{
  onTermsAdded: (terms: AddedTerm[]) => void;
  onTermsRemoved: (ids: string[]) => void;
  /** What the previous check put into the setup (kept by the wizard, so it
   *  outlives leaving the step); a new check takes it back out first. */
  lastRun: React.MutableRefObject<MicRun | null>;
}>) {
  const { t } = useI18n();
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const patch = useStore((s) => s.updateSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const desktop = isTauri();

  // One run's listeners and timers; `run.current` is null when nothing runs.
  const run = useRef<{
    transcript: CheckTranscript;
    unlisten: (() => void)[];
    timers: ReturnType<typeof setTimeout>[];
    closed: () => void;
    live: boolean;
  } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    if (!desktop) return;
    ipc
      .listInputDevices()
      .then(setDevices)
      .catch((e) => log.warn("onboarding: list input devices failed", { error: String(e) }));
  }, [desktop]);

  // Leaving the step mid-sentence is the same as pressing Stop: the check ends
  // and what was said is still saved (background, profile, terms), so Next
  // never throws a self-introduction away. A run already stopping finishes on
  // its own.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (run.current?.live) {
        stop().catch((e) => log.warn("onboarding: stopping the mic check on leave failed", { error: String(e) }));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    const r = run.current;
    run.current = null;
    if (!r) return;
    r.unlisten.forEach((u) => u());
    r.timers.forEach(clearTimeout);
  }

  async function showText(raw: string) {
    const shown = fixProductName(await normalizeTranscriptText(raw));
    if (mounted.current) setText(shown);
    return shown;
  }

  /** Testing again replaces the previous result rather than adding to it. */
  function undoLastRun() {
    const last = lastRun.current;
    if (!last) return;
    lastRun.current = null;
    patch(undoMicRun(useStore.getState().settings, last));
    for (const id of last.created) removeEntry(id);
    if (last.terms.length > 0) onTermsRemoved(last.terms);
  }

  async function start() {
    teardown();
    undoLastRun();
    setText("");
    setError("");
    const settings = useStore.getState().settings;
    const gate = prepareTranscription("voiceTyping", settings);
    const prepared = gate instanceof Promise ? await gate : gate;
    if (!prepared.ok) {
      setError(t(blockMessageKey("voiceTyping", prepared.code)));
      setPhase("error");
      return;
    }
    const { request } = prepared;
    const transcript = new CheckTranscript();
    const r = {
      transcript,
      unlisten: [] as (() => void)[],
      timers: [] as ReturnType<typeof setTimeout>[],
      closed: () => {},
      live: true,
    };
    run.current = r;
    // Listeners first, so no segment of this run is missed; a listener that
    // resolves after the run was replaced unsubscribes at once.
    const own = (p: Promise<() => void>) =>
      p.then((u) => {
        if (run.current === r) r.unlisten.push(u);
        else u();
      });
    await Promise.all([
      own(
        listenEvent(TRANSCRIPT_SEGMENT_EVENT, (e) => {
          if (run.current !== r || !transcript.accept(e.payload)) return;
          showText(transcript.text()).catch(() => {});
        }),
      ),
      own(
        listenEvent(STT_CLOSED_EVENT, (e) => {
          if (run.current === r && e.payload.source === MIC_CHECK_SOURCE) r.closed();
        }),
      ),
      own(
        listenEvent(MIC_CHECK_ERROR_EVENT, (e) => {
          if (run.current !== r) return;
          r.live = false;
          teardown();
          setError(t(failureMessageKey("voiceTyping", e.payload.code)));
          setPhase("error");
        }),
      ),
    ]);
    if (run.current !== r) return;
    setPhase("listening");
    try {
      await ipc.startMicCheck({
        provider: request.provider,
        apiKey: request.apiKey,
        model: request.model,
        languageHints: request.languageHints,
        inputDevice: settings.inputDevice || null,
        relayUrl: request.relayUrl,
        vocabulary: withProductName(request.vocabulary),
      });
    } catch (e) {
      r.live = false;
      teardown();
      setError(t("onboarding.mic.failed", { error: String(e) }));
      setPhase("error");
      return;
    }
    // A self-introduction takes seconds; don't keep the mic (or a paid stream) open.
    r.timers.push(setTimeout(() => void stop(), MIC_CHECK_MAX_MS));
  }

  async function stop() {
    const r = run.current;
    if (!r || !r.live) return;
    r.live = false;
    if (mounted.current) setPhase("stopping");
    // Wait for the provider to flush its last words (stt://closed), bounded.
    const flushed = new Promise<void>((resolve) => {
      r.closed = resolve;
      r.timers.push(setTimeout(resolve, CLOSE_WAIT_MS));
    });
    await ipc.stopMicCheck();
    await flushed;
    if (run.current !== r) return;
    teardown();
    await finish(r.transcript);
  }

  async function finish(transcript: CheckTranscript) {
    // Runs to the end even after the step unmounted (see the leave effect);
    // only the on-screen state is skipped then.
    const said = await showText(transcript.text());
    if (!said.trim()) {
      if (mounted.current) setPhase("empty");
      return;
    }
    if (mounted.current) setPhase("saving");
    const settings = useStore.getState().settings;
    const summary = await summarizeIntro({ settings, transcript: said }).catch((e) => {
      // The sentence itself still makes a background line.
      log.warn("onboarding: summarizing the self-introduction failed", { error: String(e) });
      return { background: [said], terms: [], name: "", company: "", role: "" };
    });
    // The company and name always become terms, model or not.
    const intro = completeIntro(summary, said);
    const current = useStore.getState().settings;
    const appended = appendBackground(current.userBackground, intro.background);
    const profile = profileFill(current, intro);
    patch({ userBackground: appended.text, ...profile });
    const added = await addTerms(intro.terms).catch((e) => {
      log.warn("onboarding: adding self-introduction terms failed", { error: String(e) });
      return [];
    });
    lastRun.current = {
      lines: appended.lines,
      profile,
      created: added.filter((term) => term.created).map((term) => term.id),
      terms: added.map((term) => term.id),
    };
    if (added.length > 0) onTermsAdded(added);
    if (mounted.current) setPhase("saved");
  }

  const busy = phase === "listening" || phase === "stopping" || phase === "saving";

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.mic.body")}</p>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-[#333] dark:text-foreground">{t("onboarding.mic.device")}</span>
        <Select
          value={inputDevice || DEFAULT_DEVICE}
          disabled={!desktop || busy}
          onValueChange={(v) => patch({ inputDevice: v === DEFAULT_DEVICE ? "" : v })}
        >
          <SelectTrigger className="h-10 w-full rounded-[8px] border-[#dadee5] dark:border-input">
            <SelectValue placeholder={t("settings.transcription.systemDefault")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_DEVICE}>{t("settings.transcription.systemDefault")}</SelectItem>
            {devices.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-[#333] dark:text-foreground">{t("onboarding.mic.introLabel")}</span>
        <div className="relative flex flex-col gap-4 overflow-hidden rounded-[8px] border border-[#e3e6ec] bg-background p-5 dark:border-border">
          {/* The line art steps back while the user speaks, so the waveform reads first. */}
          <div
            aria-hidden
            className={cn(
              "ob-transition pointer-events-none absolute top-[-5px] left-[-8px] h-[116.52px] w-[774.18px]",
              phase === "listening" && "opacity-70",
            )}
          >
            <img src="/onboarding/org-solo-lines.svg" alt="" className="size-full max-w-none" />
          </div>

          <p className="relative rounded-[10px] bg-[#f5f5f5] px-3 py-2.5 text-[13px] leading-[21.125px] text-[#333] dark:bg-muted dark:text-foreground">
            <ScriptLine template={t("onboarding.mic.script")} />
          </p>

          <div className="relative flex items-center gap-2.5">
            {phase === "listening" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-auto gap-1.5 rounded-[8px] border-[#e3e6ec] bg-background px-2.5 py-2 text-sm font-medium text-recording hover:text-recording dark:border-border"
                onClick={() => void stop()}
              >
                <Square className="size-3.5 fill-current" />
                {t("onboarding.mic.stop")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-auto gap-1.5 rounded-[8px] border-[#e3e6ec] bg-background px-2.5 py-2 text-sm font-medium text-primary hover:text-primary dark:border-border"
                disabled={!desktop || busy}
                onClick={() => {
                  start().catch((e) => {
                    log.warn("onboarding: mic check failed to start", { error: String(e) });
                    setError(t("onboarding.mic.failed", { error: String(e) }));
                    setPhase("error");
                  });
                }}
              >
                {phase === "idle" ? <Mic className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                {phase === "idle" ? t("onboarding.mic.start") : t("onboarding.mic.retry")}
              </Button>
            )}
            <WaveformTrack source={MIC_CHECK_SOURCE} running={phase === "listening"} className="h-9 flex-1" />
          </div>

          {text && (
            <p className="relative text-[15px] leading-relaxed">
              {text}
              {phase === "listening" && <span className="ob-blink ml-0.5 text-primary">▍</span>}
            </p>
          )}

          <MicStatus phase={phase} error={error} />
        </div>
      </div>
      {!desktop && <p className="text-[11px] text-muted-foreground">{t("onboarding.mic.desktopOnly")}</p>}
    </div>
  );
}

/** The script to read, its blanks ({company}…) greyed out between braces, as drawn. */
function ScriptLine({ template }: Readonly<{ template: string }>) {
  const { t } = useI18n();
  const blanks: Record<string, TranslationKey> = {
    company: "onboarding.mic.script.company",
    role: "onboarding.mic.script.role",
    purpose: "onboarding.mic.script.purpose",
  };
  return (
    <>
      {template.split(/(\{\w+\})/).map((part, i) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const key = name ? blanks[name] : undefined;
        if (!key) return part;
        return (
          // The template's parts never reorder, so the index is a stable key.
          <span key={`${name}-${i}`}>
            {"{"}
            <span className="text-[#333]/50 dark:text-muted-foreground">{t(key)}</span>
            {"}"}
          </span>
        );
      })}
    </>
  );
}

function MicStatus({ phase, error }: Readonly<{ phase: Phase; error: string }>) {
  const { t } = useI18n();
  switch (phase) {
    case "listening":
      return <p className="text-[11px] text-muted-foreground">{t("onboarding.mic.listening")}</p>;
    case "stopping":
    case "saving":
      return (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t("onboarding.mic.saving")}
        </p>
      );
    case "saved":
      return (
        <p className="flex items-center gap-1.5 text-[11px] text-success-foreground">
          <Check className="size-3" />
          {t("onboarding.mic.saved")}
        </p>
      );
    case "empty":
      return <p className="text-[11px] text-muted-foreground">{t("onboarding.mic.empty")}</p>;
    case "error":
      return <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">{error}</p>;
    default:
      return null;
  }
}
