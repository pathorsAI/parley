import { useStore } from "../lib/store";
import { broadcastSettings } from "../lib/settingsSync";
import { log } from "../lib/log";
import { TRANSLATE_LANGUAGES } from "../lib/translateLanguages";
import { useI18n } from "../i18n";
import type { Settings } from "../lib/types";
import { Flag } from "./ui/flag";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Patch settings + broadcast to the secondary windows, like the Settings
 *  pages do — these controls live outside Settings but write the same keys. */
function patchShared(p: Partial<Settings>) {
  useStore.getState().updateSettings(p);
  broadcastSettings({ ...useStore.getState().settings }).catch((e) =>
    log.warn("settings: broadcast failed", { error: String(e) })
  );
}

/**
 * The meeting-translation master switch, shared by every surface that offers
 * the toggle (titlebar 🌐 menu, pre-flight footer, Settings → 翻譯) so they
 * can't drift: one bound control, not three copies of the same switch.
 */
export function TranslateSwitch({ disabled = false }: Readonly<{ disabled?: boolean }>) {
  const { t } = useI18n();
  const enabled = useStore((s) => s.settings.meetingTranslateEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={t("meeting.translate.enable")}
      disabled={disabled}
      onClick={() => patchShared({ meetingTranslateEnabled: !enabled })}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
          enabled ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** Compact target-language picker bound to `translateTargetLanguage`. */
export function TranslateLanguagePicker({
  disabled = false,
  className,
}: Readonly<{ disabled?: boolean; className?: string }>) {
  const language = useStore((s) => s.settings.translateTargetLanguage);
  const selected = TRANSLATE_LANGUAGES.find((l) => l.code === language);
  return (
    <Select
      value={language}
      onValueChange={(v) => patchShared({ translateTargetLanguage: v })}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className={className}>
        {/* Explicit trigger content, not a bare SelectValue: SelectValue
            mirrors the whole option — flag + native name + English gloss —
            which renders as "English English" whenever the two labels agree. */}
        {selected ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Flag code={selected.flag} />
            <span className="truncate">{selected.nativeLabel}</span>
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent>
        {TRANSLATE_LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            <Flag code={l.flag} />
            {l.nativeLabel}
            <span className="ml-2 text-muted-foreground">{l.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
