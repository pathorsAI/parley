import { useState } from "react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import { composeBrief } from "../../lib/accounts/brief";
import { useStageSet } from "../../lib/accounts/useStageSet";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The accounts link INSIDE a running meeting (design §5.2): re-point the call
 * at a different company/thread, add someone who just joined, or pull the brief
 * in late. The same choices are made ahead of time on the pre-flight screen —
 * this is the mid-call amendment, not the main entry point.
 */
export function MeetingLinkSection() {
  const { t, language } = useI18n();
  const acc = useAccounts();
  const stageSet = useStageSet();
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const setMeetingLink = useStore((s) => s.setMeetingLink);

  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const companies = acc.companies.filter((c) => !c.archived);
  const company = companies.find((c) => c.id === companyId) ?? null;
  const persons = company ? personsOf(acc, company.id) : [];
  const threads = company ? threadsOf(acc, company.id).filter((x) => x.status === "active") : [];
  const thread = threads.find((x) => x.id === threadId) ?? null;

  function compose() {
    if (!company) return;
    const claims = activeClaims(acc, company.id).filter(
      (c) => !threadId || !c.threadId || c.threadId === threadId
    );
    const brief = composeBrief({
      language,
      company,
      thread,
      attendees: persons.filter((p) => attendeeIds.includes(p.id)),
      claims,
    });
    useStore.getState().setMeetingContext(brief);
    setConfirmOverwrite(false);
    toast.success(t("accounts.link.composed"));
  }

  /** Hand-written context is user work — gate the overwrite behind a real
   *  confirm rather than a button that briefly changes colour. */
  function requestCompose() {
    if (useStore.getState().meetingContext.trim()) setConfirmOverwrite(true);
    else compose();
  }

  function seedTodos() {
    if (!company) return;
    const state = useStore.getState();
    const existing = new Set(state.todos.map((x) => x.text));
    // This deal's open questions only (S17, closed for good by C): the stage's
    // collect items live on the board slots — todos carry ACTIONS, and copying
    // collect lines here was the last two-ledgers leak.
    const items = activeClaims(acc, company.id)
      .filter(
        (c) => c.category === "openq" && (!threadId || !c.threadId || c.threadId === threadId)
      )
      .map((c) => c.text);
    let n = 0;
    for (const text of items) {
      if (!text.trim() || existing.has(text)) continue;
      existing.add(text);
      state.addTodo(text);
      n++;
    }
    toast.success(t("accounts.link.seeded", { n }));
  }

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center gap-2">
        <label className="w-14 shrink-0 text-xs text-muted-foreground">
          {t("accounts.link.company")}
        </label>
        <Combobox
          size="sm"
          value={companyId ?? ""}
          groups={[
            {
              options: [
                { value: "", label: t("accounts.link.none") },
                ...companies.map((c) => ({ value: c.id, label: c.name })),
              ],
            },
          ]}
          onChange={(v) =>
            setMeetingLink({ companyId: v || null, threadId: null, attendeeIds: [] })
          }
          placeholder={t("accounts.link.none")}
          searchPlaceholder={t("preflight.search")}
          emptyText={t("preflight.noMatch")}
        />
      </div>

      {company && threads.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="w-14 shrink-0 text-xs text-muted-foreground">
            {t("accounts.link.thread")}
          </label>
          <Combobox
            size="sm"
            value={threadId ?? ""}
            groups={[
              {
                options: [
                  { value: "", label: t("accounts.link.none") },
                  ...threads.map((x) => ({
                    value: x.id,
                    label: x.name,
                    hint: x.stage ? (stageSet.names[x.stage] ?? x.stage) : undefined,
                  })),
                ],
              },
            ]}
            onChange={(v) => setMeetingLink({ companyId, threadId: v || null, attendeeIds })}
            placeholder={t("accounts.link.none")}
            searchPlaceholder={t("preflight.search")}
            emptyText={t("preflight.noMatch")}
          />
        </div>
      )}

      {company && persons.length > 0 && (
        <div className="flex items-start gap-2">
          <label className="w-14 shrink-0 pt-1 text-xs text-muted-foreground">
            {t("accounts.link.attendees")}
          </label>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {persons.map((p) => {
              const on = attendeeIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setMeetingLink({
                      companyId,
                      threadId,
                      attendeeIds: on
                        ? attendeeIds.filter((x) => x !== p.id)
                        : [...attendeeIds, p.id],
                    })
                  }
                  className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    on
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {company && (
        <div className="flex justify-end gap-2 pt-0.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={seedTodos}>
            {t("accounts.link.seedTodos")}
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={requestCompose}>
            {t("accounts.link.compose")}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmOverwrite} onOpenChange={setConfirmOverwrite}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("preflight.prep.overwriteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("preflight.prep.overwriteBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("accounts.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={compose}>
              {t("preflight.prep.overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
