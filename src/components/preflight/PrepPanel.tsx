import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Square, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, activeClaims } from "../../lib/accounts/store";
import { composeBrief } from "../../lib/accounts/brief";
import { hasProviderKey } from "../../lib/ai/settings";
import type { PrepDraft } from "../../lib/ai/prepDraft";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMeetingSetup } from "./useMeetingSetup";
import { Column, SectionTitle } from "./bits";

/**
 * Pre-flight column ③: what THIS call has to come back with.
 *
 * Draft-and-correct, not fill-in-the-blank (#189). 目標 / BATNA / 底線 / 議程
 * are CONCLUSIONS — asking for them in empty inputs asks the user to have
 * finished thinking before the screen that exists to help them think, so the
 * column got skipped wholesale. 幫我起草 reads the claim base and the stage's
 * gap board (both already on screen in column ②) and proposes all four; the
 * user picks and edits. The fields themselves stay: every analysis prompt and
 * the BATNA evaluation read them — what changes is who fills them first.
 */
export function PrepPanel() {
  const { t, language } = useI18n();
  const acc = useAccounts();
  const { company, thread, scenario, stageId, attendees, claims, rows } = useMeetingSetup();

  const threadId = useStore((s) => s.meetingThreadId);
  const context = useStore((s) => s.meetingContext);
  const setMeetingContext = useStore((s) => s.setMeetingContext);
  const target = useStore((s) => s.meetingTarget);
  const batna = useStore((s) => s.meetingBatna);
  const floor = useStore((s) => s.meetingFloor);
  const setField = useStore((s) => s.setNegotiationField);
  const todos = useStore((s) => s.todos);
  const addTodo = useStore((s) => s.addTodo);
  const toggleTodo = useStore((s) => s.toggleTodo);
  const removeTodo = useStore((s) => s.removeTodo);

  const [entry, setEntry] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [draft, setDraft] = useState<PrepDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  // The negotiation setup opens by itself once there is something in it —
  // otherwise a drafted BATNA would land inside a closed section.
  const [advOpen, setAdvOpen] = useState(false);
  // Candidates step aside once a goal is chosen; this brings them back.
  const [goalsOpen, setGoalsOpen] = useState(true);

  /** Assemble the deterministic pre-meeting brief into the context field. */
  function writeBrief() {
    if (!company) return;
    const brief = composeBrief({
      language,
      company,
      thread,
      attendees,
      claims: activeClaims(acc, company.id).filter(
        (c) => !threadId || !c.threadId || c.threadId === threadId
      ),
    });
    useStore.getState().setMeetingContext(brief);
    setConfirmOverwrite(false);
    toast.success(t("accounts.link.composed"));
  }

  function requestBrief() {
    // Hand-written context is user work — a real confirm gate, not a button
    // that quietly changes colour for four seconds.
    if (useStore.getState().meetingContext.trim()) setConfirmOverwrite(true);
    else writeBrief();
  }

  async function runDraft() {
    if (!company || !scenario || !stageId || drafting) return;
    const settings = useStore.getState().settings;
    if (!hasProviderKey(settings, "deep")) {
      toast.error(t("preflight.prep.draftNoKey"));
      return;
    }
    setDrafting(true);
    try {
      const bundle = scenario.bundles[stageId];
      const { draftPrep } = await import("../../lib/ai/prepDraft");
      const result = await draftPrep({
        settings,
        input: {
          company,
          thread,
          attendees,
          claims,
          stageName: scenario.names[stageId] ?? stageId,
          stageGoal: bundle?.goal ?? "",
          exitCriteria: bundle?.exitCriteria ?? [],
          gaps: rows.map((r) => ({
            label: r.slot.label,
            hint: r.slot.hint,
            state: r.state,
          })),
          context,
        },
      });
      setDraft(result);
      setGoalsOpen(true);
      if (result.batna || result.floor) setAdvOpen(true);
    } catch (e) {
      log.error("preflight: draft failed", { error: String(e) });
      toast.error(t("preflight.prep.draftFailed"));
    } finally {
      setDrafting(false);
    }
  }

  /** Take a suggestion out of the draft once it has been accepted. */
  function consume(key: "goals" | "agenda" | "objections", text: string) {
    setDraft((d) => (d ? { ...d, [key]: d[key].filter((x) => x !== text) } : d));
  }

  /** Add a todo unless the exact line is already on the agenda. */
  function addAgendaLine(text: string): boolean {
    if (useStore.getState().todos.some((x) => x.text === text)) return false;
    addTodo(text);
    return true;
  }

  const done = todos.filter((x) => x.done).length;
  const goalPicked = target.trim().length > 0;
  const showGoals = !!draft?.goals.length && (!goalPicked || goalsOpen);
  const setupFilled = [batna, floor].filter((x) => x.trim()).length;

  return (
    <Column step="③" title={t("preflight.prep.title")}>
      <div className="flex flex-col gap-4">
        {/* The way in. Everything below can be produced from what the app
            already knows, so the first control offers to do exactly that. */}
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            className="h-8 justify-start"
            disabled={!company || !scenario || drafting}
            onClick={() => void runDraft()}
          >
            {drafting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
            {drafting
              ? t("preflight.prep.drafting")
              : draft
                ? t("preflight.prep.redraft")
                : t("preflight.prep.draft")}
          </Button>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {company ? t("preflight.prep.draftHint") : t("preflight.prep.draftNeedsCompany")}
          </p>
        </div>

        {/* 目標 — the one line that is genuinely the user's to write. */}
        <div className="flex flex-col gap-1.5">
          <SectionTitle>{t("preflight.prep.goal")}</SectionTitle>
          <Textarea
            rows={2}
            value={target}
            onChange={(e) => setField("meetingTarget", e.target.value)}
            placeholder={t("preflight.prep.goalPlaceholder")}
            className="resize-none text-xs"
          />
          {showGoals && (
            <div className="flex flex-col gap-1">
              {draft?.goals.map((g) => (
                <Suggest
                  key={g}
                  text={g}
                  onAccept={() => {
                    setField("meetingTarget", g);
                    consume("goals", g);
                    setGoalsOpen(false);
                  }}
                />
              ))}
            </div>
          )}
          {!!draft?.goals.length && goalPicked && !goalsOpen && (
            <button
              type="button"
              onClick={() => setGoalsOpen(true)}
              className="cursor-pointer self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("preflight.prep.otherGoals", { n: draft.goals.length })}
            </button>
          )}
        </div>

        {/* 背景 — the paste box. */}
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <SectionTitle>{t("analyze.contextLabel")}</SectionTitle>
          <Textarea
            rows={5}
            value={context}
            onChange={(e) => setMeetingContext(e.target.value)}
            placeholder={t("meeting.contextPlaceholder")}
            className="max-h-48 resize-none overflow-y-auto text-xs"
          />
          {company && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 self-start text-xs"
              onClick={requestBrief}
            >
              <Wand2 className="size-3.5" />
              {t("accounts.link.compose")}
            </Button>
          )}
        </div>

        {/* 議程 — actions, checked off live during the call. */}
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <div className="flex items-baseline gap-2">
            <SectionTitle>{t("preflight.prep.agenda")}</SectionTitle>
            <span className="text-[10px] text-muted-foreground">
              {todos.length > 0
                ? t("todos.doneCount", { done, total: todos.length })
                : t("todos.noItems")}
            </span>
          </div>

          {todos.length === 0 && !draft?.agenda.length && (
            <p className="rounded-md border border-dashed px-2.5 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("preflight.prep.agendaEmpty")}
            </p>
          )}
          {todos.map((todo) => (
            <div
              key={todo.id}
              className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50"
            >
              <button
                type="button"
                aria-label={todo.text}
                onClick={() => toggleTodo(todo.id)}
                className="mt-0.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                {todo.done ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Square className="size-4" />
                )}
              </button>
              <span
                className={`min-w-0 flex-1 text-xs leading-snug ${
                  todo.done ? "text-muted-foreground line-through" : ""
                }`}
              >
                {todo.text}
              </span>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => removeTodo(todo.id)}
                className="shrink-0 cursor-pointer text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}

          {!!draft?.agenda.length && (
            <div className="flex flex-col gap-1 pt-0.5">
              {draft.agenda.map((a) => (
                <Suggest
                  key={a}
                  text={a}
                  onAccept={() => {
                    addAgendaLine(a);
                    consume("agenda", a);
                  }}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  const lines = draft.agenda;
                  let n = 0;
                  for (const a of lines) if (addAgendaLine(a)) n++;
                  setDraft((d) => (d ? { ...d, agenda: [] } : d));
                  toast.success(t("accounts.link.seeded", { n }));
                }}
                className="cursor-pointer self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {t("preflight.prep.acceptAll")}
              </button>
            </div>
          )}

          <form
            className="flex items-center gap-1.5 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              addTodo(entry);
              setEntry("");
            }}
          >
            <Input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder={t("todos.addPlaceholder")}
              className="h-7 text-xs"
            />
            <Button type="submit" size="icon" className="size-7 shrink-0" disabled={!entry.trim()}>
              <Plus className="size-4" />
            </Button>
          </form>
        </div>

        {/* 可能的反對 — only ever drafted, never a blank field. */}
        {!!draft?.objections.length && (
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <SectionTitle>{t("preflight.prep.objections")}</SectionTitle>
            {draft.objections.map((o) => (
              <Suggest
                key={o}
                text={o}
                onAccept={() => {
                  addAgendaLine(t("preflight.prep.objectionTodo", { text: o }));
                  consume("objections", o);
                }}
              />
            ))}
            <p className="text-[10px] text-muted-foreground">
              {t("preflight.prep.objectionsHint")}
            </p>
          </div>
        )}

        {/* BATNA / 底線 — kept, because the analysis and the BATNA evaluation
            read them; demoted, because nobody can type them cold. */}
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            className="flex cursor-pointer items-center gap-1.5 text-left"
          >
            {advOpen ? (
              <ChevronDown className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 text-muted-foreground" />
            )}
            <SectionTitle>{t("preflight.prep.setup")}</SectionTitle>
            <span className="text-[10px] text-muted-foreground">
              {setupFilled > 0
                ? t("preflight.prep.setupFilled", { n: setupFilled })
                : t("preflight.prep.setupEmpty")}
            </span>
          </button>

          {advOpen && (
            <div className="flex flex-col gap-2">
              <SetupField
                label={t("analyze.batnaLabel")}
                value={batna}
                placeholder={t("analyze.batnaPlaceholder")}
                onChange={(v) => setField("meetingBatna", v)}
                suggestion={draft?.batna}
                onAccept={() => {
                  if (draft?.batna) setField("meetingBatna", draft.batna);
                  setDraft((d) => (d ? { ...d, batna: "" } : d));
                }}
              />
              <SetupField
                label={t("analyze.floorLabel")}
                value={floor}
                placeholder={t("analyze.floorPlaceholder")}
                onChange={(v) => setField("meetingFloor", v)}
                suggestion={draft?.floor}
                onAccept={() => {
                  if (draft?.floor) setField("meetingFloor", draft.floor);
                  setDraft((d) => (d ? { ...d, floor: "" } : d));
                }}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("analyze.contextHint")}
              </p>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={confirmOverwrite} onOpenChange={setConfirmOverwrite}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("preflight.prep.overwriteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("preflight.prep.overwriteBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("accounts.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={writeBrief}>
              {t("preflight.prep.overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Column>
  );
}

/**
 * A drafted line the user has not taken yet. Dashed like an empty board slot —
 * same vocabulary, same meaning: proposed, not yet ours. The whole row is the
 * button, because a suggestion has exactly one thing you can do to it.
 */
function Suggest({ text, onAccept }: Readonly<{ text: string; onAccept: () => void }>) {
  return (
    <button
      type="button"
      onClick={onAccept}
      className="group flex w-full cursor-pointer items-start gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-left transition-colors hover:border-solid hover:bg-muted/50"
    >
      <Plus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      <span className="min-w-0 flex-1 text-xs leading-snug">{text}</span>
    </button>
  );
}

function SetupField({
  label,
  value,
  placeholder,
  onChange,
  suggestion,
  onAccept,
}: Readonly<{
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  suggestion?: string;
  onAccept: () => void;
}>) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
      {!!suggestion && !value.trim() && <Suggest text={suggestion} onAccept={onAccept} />}
    </div>
  );
}
