import { useI18n } from "../../i18n";
import { UsagePanel } from "../UsagePanel";
import { Section } from "../fields";

/** Settings › Usage. */
export function UsageCategory() {
  const { t } = useI18n();
  return (
    <Section title={t("settings.usage.title")}>
      <UsagePanel />
    </Section>
  );
}
