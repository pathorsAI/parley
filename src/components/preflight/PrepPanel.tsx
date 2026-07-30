import { useState } from "react";
import { Check, Plus, Square, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import { composeBrief } from "../../lib/accounts/brief";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MeetingContextField } from "../MeetingContextField";
import { Column, SectionTitle } from "./bits";

/**
 * Pre-flight column ③: what THIS call has to come back with — the free-text
 * background that feeds every analysis prompt, and the agenda the live coach
 * auto-checks off.
 */
export function PrepPanel() {
  const { t, language } = useI18n();
  const acc = useAccounts();
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const todos = useStore((s) => s.todos);
  const addTodo = useStore((s) => s.addTodo);
  const toggleTodo = useStore((s) => s.toggleTodo);
  const removeTodo = useStore((s) => s.removeTodo);

  const [draft, setDraft] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const company = acc.companies.find((c) => c.id === companyId) ?? null;

  /** Assemble the deterministic pre-meeting brief into the context field. */
  function writeBrief() {
    if (!company) return;
    const claims = activeClaims(acc, company.id).filter(
      (c) => !threadId || !c.threadId || c.threadId === threadId
    );
    const brief = composeBrief({
      language,
      company,
      thread: threadsOf(acc, company.id).find((x) => x.id === threadId) ?? null,
      attendees: personsOf(acc, company.id).filter((p) => attendeeIds.includes(p.id)),
      claims,
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

  const done = todos.filter((x) => x.done).length;

  return (
    <Column step="③" title={t("preflight.prep.title")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <MeetingContextField rows={5} />
          {company && (
            <Button size="sm" variant="outline" className="h-7 self-start text-xs" onClick={requestBrief}>
              <Wand2 className="size-3.5" />
              {t("accounts.link.compose")}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-3">
          <div className="flex items-baseline gap-2">
            <SectionTitle>{t("preflight.prep.agenda")}</SectionTitle>
            <span className="text-[10px] text-muted-foreground">
              {todos.length > 0
                ? t("todos.doneCount", { done, total: todos.length })
                : t("todos.noItems")}
            </span>
          </div>

          {todos.length === 0 && (
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

          <form
            className="flex items-center gap-1.5 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              addTodo(draft);
              setDraft("");
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("todos.addPlaceholder")}
              className="h-7 text-xs"
            />
            <Button type="submit" size="icon" className="size-7 shrink-0" disabled={!draft.trim()}>
              <Plus className="size-4" />
            </Button>
          </form>
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
