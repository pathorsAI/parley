import { Button } from "@/components/ui/button";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { openInMainWindow } from "../../lib/nav/mainWindow";
import { Section } from "../fields";

/**
 * Settings › Dictionary. The editor moved to the main window's 語境庫 ›
 * 常用詞, next to the speaker background; this panel stays so the muscle
 * memory (and ⌘K-in-Settings searches for 詞庫) still lands somewhere that
 * says where it went.
 */
export function DictionaryCategory() {
  const { t } = useI18n();
  return (
    <Section title={t("settings.dictionary.title")}>
      <div className="flex max-w-md flex-col gap-2 rounded-lg border border-warning-border bg-warning px-3 py-2 text-[11px] leading-relaxed text-warning-foreground">
        <span>{t("context.dictionaryMoved")}</span>
        <Button
          size="sm"
          className="h-7 self-start px-2.5 text-xs"
          onClick={() => {
            openInMainWindow({ kind: "library", selection: { kind: "context" } }).catch((error) =>
              log.warn("settings: open context library failed", { error: String(error) })
            );
          }}
        >
          {t("context.openContext")}
        </Button>
      </div>
    </Section>
  );
}
