import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import { Button } from "@/components/ui/button";

/**
 * Voice-typing options. The macOS permissions it needs (Input Monitoring for
 * the global fn key, Accessibility for auto-paste) are granted from the dedicated
 * Permissions tab.
 */
export const VoiceTypingSettings = () => {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [inputMonitoring, setInputMonitoring] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void invoke<boolean>("input_monitoring_status")
      .then((ok) => {
        if (alive) setInputMonitoring(ok);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!isTauri()) return null;

  const setVoiceTypingEnabled = async (enabled: boolean) => {
    updateSettings({ voiceTypingEnabled: enabled });
    void broadcastSettings({ ...useStore.getState().settings });
    if (enabled && inputMonitoring) await invoke("ensure_fn_listener").catch(() => {});
  };

  return (
    <div className="flex max-w-md flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-sm font-medium">{t("settings.voiceTyping.pushToTalk")}</span>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {settings.voiceTypingEnabled
              ? t(inputMonitoring ? "settings.voiceTyping.enabledFn" : "settings.voiceTyping.enabledOptionSpace")
              : t("settings.voiceTyping.disabledReason")}
          </span>
        </span>
        <Button
          variant={settings.voiceTypingEnabled ? "outline" : "default"}
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => void setVoiceTypingEnabled(!settings.voiceTypingEnabled)}
        >
          {settings.voiceTypingEnabled ? t("settings.voiceTyping.disable") : t("settings.voiceTyping.enable")}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.voiceTyping.hint")}
      </p>

      {!inputMonitoring && (
        <button
          type="button"
          className="self-start text-[11px] font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => {
            void invoke("open_privacy_settings", { pane: "input-monitoring" });
          }}
        >
          {t("settings.voiceTyping.openInputMonitoring")}
        </button>
      )}

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
