import { useMemo, useState } from "react";
import { useStore } from "../../lib/store";
import { useAccounts, activeClaims } from "../../lib/accounts/store";
import { useI18n } from "../../i18n";
import { Combobox } from "@/components/ui/combobox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ClaimList } from "./ClaimCard";
import { EmptyState } from "../preflight/bits";

/**
 * The accounts dossier, readable DURING a live call.
 *
 * The full accounts workspace is a mode switch and is refused while recording —
 * the live screen owns an active call — so mid-call the intel was simply
 * unreachable, which is when it matters most. A sheet slides over the live
 * screen instead: the transcript and coach feed keep running underneath.
 */
export function AccountsSheet({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const linkedCompanyId = useStore((s) => s.meetingCompanyId);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const companies = acc.companies.filter((c) => !c.archived);
  // Default to the meeting's own company; the picker exists for the moment
  // someone drops another customer's name mid-call.
  const companyId = viewingId ?? linkedCompanyId ?? companies[0]?.id ?? null;
  const company = companies.find((c) => c.id === companyId) ?? null;

  const claims = useMemo(
    () => (company ? activeClaims(acc, company.id) : []),
    [acc, company]
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="max-w-lg"
        closeLabel={t("common.close")}
        title={t("accounts.title")}
      >
        {companies.length === 0 ? (
          <div className="h-full py-10">
            <EmptyState
              glyph="radar"
              title={t("preflight.review.emptyTitle")}
              hint={t("accounts.selectCompany")}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-3">
            <Combobox
              value={companyId ?? ""}
              groups={[{ options: companies.map((c) => ({ value: c.id, label: c.name })) }]}
              onChange={setViewingId}
              placeholder={t("accounts.link.company")}
              searchPlaceholder={t("preflight.search")}
              emptyText={t("preflight.noMatch")}
            />
            <ClaimList claims={claims} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
