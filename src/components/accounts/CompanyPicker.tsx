import { Building2 } from "lucide-react";
import { useAccounts } from "../../lib/accounts/store";
import { ensureCompanyFolder } from "../../lib/accounts/folders";
import { useI18n } from "../../i18n";
import { Combobox } from "@/components/ui/combobox";

/**
 * "這是誰的" — the one control that picks a recording's customer, with a
 * brand-new customer creatable from the same keystrokes.
 *
 * Every door that produces a recording asks this question (pre-flight, the two
 * import dialogs, the study titlebar), and before #211 each door answered it
 * differently — some asked for a FOLDER instead, one didn't ask at all. Sharing
 * one component is what keeps "選客戶" from meaning something subtly different
 * depending on where you happened to start.
 *
 * The value is a company id, or "" for 還沒歸戶. Creating pairs the folder up
 * front so the recording has somewhere to land the moment it saves.
 */
export function CompanyPicker({
  value,
  onChange,
  size = "sm",
  className,
}: Readonly<{
  value: string | null;
  onChange: (companyId: string | null) => void;
  size?: "default" | "sm" | "bare";
  className?: string;
}>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const companies = acc.companies.filter((c) => !c.archived);

  return (
    <Combobox
      size={size}
      className={className}
      icon={<Building2 className="size-3.5 shrink-0 text-muted-foreground" />}
      value={value ?? ""}
      groups={[
        {
          options: [
            { value: "", label: t("owner.unassigned") },
            ...companies.map((c) => ({ value: c.id, label: c.name })),
          ],
        },
      ]}
      onChange={(v) => onChange(v || null)}
      onCreate={(name) => {
        const created = acc.addCompany({ name });
        ensureCompanyFolder(created);
        onChange(created.id);
      }}
      createLabel={(name) => t("owner.create", { name })}
      placeholder={t("owner.unassigned")}
      searchPlaceholder={t("owner.search")}
      emptyText={t("preflight.noMatch")}
      title={t("owner.label")}
    />
  );
}
