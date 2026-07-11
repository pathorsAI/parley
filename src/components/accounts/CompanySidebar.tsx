import { useState } from "react";
import {
  ArchiveRestore,
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";
import { useAccounts, threadsOf, triageClaims } from "../../lib/accounts/store";
import { ensureCompanyFolder } from "../../lib/accounts/folders";
import { useI18n } from "../../i18n";

/**
 * Left rail of the accounts workspace: the account switcher. Every company is
 * one click away (Slack-channel ergonomics); badges surface what needs
 * attention (⚠ triage) and how many battles are running.
 */
export function CompanySidebar({
  selectedId,
  onSelect,
}: Readonly<{ selectedId: string | null; onSelect: (id: string) => void }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const companies = acc.companies.filter((c) => !c.archived);
  const archived = acc.companies.filter((c) => c.archived);
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        <Building2 className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("accounts.title")}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {companies.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("accounts.empty")}
          </p>
        )}
        <div className="flex flex-col gap-0.5">
          {companies.map((c) => {
            const nTriage = triageClaims(acc, c.id).length;
            const nThreads = threadsOf(acc, c.id).filter((x) => x.status === "active").length;
            const selected = c.id === selectedId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  selected ? "bg-muted font-medium" : "hover:bg-muted/50"
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                {nTriage > 0 && (
                  <span className="shrink-0 rounded-full bg-orange-500/15 px-1.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300">
                    ⚠{nTriage}
                  </span>
                )}
                {nThreads > 0 && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {nThreads}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Archived companies stay reachable: view on click, restore in one. */}
        {archived.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-muted/40"
            >
              {showArchived ? (
                <ChevronDown className="size-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 text-muted-foreground" />
              )}
              <span className="text-xs text-muted-foreground">{t("accounts.archived")}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {archived.length}
              </span>
            </button>
            {showArchived && (
              <div className="flex flex-col gap-0.5">
                {archived.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors ${
                      c.id === selectedId ? "bg-muted" : "hover:bg-muted/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground"
                    >
                      {c.name}
                    </button>
                    <button
                      type="button"
                      title={t("accounts.restore")}
                      onClick={() => {
                        acc.unarchiveCompany(c.id);
                        onSelect(c.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover:text-muted-foreground"
                    >
                      <ArchiveRestore className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <form
        className="flex shrink-0 items-center gap-1.5 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const company = useAccounts.getState().addCompany({ name });
          ensureCompanyFolder(company);
          setName("");
          onSelect(company.id);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("accounts.companyName")}
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          title={t("accounts.newCompany")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>
      </form>
    </div>
  );
}
