import { useMemo } from "react";
import { AlertTriangle, ClipboardList, FileAudio, Import, Mic, Play } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, triageClaims } from "../../lib/accounts/store";
import { loadHistoryEntry } from "../../lib/history/history";
import { startImportFlow } from "../../lib/replay/ingest";
import { beginMeeting } from "../../lib/meeting/start";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import type { LibraryTree } from "../shell/useLibraryTree";

/**
 * The idle landing (R8c). Before this, idle showed the live cockpit with three
 * empty columns — a screen for a meeting that wasn't happening — while all
 * browsing weight fell on the 240px tree. Home flips that: the cockpit exists
 * only while a meeting runs; idle surfaces what the user actually acts on next
 * (start / triage backlog / recent recordings / import).
 */
export function HomeScreen({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t, language } = useI18n();
  const acc = useAccounts();
  const enterPreflight = useStore((s) => s.enterPreflight);
  const openAccounts = useStore((s) => s.openAccounts);
  const userName = useStore((s) => s.settings.userName);

  const triage = useMemo(
    () =>
      acc.companies
        .filter((c) => !c.archived)
        .map((c) => ({ company: c, count: triageClaims(acc, c.id).length }))
        .filter((x) => x.count > 0),
    [acc]
  );
  const recent = tree.summaries.slice(0, 6);
  const locale = language === "en" ? "en-US" : "zh-TW";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
        {/* ── Start ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">
            {userName ? t("home.greetingNamed", { name: userName }) : t("home.greeting")}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" className="h-10" onClick={enterPreflight}>
              <Mic className="size-4" />
              {t("titlebar.startMeeting")}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-10"
              onClick={() =>
                beginMeeting().catch((e) => {
                  log.error("home: direct start failed", { error: String(e) });
                  toast.error(String(e instanceof Error ? e.message : e));
                })
              }
            >
              <Play className="size-4" />
              {t("titlebar.startDirect")}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="h-10 text-muted-foreground"
              onClick={() =>
                startImportFlow().catch((e) => {
                  log.error("home: import failed", { error: String(e) });
                  toast.error(String(e instanceof Error ? e.message : e));
                })
              }
            >
              <Import className="size-4" />
              {t("home.import")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("home.dropHint")}</p>
        </section>

        {/* ── Triage backlog: conflicts queue, they must stay visible ────── */}
        {triage.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("home.triage")}
            </h2>
            {triage.map(({ company, count }) => (
              <button
                key={company.id}
                type="button"
                onClick={() => openAccounts(company.id)}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
              >
                <AlertTriangle className="size-4 shrink-0 text-orange-500" />
                <span className="min-w-0 flex-1 truncate font-medium">{company.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("home.triageRow", { n: count })}
                </span>
              </button>
            ))}
          </section>
        )}

        {/* ── Recent recordings ───────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            {t("home.recent")}
          </h2>
          {recent.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {t("home.emptyRecordings")}
            </p>
          )}
          {recent.map((e) => {
            const company = e.companyId
              ? acc.companies.find((c) => c.id === e.companyId)
              : undefined;
            return (
              <button
                key={e.id}
                type="button"
                onClick={() =>
                  void loadHistoryEntry(e.id).catch((err) => {
                    log.error("home: open recording failed", { id: e.id, error: String(err) });
                    toast.error(String(err instanceof Error ? err.message : err));
                  })
                }
                className="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{e.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleDateString(locale, {
                      month: "short",
                      day: "numeric",
                    })}
                    {company ? ` · ${company.name}` : ""}
                    {e.snippet ? ` · ${e.snippet}` : ""}
                  </span>
                </span>
                {(e.actionItemsCount ?? 0) > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <ClipboardList className="size-3.5" />
                    {e.actionItemsCount}
                  </span>
                )}
              </button>
            );
          })}
        </section>
      </div>
    </div>
  );
}
