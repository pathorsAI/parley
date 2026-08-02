import { useState } from "react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import { composeBrief } from "../../lib/accounts/brief";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MeetingLinkPicker } from "./MeetingLinkPicker";

/**
 * The accounts link INSIDE a running meeting (design §5.2): re-point the call
 * at a different company/thread, add someone who just joined, or pull the brief
 * in late. The same choices are made ahead of time on the pre-flight screen —
 * this is the mid-call amendment, not the main entry point. The picker rows
 * themselves are shared with the study link bar (MeetingLinkPicker).
 */
export function MeetingLinkSection() {
  const { t, language } = useI18n();
  const acc = useAccounts();
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);

  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const company = acc.companies.find((c) => !c.archived && c.id === companyId) ?? null;
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
      <MeetingLinkPicker />

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
