import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Plus, ScrollText, Sparkles, Upload, X } from "lucide-react";
import {
  useAccounts,
  personsOf,
  threadsOf,
  activeClaims,
  triageClaims,
} from "../../lib/accounts/store";
import type { Company, ThreadKind } from "../../lib/accounts/types";
import { THREAD_KINDS } from "../../lib/accounts/types";
import { listHistory, loadHistoryEntry } from "../../lib/history/history";
import type { HistoryEntrySummary } from "../../lib/history/types";
import { formatClock } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ClaimCard, ClaimList } from "./ClaimCard";
import { FeedDataDialog } from "./FeedDataDialog";
import { BriefingDialog } from "./BriefingDialog";
import { StanceDot } from "./bits";

/**
 * The company war room (design §4.2): triage first (conflicts + open
 * questions), then people, threads, company-level claims, meetings, sources.
 */
export function CompanyPage({
  company,
  onBack,
  onOpenPerson,
  onOpenThread,
}: Readonly<{
  company: Company;
  onBack: () => void;
  onOpenPerson: (id: string) => void;
  onOpenThread: (id: string) => void;
}>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const persons = personsOf(acc, company.id);
  const threads = threadsOf(acc, company.id);
  const triage = triageClaims(acc, company.id);
  const companyClaims = activeClaims(acc, company.id).filter(
    (c) => !c.threadId && c.confidence !== "conflicted" && c.category !== "openq"
  );
  const attachments = acc.attachments.filter((a) => a.companyId === company.id);

  const [feedOpen, setFeedOpen] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [personName, setPersonName] = useState("");
  const [personTitle, setPersonTitle] = useState("");
  const [threadName, setThreadName] = useState("");
  const [threadKind, setThreadKind] = useState<ThreadKind>("sales");
  const [meetings, setMeetings] = useState<HistoryEntrySummary[]>([]);

  useEffect(() => {
    listHistory()
      .then((all) => setMeetings(all.filter((m) => m.companyId === company.id)))
      .catch((e) => log.warn("accounts: list meetings failed", { error: String(e) }));
  }, [company.id]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{company.name}</h2>
            {company.note && <p className="text-sm text-muted-foreground">{company.note}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => setFeedOpen(true)}>
              <Upload className="size-3.5" />
              {t("accounts.feed")}
            </Button>
            <Button size="sm" className="h-8" onClick={() => setBriefingOpen(true)}>
              <Sparkles className="size-3.5" />
              {t("accounts.briefing.generate")}
            </Button>
          </div>
        </div>

        {/* Triage: conflicting info + open questions, always on top. */}
        {triage.length > 0 && (
          <Section title={`⚠ ${t("accounts.triage")}`}>
            {triage.map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </Section>
        )}

        {/* People */}
        <Section title={t("accounts.people")}>
          <div className="flex flex-wrap gap-2">
            {persons.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpenPerson(p.id)}
                className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left hover:bg-muted/50"
              >
                <StanceDot stance={p.stance?.value} />
                <span className="text-sm font-medium">{p.name}</span>
                {p.title && <span className="text-xs text-muted-foreground">{p.title}</span>}
                {p.committeeRole && (
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                    {t(`accounts.role.${p.committeeRole}`)}
                  </span>
                )}
              </button>
            ))}
          </div>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!personName.trim()) return;
              acc.addPerson({ companyId: company.id, name: personName, title: personTitle });
              setPersonName("");
              setPersonTitle("");
            }}
          >
            <input
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              placeholder={t("accounts.personName")}
              className="h-7 w-32 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              value={personTitle}
              onChange={(e) => setPersonTitle(e.target.value)}
              placeholder={t("accounts.personTitle")}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!personName.trim()}
              className="flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <Plus className="size-3" />
              {t("accounts.newPerson")}
            </button>
          </form>
        </Section>

        {/* Threads */}
        <Section title={t("accounts.threads")}>
          {threads.map(
            (th) =>
              th && (
                <button
                  key={th.id}
                  type="button"
                  onClick={() => onOpenThread(th.id)}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{th.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                    {t(`accounts.kind.${th.kind}`)}
                  </span>
                  {th.kind === "sales" && th.stage && (
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                      {t(`accounts.stage.${th.stage}`)}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    {t(`accounts.status.${th.status}`)}
                  </span>
                </button>
              )
          )}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!threadName.trim()) return;
              acc.addThread({ companyId: company.id, kind: threadKind, name: threadName });
              setThreadName("");
            }}
          >
            <select
              value={threadKind}
              onChange={(e) => setThreadKind(e.target.value as ThreadKind)}
              className="h-7 shrink-0 rounded-md border bg-background px-1.5 text-xs"
            >
              {THREAD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`accounts.kind.${k}`)}
                </option>
              ))}
            </select>
            <input
              value={threadName}
              onChange={(e) => setThreadName(e.target.value)}
              placeholder={t("accounts.threadName")}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!threadName.trim()}
              className="flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <Plus className="size-3" />
              {t("accounts.newThread")}
            </button>
          </form>
        </Section>

        {/* Company-level claims */}
        <Section title={t("accounts.companyClaims")}>
          <ClaimList
            claims={companyClaims}
            onAdd={(category, text) =>
              acc.addClaim({
                companyId: company.id,
                subjects: [company.id],
                category,
                text,
                provenance: [{ kind: "user" }],
                confidence: "confirmed",
              })
            }
          />
        </Section>

        {/* Meetings linked to this company */}
        {meetings.length > 0 && (
          <Section title={t("accounts.meetings")}>
            {meetings.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() =>
                  void loadHistoryEntry(m.id).catch((e) =>
                    log.warn("accounts: open meeting failed", { error: String(e) })
                  )
                }
                className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted/50"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()} · {formatClock(m.durationMs)}
                </span>
              </button>
            ))}
          </Section>
        )}

        {/* Sources */}
        {attachments.length > 0 && (
          <Section title={t("accounts.attachments")}>
            {attachments.map((a) => (
              <div
                key={a.id}
                className="group flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
              >
                <ScrollText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => acc.removeAttachment(a.id)}
                  className="shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </Section>
        )}
      </div>

      {feedOpen && <FeedDataDialog company={company} onClose={() => setFeedOpen(false)} />}
      {briefingOpen && <BriefingDialog company={company} onClose={() => setBriefingOpen(false)} />}
    </ScrollArea>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
