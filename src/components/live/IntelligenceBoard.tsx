import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useStore } from "../../lib/store";
import { runIntelExtraction } from "../../lib/intel/extract";
import { useScenarioSet } from "../../lib/accounts/useStageSet";
import type { Scenario } from "../../lib/accounts/bundles";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import type { IntelObjection, MeetingType } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScenarioBoard } from "./ScenarioBoard";
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
const TodosSection = lazy(() =>
  import("../sidebar/TodosPanel").then((m) => ({ default: m.TodosSection }))
);

/** Re-extract cadence while recording (each run reads the full transcript). */
// Realtime lane is cheap and fast — refresh the board every 30s (was 90s).
const AUTO_EXTRACT_MS = 30_000;

/**
 * The LIVE right rail (scenario system, 呼吸版): ONE header line — scenario
 * picker · stage chip (multi-stage scenarios only) · refresh — then the
 * scenario's slot board, the objection ledger, and the folded todo section.
 * "General" shows the goals agenda only. Picking a scenario also applies its
 * bound eval template, so the coach feed switches lenses with the board.
 */
export function IntelligenceBoard() {
  const { t } = useI18n();
  const meetingType = useStore((s) => s.settings.meetingType);
  const evalTemplates = useStore((s) => s.settings.evalTemplates);
  const updateSettings = useStore((s) => s.updateSettings);
  const meetingStage = useStore((s) => s.meetingStage);
  const setMeetingStage = useStore((s) => s.setMeetingStage);
  const intel = useStore((s) => s.intel);
  const intelStatus = useStore((s) => s.intelStatus);
  const recording = useStore((s) => s.meetingStatus === "recording");
  const running = intelStatus === "running";

  const scenarios = useScenarioSet();
  // A deleted custom scenario in settings degrades to "general", never crashes.
  const scenario: Scenario | null = scenarios.byId[meetingType] ?? null;

  // Slow auto-extraction while a typed meeting is recording; immediate first
  // run on scenario switch so the board isn't empty for 30s.
  useEffect(() => {
    if (!recording || !scenario) return;
    const run = () =>
      runIntelExtraction(scenario.id, "realtime").catch((e) =>
        log.warn("intel: run failed", { error: String(e) })
      );
    run();
    const id = setInterval(run, AUTO_EXTRACT_MS);
    return () => clearInterval(id);
  }, [recording, scenario]);

  function pickScenario(v: MeetingType) {
    const next = scenarios.byId[v];
    // Scenario-bound eval template rides along (when it exists) — the coach
    // feed's lens follows the board.
    const tpl = next?.evalTemplateId
      ? evalTemplates.find((x) => x.id === next.evalTemplateId)
      : undefined;
    updateSettings({
      meetingType: v,
      ...(tpl ? { evaluations: tpl.evals.map((e) => ({ ...e })) } : {}),
    });
  }

  const stage =
    scenario && meetingStage && scenario.order.includes(meetingStage)
      ? meetingStage
      : scenario?.order[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ONE header line: scenario · stage · refresh (呼吸版). */}
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-2">
        <Select value={scenario ? meetingType : "general"} onValueChange={pickScenario}>
          <SelectTrigger size="sm" className="h-7 w-auto min-w-0 gap-1 border-none bg-transparent px-1.5 text-xs font-medium shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="general">{t("board.type.general")}</SelectItem>
            {scenarios.list.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.icon} {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {scenario && scenario.order.length > 1 && stage && (
          <Select value={stage} onValueChange={(v) => setMeetingStage(v)}>
            <SelectTrigger size="sm" className="h-6 w-auto min-w-0 gap-1 rounded-full border px-2.5 text-[11px] text-muted-foreground shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scenario.order.map((s) => (
                <SelectItem key={s} value={s}>
                  {scenario.names[s] ?? s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="flex-1" />
        {scenario && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={running}
            title={t("board.refresh")}
            onClick={() => void runIntelExtraction(scenario.id, "realtime")}
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        )}
      </div>

      {!scenario ? (
        <div className="min-h-0 flex-1 border-t">
          <Suspense fallback={null}>
            <TodosPanel />
          </Suspense>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 border-t">
          <div className="flex flex-col gap-3 px-3 py-2.5">
            <ScenarioBoard scenario={scenario} />
            {/* The objection ledger is the ONE home of objection facts; the
                board's counter banner carries only the reply (A3). */}
            {intel?.meetingType === scenario.id && (
              <ObjectionsLedger objections={intel.objections} />
            )}
            {/* Todos ride the same rail (C): action items only, checked by the
                same 30s pass — folded to one line until opened (呼吸版). */}
            <Suspense fallback={null}>
              <TodosSection />
            </Suspense>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

/** The objection tracker (呼吸版): open items in front, answered ones folded
 *  behind a count — addressed state drives ⚠/✓. */
export function ObjectionsLedger({
  objections,
}: Readonly<{ objections?: IntelObjection[] }>) {
  const { t } = useI18n();
  const [showAddressed, setShowAddressed] = useState(false);
  if (!objections?.length) return null;
  const open = objections.filter((o) => !o.addressed);
  const addressed = objections.filter((o) => o.addressed);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {open.length > 0
            ? t("board.objections.open", { n: open.length })
            : t("board.objections.none")}
        </span>
        {addressed.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAddressed((x) => !x)}
            className="text-[10px] text-muted-foreground/70 hover:text-foreground"
          >
            {t("board.objections.addressed", { n: addressed.length })} {showAddressed ? "▴" : "▾"}
          </button>
        )}
      </div>
      {open.map((o, i) => (
        <div key={i} className="flex items-baseline gap-1.5 text-xs">
          <span className="font-bold text-amber-600 dark:text-amber-400">⚠</span>
          <span>{o.text}</span>
        </div>
      ))}
      {showAddressed &&
        addressed.map((o, i) => (
          <div key={i} className="flex items-baseline gap-1.5 text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">✓</span>
            <span className="text-muted-foreground">{o.text}</span>
          </div>
        ))}
    </div>
  );
}

/** LEGACY sections renderer — pre-C recordings persisted per-type fields
 *  (numbers ledger, BANT, they-have/they-need…). The study 情報 page still
 *  renders those entries; new recordings only carry `objections` here (the
 *  board slots hold everything else). */
export function IntelSections() {
  const { t } = useI18n();
  const intel = useStore((s) => s.intel);
  if (!intel) return null;

  return (
    <>
      {/* ── negotiation (legacy) ─────────────────────── */}
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

      {/* ── sales (legacy BANT + ledgers) ────────────── */}
      {(intel.budget || intel.timeline || intel.decisionMaker) && (
        <Section title={t("board.sec.bant")}>
          {intel.budget && <KV k={t("board.sec.budget")} v={intel.budget} />}
          {intel.timeline && <KV k={t("board.sec.timeline")} v={intel.timeline} />}
          {intel.decisionMaker && <KV k={t("board.sec.decisionMaker")} v={intel.decisionMaker} />}
        </Section>
      )}
      <ObjectionsLedger objections={intel.objections} />
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

      {/* ── partnership (legacy) ─────────────────────── */}
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
