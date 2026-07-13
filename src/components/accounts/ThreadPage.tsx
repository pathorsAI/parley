import { ArrowLeft } from "lucide-react";
import { useAccounts, claimsOfThread, personsOf } from "../../lib/accounts/store";
import type { Thread } from "../../lib/accounts/types";
import { COMMITTEE_ROLES } from "../../lib/accounts/types";
import { stageGuideView } from "../../lib/accounts/bundles";
import { useStageSet } from "../../lib/accounts/useStageSet";
import { useI18n, type TranslationKey } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ClaimList } from "./ClaimCard";
import { InlineEdit, StageStepper, useRecentIngestHighlight } from "./bits";

const STATUSES: Thread["status"][] = ["active", "won", "lost", "parked"];

/** The thread war room: stage/status controls, committee, and its claims. */
export function ThreadPage({
  thread,
  onBack,
}: Readonly<{ thread: Thread; onBack: () => void }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const stageSet = useStageSet();
  const claims = claimsOfThread(acc, thread.id);
  const persons = personsOf(acc, thread.companyId);
  const highlightIds = useRecentIngestHighlight(thread.companyId);
  const guide = thread.stage
    ? stageGuideView((k) => t(k as TranslationKey), stageSet, thread.stage)
    : null;

  const expected = thread.expectedCloseAt
    ? new Date(thread.expectedCloseAt).toISOString().slice(0, 10)
    : "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        <div className="flex items-start gap-3">
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <InlineEdit
              value={thread.name}
              required
              onCommit={(name) => acc.updateThread(thread.id, { name })}
              className="h-8 text-lg font-semibold leading-tight"
            />
            <div className="flex flex-wrap items-center gap-2 pt-1.5 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5">{t(`accounts.kind.${thread.kind}`)}</span>
              {thread.kind === "sales" ? (
                <StageStepper
                  stage={thread.stage ?? "discovery"}
                  onChange={(stage) => acc.updateThread(thread.id, { stage })}
                />
              ) : (
                <input
                  value={thread.customStatus ?? ""}
                  onChange={(e) => acc.updateThread(thread.id, { customStatus: e.target.value })}
                  placeholder={t("accounts.status.active")}
                  className="h-6 w-32 rounded border bg-transparent px-1.5 outline-none focus:ring-1 focus:ring-ring"
                />
              )}
              <select
                value={thread.status}
                onChange={(e) =>
                  acc.updateThread(thread.id, { status: e.target.value as Thread["status"] })
                }
                className="h-6 rounded border bg-background px-1"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`accounts.status.${s}`)}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-muted-foreground">
                {t("accounts.expectedCloseLabel")}
                <input
                  type="date"
                  value={expected}
                  onChange={(e) =>
                    acc.updateThread(thread.id, {
                      expectedCloseAt: e.target.value
                        ? new Date(`${e.target.value}T00:00:00`).getTime()
                        : undefined,
                    })
                  }
                  className="h-6 rounded border bg-background px-1"
                />
              </label>
            </div>
          </div>
        </div>

        {/* Stage guide (pipeline lite): what this stage is for, what to
            collect (SPIN for discovery), and its exit criteria. The full
            SPIN gap board is the stage-bundle workstream (design §8). */}
        {thread.kind === "sales" && thread.stage && guide && (
          <section className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("accounts.stageGuide.title")}
              </h3>
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                {stageSet.names[thread.stage] ?? thread.stage}
              </span>
            </div>
            {guide.goal && (
              <p className="pt-1.5 text-sm">
                <span className="text-muted-foreground">{t("accounts.stageGuide.goal")}：</span>
                {guide.goal}
              </p>
            )}
            <p className="pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("accounts.stageGuide.collect")}
            </p>
            <ul className="pt-0.5">
              {guide.collect.map((item) => (
                <li key={item} className="flex gap-1.5 text-sm text-muted-foreground">
                  <span className="text-sky-500">○</span>
                  {item}
                </li>
              ))}
            </ul>
            {guide.exit.length > 0 && (
              <p className="pt-2 text-sm">
                <span className="text-muted-foreground">{t("accounts.stageGuide.exit")}：</span>
                {guide.exit.join("；")}
              </p>
            )}
          </section>
        )}

        {/* Buying committee on this thread */}
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            {t("accounts.people")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {persons.map((p) => {
              const seat = thread.committee.find((c) => c.personId === p.id);
              return (
                <div key={p.id} className="flex items-center gap-1.5 rounded-lg border px-2 py-1">
                  <span className="text-sm">{p.name}</span>
                  <select
                    value={seat?.role ?? ""}
                    onChange={(e) => {
                      const role = e.target.value as (typeof COMMITTEE_ROLES)[number] | "";
                      const rest = thread.committee.filter((c) => c.personId !== p.id);
                      acc.updateThread(thread.id, {
                        committee: role ? [...rest, { personId: p.id, role }] : rest,
                      });
                    }}
                    className="h-6 rounded border bg-background px-1 text-[10px]"
                  >
                    <option value="">—</option>
                    {COMMITTEE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`accounts.role.${r}`)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </section>

        <ClaimList
          claims={claims}
          highlightIds={highlightIds}
          onAdd={(category, text) =>
            acc.addClaim({
              companyId: thread.companyId,
              threadId: thread.id,
              subjects: [],
              category,
              text,
              provenance: [{ kind: "user" }],
              confidence: "confirmed",
            })
          }
        />
      </div>
    </div>
  );
}
