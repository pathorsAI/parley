import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { PrepPlan } from "../../lib/ai/prep";
import { SectionTitle } from "./bits";

/**
 * The drafted plan, rendered as things you can TAKE rather than prose you read.
 *
 * A markdown battle plan is not what anyone opens mid-call — the agenda is. So
 * every line here has a "+" that turns it into an agenda item the live coach
 * ticks off, and the negotiation setup lands in the same store fields the
 * analysis prompts already read.
 */
export function PlanCard({ plan }: Readonly<{ plan: PrepPlan }>) {
  const { t } = useI18n();
  const addTodo = useStore((s) => s.addTodo);
  const setField = useStore((s) => s.setNegotiationField);
  const [taken, setTaken] = useState<Set<string>>(new Set());

  function take(text: string) {
    if (taken.has(text)) return;
    addTodo(text);
    setTaken((s) => new Set(s).add(text));
  }

  function takeAll(items: string[]) {
    const fresh = items.filter((x) => !taken.has(x));
    if (!fresh.length) return;
    fresh.forEach((x) => addTodo(x));
    setTaken((s) => {
      const next = new Set(s);
      fresh.forEach((x) => next.add(x));
      return next;
    });
    toast.success(t("preflight.copilot.tookAgenda", { n: fresh.length }));
  }

  const pathItems = plan.idealPath.map((s) => s.move);

  return (
    <div className="flex flex-col gap-3.5 rounded-lg border bg-muted/25 px-3 py-2.5">
      {plan.agenda.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <SectionTitle>{t("preflight.copilot.plan.agenda")}</SectionTitle>
            <button
              type="button"
              onClick={() => takeAll(plan.agenda)}
              className="cursor-pointer text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("preflight.copilot.takeAll")}
            </button>
          </div>
          {plan.agenda.map((item) => (
            <TakeRow key={item} text={item} taken={taken.has(item)} onTake={() => take(item)} />
          ))}
        </section>
      )}

      {plan.idealPath.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <SectionTitle>{t("preflight.copilot.plan.path")}</SectionTitle>
            <button
              type="button"
              onClick={() => takeAll(pathItems)}
              className="cursor-pointer text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("preflight.copilot.takeAll")}
            </button>
          </div>
          {plan.idealPath.map((step, i) => (
            <TakeRow
              key={step.move}
              index={i + 1}
              text={step.move}
              hint={step.why}
              taken={taken.has(step.move)}
              onTake={() => take(step.move)}
            />
          ))}
        </section>
      )}

      {plan.edgeCases.length > 0 && (
        <section className="flex flex-col gap-1">
          <SectionTitle>{t("preflight.copilot.plan.edges")}</SectionTitle>
          {plan.edgeCases.map((e) => (
            <TakeRow
              key={e.trigger}
              text={e.trigger}
              hint={`→ ${e.move}`}
              lead="⚡"
              taken={taken.has(`${e.trigger} → ${e.move}`)}
              onTake={() => take(`${e.trigger} → ${e.move}`)}
            />
          ))}
        </section>
      )}

      <section className="flex flex-col gap-1 border-t pt-2.5">
        <SectionTitle>{t("preflight.copilot.plan.setup")}</SectionTitle>
        <SetupRow
          label={t("analyze.targetLabel")}
          value={plan.target}
          onFill={() => setField("meetingTarget", plan.target)}
        />
        <SetupRow
          label={t("analyze.batnaLabel")}
          value={plan.batna}
          onFill={() => setField("meetingBatna", plan.batna)}
        />
        <SetupRow
          label={t("analyze.floorLabel")}
          value={plan.floor}
          onFill={() => setField("meetingFloor", plan.floor)}
        />
      </section>
    </div>
  );
}

function TakeRow({
  text,
  hint,
  index,
  lead,
  taken,
  onTake,
}: Readonly<{
  text: string;
  hint?: string;
  index?: number;
  lead?: string;
  taken: boolean;
  onTake: () => void;
}>) {
  const { t } = useI18n();
  const marker = index ? `${index}` : lead;
  return (
    <div className="group flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-background/70">
      {marker && (
        <span className="mt-px w-3 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
          {marker}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={`text-xs leading-snug ${taken ? "text-muted-foreground line-through" : ""}`}>
          {text}
        </span>
        {hint && <span className="text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </div>
      <button
        type="button"
        title={t("preflight.review.addToAgenda")}
        aria-label={t("preflight.review.addToAgenda")}
        disabled={taken}
        onClick={onTake}
        className="mt-px shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-default disabled:opacity-100"
      >
        {taken ? <Check className="size-3.5 text-emerald-500" /> : <Plus className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * One negotiation field. An EMPTY value is shown, not hidden: the model is told
 * to leave BATNA and the bottom line blank rather than invent them, and saying
 * so out loud is the point — a silent omission reads as a bug, and a fabricated
 * number would feed the live negotiation scoring.
 */
function SetupRow({
  label,
  value,
  onFill,
}: Readonly<{ label: string; value: string; onFill: () => void }>) {
  const { t } = useI18n();
  const [filled, setFilled] = useState(false);
  if (!value) {
    return (
      <div className="flex items-baseline gap-2 px-1">
        <span className="w-16 shrink-0 text-[10px] text-muted-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground/70">
          {t("preflight.copilot.plan.noGuess")}
        </span>
      </div>
    );
  }
  return (
    <div className="group flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-background/70">
      <span className="mt-px w-16 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 text-xs leading-snug ${filled ? "text-muted-foreground" : ""}`}>
        {value}
      </span>
      <button
        type="button"
        disabled={filled}
        onClick={() => {
          onFill();
          setFilled(true);
        }}
        className="shrink-0 cursor-pointer text-[10px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:cursor-default disabled:no-underline"
      >
        {filled ? t("preflight.copilot.filled") : t("preflight.copilot.fill")}
      </button>
    </div>
  );
}
