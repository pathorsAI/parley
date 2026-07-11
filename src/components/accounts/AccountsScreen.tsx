import { useState } from "react";
import { Building2, Plus } from "lucide-react";
import { useAccounts, personsOf, threadsOf, triageClaims } from "../../lib/accounts/store";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CompanyPage } from "./CompanyPage";
import { PersonPage } from "./PersonPage";
import { ThreadPage } from "./ThreadPage";

type View =
  | { kind: "list" }
  | { kind: "company"; id: string }
  | { kind: "person"; id: string }
  | { kind: "thread"; id: string };

/**
 * The accounts (客戶) workspace — Parley's third screen next to live and
 * study. Company list → company war room → person / thread pages. Shown only
 * for business meeting types (design D12); entered from the titlebar.
 */
export function AccountsScreen() {
  const { t } = useI18n();
  const acc = useAccounts();
  const [view, setView] = useState<View>({ kind: "list" });
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const companies = acc.companies.filter((c) => !c.archived);

  if (view.kind === "company") {
    const company = companies.find((c) => c.id === view.id);
    if (company)
      return (
        <CompanyPage
          company={company}
          onBack={() => setView({ kind: "list" })}
          onOpenPerson={(id) => setView({ kind: "person", id })}
          onOpenThread={(id) => setView({ kind: "thread", id })}
        />
      );
  }
  if (view.kind === "person") {
    const person = acc.persons.find((p) => p.id === view.id);
    if (person)
      return (
        <PersonPage person={person} onBack={() => setView({ kind: "company", id: person.companyId })} />
      );
  }
  if (view.kind === "thread") {
    const thread = acc.threads.find((x) => x.id === view.id);
    if (thread)
      return (
        <ThreadPage thread={thread} onBack={() => setView({ kind: "company", id: thread.companyId })} />
      );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Building2 className="size-5 text-muted-foreground" />
          {t("accounts.title")}
        </h2>

        {companies.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("accounts.empty")}</p>
        )}

        <div className="flex flex-col gap-2">
          {companies.map((c) => {
            const nPersons = personsOf(acc, c.id).length;
            const nThreads = threadsOf(acc, c.id).filter((x) => x.status === "active").length;
            const nTriage = triageClaims(acc, c.id).length;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setView({ kind: "company", id: c.id })}
                className="flex items-center gap-3 rounded-xl border px-4 py-3 text-left hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.name}</p>
                  {c.note && <p className="truncate text-xs text-muted-foreground">{c.note}</p>}
                </div>
                {nTriage > 0 && (
                  <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300">
                    ⚠ {nTriage}
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("accounts.people")} {nPersons} · {t("accounts.threads")} {nThreads}
                </span>
              </button>
            );
          })}
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const company = useAccounts.getState().addCompany({ name, note });
            setName("");
            setNote("");
            setView({ kind: "company", id: company.id });
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("accounts.companyName")}
            className="h-8 w-44 text-sm"
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("accounts.companyNote")}
            className="h-8 flex-1 text-sm"
          />
          <Button type="submit" size="sm" className="h-8" disabled={!name.trim()}>
            <Plus className="size-3.5" />
            {t("accounts.newCompany")}
          </Button>
        </form>
      </div>
    </div>
  );
}
