import { useI18n } from "../../i18n";
import { DictionarySettings } from "../DictionarySettings";
import { Section } from "../fields";

/** Settings › Dictionary. */
export function DictionaryCategory() {
  const { t } = useI18n();
  return (
    <Section
      title={t("settings.dictionary.title")}
      info={`${t("settings.dictionary.intro")}\n\n${t("settings.dictionary.privacy")}`}
    >
      <DictionarySettings />
    </Section>
  );
}
