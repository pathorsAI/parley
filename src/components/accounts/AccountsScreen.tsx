import { useEffect, useMemo, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useAccounts } from "../../lib/accounts/store";
import { useI18n } from "../../i18n";
import { CompanySidebar } from "./CompanySidebar";
import { CompanyPage } from "./CompanyPage";
import { ThreadPage } from "./ThreadPage";
import { PeopleRail } from "./PeopleRail";

type CenterView = { kind: "overview" } | { kind: "thread"; id: string };

/**
 * The accounts (客戶) workspace — same three-pane DNA as the live screen:
 * company switcher (left, always one click away) | war room (center — the
 * deal is the work axis: threads, triage, intel) | stakeholder roster
 * (right — who's who and where they stand, always at hand).
 */
export function AccountsScreen() {
  const { t } = useI18n();
  const companies = useAccounts((s) => s.companies);
  const threads = useAccounts((s) => s.threads);
  const active = useMemo(() => companies.filter((c) => !c.archived), [companies]);

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [center, setCenter] = useState<CenterView>({ kind: "overview" });

  // Land on the first company once data is there. Archived companies stay
  // selectable (viewed with a restore banner); only a vanished id recovers.
  useEffect(() => {
    if (!companyId || !companies.some((c) => c.id === companyId)) {
      setCompanyId(active[0]?.id ?? null);
      setCenter({ kind: "overview" });
    }
  }, [companies, active, companyId]);

  const company = companies.find((c) => c.id === companyId) ?? null;
  const thread =
    center.kind === "thread" ? threads.find((x) => x.id === center.id) : undefined;

  const saved = useDefaultLayout({
    id: "parley:accounts",
    panelIds: ["companies", "main", "people"],
    storage: window.localStorage,
  });

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={saved.defaultLayout}
      onLayoutChanged={saved.onLayoutChanged}
    >
      <ResizablePanel id="companies" defaultSize={17} minSize={12}>
        <CompanySidebar
          selectedId={companyId}
          onSelect={(id) => {
            setCompanyId(id);
            setCenter({ kind: "overview" });
          }}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="main" defaultSize={57} minSize={38}>
        {company ? (
          thread && center.kind === "thread" ? (
            <ThreadPage thread={thread} onBack={() => setCenter({ kind: "overview" })} />
          ) : (
            <CompanyPage
              company={company}
              onOpenThread={(id) => setCenter({ kind: "thread", id })}
            />
          )
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <p className="max-w-64 text-center text-sm text-muted-foreground">
              {t("accounts.selectCompany")}
            </p>
          </div>
        )}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="people" defaultSize={26} minSize={16}>
        {company && <PeopleRail key={company.id} companyId={company.id} />}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
