import { useI18n } from "../../i18n";
import { PermissionsPanel } from "../PermissionsPanel";
import { Section } from "../fields";

/** Settings › Permissions. */
export function PermissionsCategory() {
  const { t } = useI18n();
  return (
    <Section title={t("settings.permissions.title")}>
      <PermissionsPanel />
    </Section>
  );
}
