import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  FileAudio,
  FileText,
  Plus,
  ScrollText,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  useAccounts,
  threadsOf,
  activeClaims,
  triageClaims,
  conflictPairs,
} from "../../lib/accounts/store";
import type { Company, CompanyAttachment, ThreadKind } from "../../lib/accounts/types";
import { THREAD_KINDS } from "../../lib/accounts/types";
import { listHistory, loadHistoryEntry } from "../../lib/history/history";
import { renameCompanyFolder } from "../../lib/accounts/folders";
import type { HistoryEntrySummary } from "../../lib/history/types";
import { formatClock, useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { ClaimCard, ClaimList } from "./ClaimCard";
import { ConflictPairCard } from "./ConflictPairCard";
import { FeedDataDialog } from "./FeedDataDialog";
import { BriefingDialog } from "./BriefingDialog";
import {
  AliasesEdit,
  ArchiveButton,
  InlineEdit,
  MiniStages,
  useRecentIngestHighlight,
} from "./bits";

/**
 * The company war room (design §4.2): triage first (conflicts + open
 * questions), then people, threads, company-level claims, meetings, sources.
 */
export function CompanyPage({
  company,
  onOpenThread,
}: Readonly<{
  company: Company;
  onOpenThread: (id: string) => void;
}>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const threads = threadsOf(acc, company.id);
  // Conflicts render as side-by-side pairs (B-3); whatever can't pair (open
  // questions, orphaned conflicts) stays a plain triage card.
  const pairs = conflictPairs(acc, company.id);
  const paired = new Set(pairs.flatMap((p) => [p.a.id, p.b.id]));
  const triage = triageClaims(acc, company.id).filter((c) => !paired.has(c.id));
  const companyClaims = activeClaims(acc, company.id).filter(
    (c) => !c.threadId && c.confidence !== "conflicted" && c.category !== "openq"
  );
  const claimCount = activeClaims(acc, company.id).length;
  const attachments = acc.attachments.filter((a) => a.companyId === company.id);
  const highlightIds = useRecentIngestHighlight(company.id);

  const [feedOpen, setFeedOpen] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [threadName, setThreadName] = useState("");
  const [threadKind, setThreadKind] = useState<ThreadKind>("sales");
  const [meetings, setMeetings] = useState<HistoryEntrySummary[]>([]);
  const [viewingAttachment, setViewingAttachment] = useState<CompanyAttachment | null>(null);

  useEffect(() => {
    listHistory()
      .then((all) => setMeetings(all.filter((m) => m.companyId === company.id)))
      .catch((e) => log.warn("accounts: list meetings failed", { error: String(e) }));
  }, [company.id]);

  // Import a recording AS this company's meeting: pre-link the meeting, then
  // hand off to the regular ingest wizard (which lives at the app root). The
  // saved entry carries companyId, so it lands in this company's meeting list
  // and the post-meeting review can file its intel here.
  async function importRecording() {
    const { settings, setMeetingLink, exitAccounts, openIngestWizard } = useStore.getState();
    setMeetingLink({ companyId: company.id, threadId: null, attendeeIds: [] });
    try {
      const { pickRecordingFile } = await import("../../lib/replay/ingest");
      const audioPath = await pickRecordingFile(settings);
      if (audioPath) {
        exitAccounts();
        openIngestWizard(audioPath);
      }
    } catch (e) {
      log.error("accounts: import recording failed", { error: String(e) });
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <InlineEdit
              value={company.name}
              required
              onCommit={(name) => {
                renameCompanyFolder(company, name);
                acc.updateCompany(company.id, { name });
              }}
              className="h-8 text-lg font-semibold leading-tight"
            />
            <InlineEdit
              value={company.note}
              onCommit={(note) => acc.updateCompany(company.id, { note })}
              placeholder={t("accounts.companyNote")}
              className="h-6 text-sm text-muted-foreground"
            />
            <div className="flex items-center gap-1.5 pt-0.5">
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("accounts.aliases")}
              </span>
              <AliasesEdit
                aliases={company.aliases}
                onCommit={(aliases) => acc.updateCompany(company.id, { aliases })}
              />
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {!company.archived && (
              <ArchiveButton onArchive={() => acc.archiveCompany(company.id)} />
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => void importRecording()}
            >
              <FileAudio className="size-3.5" />
              {t("accounts.importRecording")}
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => setFeedOpen(true)}>
              <Upload className="size-3.5" />
              {t("accounts.feed")}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={claimCount === 0}
              title={claimCount === 0 ? t("accounts.noClaims") : undefined}
              onClick={() => setBriefingOpen(true)}
            >
              <Sparkles className="size-3.5" />
              {t("accounts.briefing.generate")}
            </Button>
          </div>
        </div>

        {/* Archived: everything stays viewable; one click brings it back. */}
        {company.archived && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2">
            <Archive className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 flex-1 text-sm text-amber-700 dark:text-amber-300">
              {t("accounts.archivedCompanyBanner")}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0"
              onClick={() => acc.unarchiveCompany(company.id)}
            >
              <ArchiveRestore className="size-3.5" />
              {t("accounts.restore")}
            </Button>
          </div>
        )}

        {/* Triage: conflicting info + open questions, always on top. */}
        {(pairs.length > 0 || triage.length > 0) && (
          <Section title={`⚠ ${t("accounts.triage")}`}>
            {pairs.map((p) => (
              <ConflictPairCard key={`${p.a.id}|${p.b.id}`} a={p.a} b={p.b} />
            ))}
            {triage.map((c) => (
              <ClaimCard key={c.id} claim={c} highlight={highlightIds.has(c.id)} />
            ))}
          </Section>
        )}

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
                  {th.kind === "sales" && th.stage && <MiniStages stage={th.stage} />}
                  <span className="text-[10px] text-muted-foreground">
                    {t(`accounts.status.${th.status}`)}
                  </span>
                </button>
              )
          )}
          {threads.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
              {t("accounts.threads.empty")}
            </p>
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
            highlightIds={highlightIds}
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
                <button
                  type="button"
                  onClick={() => setViewingAttachment(a)}
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                >
                  {a.name}
                </button>
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
      {viewingAttachment && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
          <button
            type="button"
            aria-label="close"
            className="absolute inset-0 bg-black/50"
            onClick={() => setViewingAttachment(null)}
          />
          <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-background p-4 shadow-xl">
            <h3 className="pb-3 text-sm font-semibold">{viewingAttachment.name}</h3>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-3">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {viewingAttachment.text || t("accounts.attachment.empty")}
              </p>
            </div>
            <div className="flex shrink-0 justify-end pt-3">
              <Button size="sm" className="h-8" onClick={() => setViewingAttachment(null)}>
                {t("common.done")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
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
