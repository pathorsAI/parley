import { InfoTip } from "@/components/ui/info-tip";
import { Label } from "@/components/ui/label";
import { useI18n } from "../i18n";

/** One Settings panel: its title (with an optional info tip) over its fields. */
export function Section({
  title,
  info,
  children,
}: Readonly<{ title: string; info?: string; children: React.ReactNode }>) {
  const { t } = useI18n();
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h2 className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
        {title}
        {info && <InfoTip label={t("settings.info")}>{info}</InfoTip>}
      </h2>
      {children}
    </section>
  );
}

/** A labelled field inside a Section. */
export function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
