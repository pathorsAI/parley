import { useState } from "react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import { composeBrief } from "../../lib/accounts/brief";
import { useStageSet } from "../../lib/accounts/useStageSet";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";

/**
 * The accounts link inside the meeting-context dialog (design §5.2): pick
 * company → thread → attendees, then compose the pre-meeting brief into the
 * context field and seed the checklist from the thread's open questions.
 * Rendered only for business meeting types (D12).
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
    // Hand-written context is user work — never silently overwrite it.
    if (useStore.getState().meetingContext.trim() && !confirmOverwrite) {
      setConfirmOverwrite(true);
      setTimeout(() => setConfirmOverwrite(false), 4000);
      return;
    }
    setConfirmOverwrite(false);
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
    toast.success(t("accounts.link.composed"));
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
        <select
          value={companyId ?? ""}
          onChange={(e) =>
            setMeetingLink({ companyId: e.target.value || null, threadId: null, attendeeIds: [] })
          }
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs"
        >
          <option value="">{t("accounts.link.none")}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {company && threads.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="w-14 shrink-0 text-xs text-muted-foreground">
            {t("accounts.link.thread")}
          </label>
          <select
            value={threadId ?? ""}
            onChange={(e) =>
              setMeetingLink({ companyId, threadId: e.target.value || null, attendeeIds })
            }
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs"
          >
            <option value="">{t("accounts.link.none")}</option>
            {threads.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.stage ? `（${stageSet.names[x.stage] ?? x.stage}）` : ""}
              </option>
            ))}
          </select>
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
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
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
          <Button
            size="sm"
            variant="outline"
            className={`h-7 text-xs ${confirmOverwrite ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : ""}`}
            onClick={compose}
          >
            {confirmOverwrite ? t("accounts.link.overwrite") : t("accounts.link.compose")}
          </Button>
        </div>
      )}
    </div>
  );
}
