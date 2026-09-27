import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { listLocalFolders } from "../../lib/history/folders";
import { beginMeeting } from "../../lib/meeting/start";
import { dismissGettingStarted } from "../../lib/onboarding/gettingStarted";
import { useLapContext, type LapPhase, type LapStep } from "../../lib/onboarding/lap";
import { copyHandoffPrompt, useHandoff } from "../../lib/onboarding/useHandoff";
import { clientLabel, useMcpActivity } from "../../lib/mcp/activity";
import { claudeCodeCommand, useMcpEndpoint } from "../../lib/mcp/connect";
import { modChordCap } from "../../lib/commands/format";
import { confettiBurst } from "../../lib/onboarding/motion";
import { CopyButton } from "../CopyButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Scroll an element of the (possibly just-mounted) page into view once it has
 *  rendered. A few frames of patience, then give up quietly. */
export function scrollToWhenRendered(elementId: string, framesLeft = 20): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(elementId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (framesLeft > 0) scrollToWhenRendered(elementId, framesLeft - 1);
  });
}

/**
 * The guided lap's voice on the study page: a slim bar under both the Report
 * and the Replay tab that says what to do next, three steps and a done card.
 * Visibility and the step come from LapContext (see lib/onboarding/lap.ts);
 * this component only renders them and routes the CTAs.
 *
 * It is a bar, not a card: a hairline on top, the page's own background, one
 * filled button at most. Blue is only on what can be clicked.
 */
export function GuideBar({ onOpenPicker }: Readonly<{ onOpenPicker: () => void }>) {
  const lap = useLapContext();
  const tab = useStore((s) => s.studyTab);
  const entryId = useStore((s) => s.loadedHistoryId);
  const name = useStore((s) => s.replay?.name ?? "");
  const folderId = useStore((s) => s.replayFolderId);

  // The name the recording had when it was opened, to tell "renamed" apart.
  const opened = useRef<{ id: string | null; name: string }>({ id: entryId, name });
  if (opened.current.id !== entryId) opened.current = { id: entryId, name };

  if (!lap.visible) return null;

  const folderName = folderId ? (listLocalFolders().find((f) => f.id === folderId)?.name ?? null) : null;
  const setTab = (next: "report" | "replay") => useStore.getState().setStudyTab(next);

  return (
    <GuideBarView
      phase={lap.phase}
      justCompleted={lap.justCompleted}
      tab={tab}
      folderName={folderName}
      renamed={name.trim() !== opened.current.name.trim()}
      onShowSuggestion={() => {
        setTab("report");
        // The card is gone once dismissed or spent — then the picker is the
        // way to choose a folder.
        if (useStore.getState().filingSuggestion) scrollToWhenRendered("filing-suggestion");
        else onOpenPicker();
      }}
      onOpenReplay={() => setTab("replay")}
      onShowHandoff={() => {
        setTab("report");
        scrollToWhenRendered("handoff");
      }}
      onDismiss={dismissGettingStarted}
      onClose={lap.close}
      onBegin={() => {
        lap.close();
        beginMeeting().catch((e) => {
          log.error("guide: start meeting failed", { error: String(e) });
          toast.error(String(e instanceof Error ? e.message : e));
        });
      }}
    />
  );
}

export interface GuideBarViewProps {
  phase: LapPhase;
  justCompleted: LapStep | null;
  tab: "report" | "replay";
  /** The open recording's folder, for the step-1 confirmation. */
  folderName: string | null;
  /** The recording's name changed since it was opened. */
  renamed: boolean;
  onShowSuggestion: () => void;
  onOpenReplay: () => void;
  onShowHandoff: () => void;
  onDismiss: () => void;
  onClose: () => void;
  onBegin: () => void;
}

/** The bar's markup for one state — pure props, so each step renders in tests. */
export function GuideBarView(props: Readonly<GuideBarViewProps>) {
  const { t } = useI18n();
  const { phase, justCompleted } = props;
  const state = justCompleted ? `${justCompleted}-done` : phase;

  let body: ReactNode;
  if (justCompleted) {
    body = <CheckLine>{confirmation(justCompleted, props, t)}</CheckLine>;
  } else if (phase === "filed") {
    body = (
      <Step
        label={t("lap.step1.label")}
        text={t("lap.step1.body")}
        cta={<PrimaryCta onClick={props.onShowSuggestion}>{t("lap.step1.cta")}</PrimaryCta>}
        onDismiss={props.onDismiss}
      />
    );
  } else if (phase === "replayed") {
    body = (
      <Step
        label={t("lap.step2.label")}
        text={t("lap.step2.body")}
        // Already on Replay, the transcript itself is the call to action.
        cta={
          props.tab === "replay" ? null : (
            <PrimaryCta onClick={props.onOpenReplay}>{t("lap.step2.cta")}</PrimaryCta>
          )
        }
        onDismiss={props.onDismiss}
      />
    );
  } else if (phase === "handedOff") {
    body = (
      <Step
        label={t("lap.step3.label")}
        text={t("study.handoff.mcpLead")}
        cta={<PrimaryCta onClick={props.onShowHandoff}>{t("lap.step3.cta")}</PrimaryCta>}
        onDismiss={props.onDismiss}
      >
        {/* The working parts only on the Report, where the hand-off section
            lives; over the transcript they would eat half the screen. */}
        {props.tab === "report" && <HandoffStep />}
      </Step>
    );
  } else {
    body = <DoneCard onClose={props.onClose} onBegin={props.onBegin} />;
  }

  return (
    <section
      aria-label={t("lap.region")}
      data-testid="guide-bar"
      data-lap={state}
      className="shrink-0 border-t border-border bg-background"
    >
      <div key={state} className="ob-rise mx-auto max-w-3xl px-5 py-3">
        {body}
      </div>
    </section>
  );
}

