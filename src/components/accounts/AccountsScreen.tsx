import { useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useAccounts } from "../../lib/accounts/store";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { CompanyPage } from "./CompanyPage";
import { ThreadPage } from "./ThreadPage";
import { PeopleRail } from "./PeopleRail";

type CenterView = { kind: "overview" } | { kind: "thread"; id: string };

/**
 * One company's war room: the deal is the work axis (threads, triage, intel)
 * with the stakeholder roster always at hand on the right.
 *
 * The company SWITCHER used to be this screen's left column. Since #195 it's
 * the app shell's tree — the same tree that holds the company's recordings — so
 * picking a company can't mean one thing here and another thing in a second
 * window.
 */
export function AccountsScreen() {
  const { t } = useI18n();
  const companies = useAccounts((s) => s.companies);
  const threads = useAccounts((s) => s.threads);
  const active = useMemo(() => companies.filter((c) => !c.archived), [companies]);

  const companyId = useStore((s) => s.accountsCompanyId);
  const setCompanyId = useStore((s) => s.setAccountsCompany);
  const focus = useStore((s) => s.accountsFocus);
  const [center, setCenter] = useState<CenterView>({ kind: "overview" });
  const [pulse, setPulse] = useState(false);
  const peopleRef = useRef<HTMLDivElement>(null);

  // Land on the first company once data is there. Archived companies stay
  // selectable (viewed with a restore banner); only a vanished id recovers.
  useEffect(() => {
    if (!companyId || !companies.some((c) => c.id === companyId)) {
      setCompanyId(active[0]?.id ?? null);
    }
  }, [companies, active, companyId, setCompanyId]);

  // A company switch is a different war room — never keep the previous
  // company's thread open underneath it.
  useEffect(() => {
    setCenter({ kind: "overview" });
  }, [companyId]);

  // The tree can select a specific facet ("人 · 4 位"). The SELECTION persists
  // (the tree keeps that row lit); the emphasis is a one-off pulse, because a
  // ring that never goes away stops meaning anything.
  useEffect(() => {
    if (focus !== "people") return;
    peopleRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(id);
  }, [focus, companyId]);

  const company = companies.find((c) => c.id === companyId) ?? null;
  const thread =
    center.kind === "thread" ? threads.find((x) => x.id === center.id) : undefined;

  const saved = useDefaultLayout({
    id: "parley:accounts",
    panelIds: ["main", "people"],
    storage: window.localStorage,
  });

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={saved.defaultLayout}
      onLayoutChanged={saved.onLayoutChanged}
    >
      <ResizablePanel id="main" defaultSize={68} minSize={40}>
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
      <ResizablePanel id="people" defaultSize={32} minSize={18}>
        <div
          ref={peopleRef}
          className={`h-full min-h-0 transition-shadow ${
            pulse ? "ring-2 ring-inset ring-primary/60" : ""
          }`}
        >
          {company && <PeopleRail key={company.id} companyId={company.id} />}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
