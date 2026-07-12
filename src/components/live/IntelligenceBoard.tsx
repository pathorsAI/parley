import { lazy, Suspense, useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useStore } from "../../lib/store";
import { runIntelExtraction } from "../../lib/intel/extract";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import type { MeetingType } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TodosPanel = lazy(() =>
  import("../sidebar/TodosPanel").then((m) => ({ default: m.TodosPanel }))
);
const StageBoard = lazy(() =>
  import("./StageBoard").then((m) => ({ default: m.StageBoard }))
);

const TYPES: MeetingType[] = ["general", "negotiation", "sales", "partnership"];
/** Re-extract cadence while recording (each run reads the full transcript). */
// Realtime lane is cheap and fast — refresh the board every 30s (was 90s).
const AUTO_EXTRACT_MS = 30_000;

/**
 * The LIVE right rail: accumulated STATE of the conversation. The meeting-type
 * picker selects the intelligence template — negotiation (numbers ledger,
 * concessions, agreed/open), sales (BANT, objections, commitments), partnership
 * (they-have × they-need, leverage proposals, give/get). "General" shows the
 * goals agenda only. Extraction re-runs on a slow cadence while recording, and
 * on demand via the refresh button.
 */
export function IntelligenceBoard() {
  const { t } = useI18n();
  const meetingType = useStore((s) => s.settings.meetingType);
  const updateSettings = useStore((s) => s.updateSettings);
  const intel = useStore((s) => s.intel);
  const intelStatus = useStore((s) => s.intelStatus);
  const recording = useStore((s) => s.meetingStatus === "recording");
  const running = intelStatus === "running";

  // Slow auto-extraction while a typed meeting is recording; immediate first
  // run on type switch so the board isn't empty for 90s.
  useEffect(() => {
    if (!recording || meetingType === "general") return;
    const run = () =>
      runIntelExtraction(meetingType, "realtime").catch((e) =>
        log.warn("intel: run failed", { error: String(e) })
      );
    run();
    const id = setInterval(run, AUTO_EXTRACT_MS);
    return () => clearInterval(id);
  }, [recording, meetingType]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("board.title")}
        </span>
        {meetingType !== "general" && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={running}
            title={t("board.refresh")}
            onClick={() => void runIntelExtraction(meetingType, "realtime")}
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        )}
      </div>

      {/* Meeting-type picker: which template this board runs. */}
      <div className="px-3 pb-2">
        <Select
          value={meetingType}
          onValueChange={(v) => updateSettings({ meetingType: v as MeetingType })}
        >
          <SelectTrigger className="h-7 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((v) => (
              <SelectItem key={v} value={v}>
                {t(`board.type.${v}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {meetingType === "general" ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <TodosPanel />
          </Suspense>
        </div>
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1 border-t">
            <div className="flex flex-col gap-3 px-3 py-2.5">
              {/* Sales: the stage gap board is the rail's primary block (S21). */}
              {meetingType === "sales" && (
                <Suspense fallback={null}>
                  <StageBoard />
                </Suspense>
              )}
              {!intel && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {running ? t("board.extracting") : t("board.empty")}
                </p>
              )}
              {intel?.meetingType === meetingType && <IntelSections />}
            </div>
          </ScrollArea>
          {/* Goals keep a slim home under the intel sections. */}
          <div className="h-[30%] min-h-24 shrink-0 border-t">
            <Suspense fallback={null}>
              <TodosPanel />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}

/** Render the populated sections of the current intel state. Exported for the
 *  study tense's 情報 page, which shows the same board over a loaded recording. */
export function IntelSections() {
  const { t } = useI18n();
  const intel = useStore((s) => s.intel);
  if (!intel) return null;

  return (
    <>
      {/* ── negotiation ─────────────────────────────── */}
      {intel.numbers && intel.numbers.length > 0 && (
        <Section title={t("board.sec.numbers")}>
          {intel.numbers.map((n, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">
                <b
                  className={
                    n.speaker === "me"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-sky-600 dark:text-sky-400"
                  }
                >
                  {n.value}
                </b>{" "}
                {n.context}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {n.speaker === "me" ? t("speaker.you") : t("speaker.them")}
              </span>
            </div>
          ))}
        </Section>
      )}
      {(intel.concessionsMe || intel.concessionsThem) &&
        ((intel.concessionsMe?.length ?? 0) > 0 || (intel.concessionsThem?.length ?? 0) > 0) && (
          <Section
            title={`${t("board.sec.concessions")} — ${t("speaker.you")} ${intel.concessionsMe?.length ?? 0}：${intel.concessionsThem?.length ?? 0} ${t("speaker.them")}`}
          >
            <List items={intel.concessionsMe} prefix="🫱" />
            <List items={intel.concessionsThem} prefix="🫲" />
          </Section>
        )}
      {intel.agreed && intel.agreed.length > 0 && (
        <Section title={t("board.sec.agreed")}>
          <List items={intel.agreed} prefix="✓" className="text-emerald-700 dark:text-emerald-400" />
        </Section>
      )}
      {intel.open && intel.open.length > 0 && (
        <Section title={t("board.sec.open")}>
          <List items={intel.open} prefix="○" className="text-amber-700 dark:text-amber-400" />
        </Section>
      )}

      {/* ── sales ───────────────────────────────────── */}
      {(intel.budget || intel.timeline || intel.decisionMaker) && (
        <Section title={t("board.sec.bant")}>
          {intel.budget && <KV k={t("board.sec.budget")} v={intel.budget} />}
          {intel.timeline && <KV k={t("board.sec.timeline")} v={intel.timeline} />}
          {intel.decisionMaker && <KV k={t("board.sec.decisionMaker")} v={intel.decisionMaker} />}
        </Section>
      )}
      {intel.objections && intel.objections.length > 0 && (
        <Section title={t("board.sec.objections")}>
          {intel.objections.map((o, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-xs">
              <span
                className={
                  o.addressed
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "font-bold text-amber-600 dark:text-amber-400"
                }
              >
                {o.addressed ? "✓" : "⚠"}
              </span>
              <span className={o.addressed ? "text-muted-foreground" : ""}>{o.text}</span>
            </div>
          ))}
        </Section>
      )}
      {intel.commitments && intel.commitments.length > 0 && (
        <Section title={t("board.sec.commitments")}>
          {intel.commitments.map((c, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              <b
                className={
                  c.who === "me"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-sky-600 dark:text-sky-400"
                }
              >
                {c.who === "me" ? t("speaker.you") : t("speaker.them")}
              </b>{" "}
              {c.what}
            </div>
          ))}
        </Section>
      )}
      {intel.competitors && intel.competitors.length > 0 && (
        <Section title={t("board.sec.competitors")}>
          <List items={intel.competitors} prefix="🚩" />
        </Section>
      )}

      {/* ── partnership ─────────────────────────────── */}
      {intel.theyHave && intel.theyHave.length > 0 && (
        <Section title={t("board.sec.theyHave")}>
          <List items={intel.theyHave} prefix="◆" className="text-sky-700 dark:text-sky-400" />
        </Section>
      )}
      {intel.theyNeed && intel.theyNeed.length > 0 && (
        <Section title={t("board.sec.theyNeed")}>
          <List items={intel.theyNeed} prefix="◇" />
        </Section>
      )}
      {intel.leverage && intel.leverage.length > 0 && (
        <Section title={t("board.sec.leverage")}>
          <List items={intel.leverage} prefix="💡" className="font-medium" />
        </Section>
      )}
      {(intel.give?.length || intel.get?.length) && (
        <Section title={t("board.sec.giveGet")}>
          <List items={intel.give} prefix="🫱" />
          <List items={intel.get} prefix="🫲" />
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function List({
  items,
  prefix,
  className,
}: Readonly<{ items?: string[]; prefix: string; className?: string }>) {
  if (!items?.length) return null;
  return (
    <>
      {items.map((x, i) => (
        <div key={i} className={`text-xs ${className ?? "text-muted-foreground"}`}>
          <span className="mr-1">{prefix}</span>
          {x}
        </div>
      ))}
    </>
  );
}

function KV({ k, v }: Readonly<{ k: string; v: string }>) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-10 shrink-0 text-muted-foreground">{k}</span>
      <b className="min-w-0 flex-1 leading-snug">{v}</b>
    </div>
  );
}