type T = ReturnType<typeof useI18n>["t"];

/** The ✓ line held for a moment after a step lands. */
function confirmation(step: LapStep, p: Readonly<GuideBarViewProps>, t: T): string {
  if (step === "filed") {
    if (p.folderName && p.renamed) return t("lap.step1.doneBoth", { folder: p.folderName });
    if (p.folderName) return t("lap.step1.doneFiled", { folder: p.folderName });
    // Filed somewhere this page can't name (an org folder, say).
    return t("home.gs.done");
  }
  // "handedOff" goes straight to the done card; only step 2 is left.
  return t("lap.step2.done", { shortcut: modChordCap("F") });
}

/** Delay between the done card's ✓ lines. */
const CASCADE_MS = 260;

/**
 * The finish: the three things the user just did land as ✓ lines, one after
 * another, then one burst of confetti inside the study page — once per
 * recording, never again.
 */
function DoneCard({ onClose, onBegin }: Readonly<{ onClose: () => void; onBegin: () => void }>) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const entryId = useStore((s) => s.loadedHistoryId);
  const lines = [t("lap.done.line1"), t("lap.done.line2"), t("lap.done.line3")];

  useEffect(() => {
    if (!entryId || celebrated.has(entryId)) return;
    const id = setTimeout(() => {
      celebrated.add(entryId);
      const bar = ref.current?.closest<HTMLElement>("[data-testid='guide-bar']") ?? null;
      confettiBurst(ref.current?.closest<HTMLElement>("[data-study-root]") ?? null, bar);
    }, CASCADE_MS * lines.length + 150);
    return () => clearTimeout(id);
  }, [entryId, lines.length]);

  return (
    <div ref={ref} className="flex items-start gap-3">
      <CheckMark />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold">{t("lap.done.title")}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
          {lines.map((line, i) => (
            <li
              key={line}
              className="ob-rise flex items-center gap-1.5 text-xs"
              style={{ animationDelay: `${i * CASCADE_MS}ms` }}
            >
              <Check className="size-3 text-success-foreground" strokeWidth={3} />
              {line}
            </li>
          ))}
        </ul>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("lap.done.body")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("common.close")}
        </button>
        <Button size="sm" className="h-8" onClick={onBegin}>
          {t("lap.done.cta")}
        </Button>
      </div>
    </div>
  );
}

/** Recordings whose lap has had its confetti this session. */
const celebrated = new Set<string>();

function CheckMark() {
  return (
    <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-success-foreground text-background">
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

function CheckLine({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p role="status" className="flex items-start gap-3 py-0.5 text-sm">
      <CheckMark />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

function Step({
  label,
  text,
  cta,
  onDismiss,
  children,
}: Readonly<{
  label: string;
  text: string;
  cta: ReactNode;
  onDismiss: () => void;
  children?: ReactNode;
}>) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {cta}
        <button
          type="button"
          onClick={onDismiss}
          title={t("lap.dismiss")}
          className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
          {t("lap.dismiss")}
        </button>
      </div>
    </div>
  );
}

function PrimaryCta({ onClick, children }: Readonly<{ onClick: () => void; children: ReactNode }>) {
  return (
    <Button size="sm" className="h-8" onClick={onClick}>
      {children}
      <ArrowRight data-icon="inline-end" />
    </Button>
  );
}

/** Step 3's working parts: the command to paste, whether Claude has connected,
 *  three questions to ask it, and the copy fallback for everyone else. */
function HandoffStep() {
  const { t } = useI18n();
  const endpoint = useMcpEndpoint();
  const { info } = useMcpActivity();
  const client = clientLabel(info?.client);
  const { mcpQuestions, canCopy } = useHandoff();
  const command = claudeCodeCommand(endpoint);

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-md bg-muted/60 py-0.5 pl-3 pr-0.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
          {command}
        </code>
        <CopyButton
          iconOnly
          value={command}
          title={t("settings.mcp.copyCommand")}
          className="size-7 shrink-0 text-muted-foreground"
        />
      </div>
      <p
        data-mcp-status={client ? "connected" : "waiting"}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            client ? "bg-success-foreground" : "animate-pulse bg-muted-foreground/40"
          )}
        />
        {client ? t("study.handoff.connected", { client }) : t("lap.step3.waiting")}
      </p>
      <ul className="flex flex-col">
        {mcpQuestions.map((q) => (
          <li key={q} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs" title={q}>
              {q}
            </span>
            <CopyButton
              iconOnly
              value={q}
              title={t("study.handoff.copyQuestion")}
              className="size-6 shrink-0 text-muted-foreground"
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!canCopy}
        onClick={() => void copyHandoffPrompt()}
        className="w-fit cursor-pointer text-xs text-primary underline-offset-2 transition-colors hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
      >
        {t("lap.step3.copyInstead")}
      </button>
    </div>
  );
}
