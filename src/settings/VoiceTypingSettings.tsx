import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";

/**
 * Voice-typing options. The macOS permissions it needs (Input Monitoring for
 * the global fn key, Accessibility for auto-paste) are granted from the dedicated
 * Permissions tab.
 */
export const VoiceTypingSettings = () => {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  if (!isTauri()) return null;

  return (
    <div className="flex max-w-md flex-col gap-3 rounded-lg border p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.voiceTyping.hint")}
      </p>

      <label htmlFor="voice-typing-auto-paste" className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-sm">{t("settings.voiceTyping.autoPaste")}</span>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.autoPasteHint")}
          </span>
        </span>
        <input
          id="voice-typing-auto-paste"
          type="checkbox"
          className="size-4 shrink-0"
          checked={settings.voiceTypingAutoPaste}
          onChange={async (e) => {
            const on = e.target.checked;
            updateSettings({ voiceTypingAutoPaste: on });
            void broadcastSettings({ ...useStore.getState().settings });
            // Auto-paste needs Accessibility — prompt the moment it's enabled.
            if (on) await invoke("accessibility_status", { prompt: true }).catch(() => {});
          }}
        />
      </label>
    </div>
  );
};
