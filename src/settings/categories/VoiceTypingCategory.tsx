import { useI18n } from "../../i18n";
import { VoiceTypingSettings } from "../VoiceTypingSettings";
import { Section } from "../fields";

/** Settings › Voice typing. */
export function VoiceTypingCategory() {
  const { t } = useI18n();
  return (
    <Section title={t("settings.voiceTyping.title")}>
      <VoiceTypingSettings />
    </Section>
  );
}
