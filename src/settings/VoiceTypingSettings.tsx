import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Keyboard, Loader2 } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n, type TranslationKey } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import type { VoiceTypingShortcut } from "../lib/types";
import { Button } from "@/components/ui/button";

interface HotkeyStatus {
  authorized: boolean;
  active: boolean;
  shortcut: VoiceTypingShortcut;
}

const SHORTCUTS: VoiceTypingShortcut[] = [
  "alt-space",
  "fn",
  "right-option",
  "right-command",
  "right-control",
];

const SHORTCUT_LABEL_KEYS: Record<VoiceTypingShortcut, TranslationKey> = {
  "alt-space": "settings.voiceTyping.shortcut.alt-space",
  fn: "settings.voiceTyping.shortcut.fn",
  "right-option": "settings.voiceTyping.shortcut.right-option",
  "right-command": "settings.voiceTyping.shortcut.right-command",
  "right-control": "settings.voiceTyping.shortcut.right-control",
};

/**
 * Voice-typing options: a push-to-talk key picker (the single source of truth —
 * exactly one trigger is live at a time) plus the auto-paste opt-in. Modifier
 * keys need Input Monitoring; Option+Space needs no extra permission. Accessibility
 * (for auto-paste) is granted from the dedicated Permissions tab.
 */
export const VoiceTypingSettings = () => {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [saving, setSaving] = useState<VoiceTypingShortcut | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void invoke<HotkeyStatus>("voice_typing_hotkey_status")
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!isTauri()) return null;

  const selected = settings.voiceTypingShortcut;
  const needsPermission = selected !== "alt-space" && status != null && !status.authorized;
  const active = !!status?.active;

  const setVoiceTypingEnabled = (enabled: boolean) => {
    updateSettings({ voiceTypingEnabled: enabled });
    void broadcastSettings({ ...useStore.getState().settings });
  };

  const chooseShortcut = async (shortcut: VoiceTypingShortcut) => {
    setSaving(shortcut);
    updateSettings({ voiceTypingShortcut: shortcut });
    void broadcastSettings({ ...useStore.getState().settings });
    let s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(
      () => null,
    );
    // A modifier key can only be listened for globally with Input Monitoring —
    // prompt for it the moment the user picks one without the grant.
    if (s && shortcut !== "alt-space" && !s.authorized) {
      await invoke("request_input_monitoring").catch(() => {});
      s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(() => s);
    }
    if (s) setStatus(s);
    setSaving(null);
  };

  return (
    <div className="flex max-w-md flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-sm font-medium">{t("settings.voiceTyping.pushToTalk")}</span>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.voiceTyping.hint")}
          </span>
        </span>
        <Button
          variant={settings.voiceTypingEnabled ? "outline" : "default"}
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => setVoiceTypingEnabled(!settings.voiceTypingEnabled)}
        >
          {settings.voiceTypingEnabled
            ? t("settings.voiceTyping.disable")
            : t("settings.voiceTyping.enable")}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.voiceTyping.shortcut")}
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${
              active
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {active ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            {active
              ? t("settings.voiceTyping.listenerActive")
              : t("settings.voiceTyping.listenerInactive")}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SHORTCUTS.map((shortcut) => (
            <Button
              key={shortcut}
              variant={selected === shortcut ? "secondary" : "outline"}
              size="sm"
              className="h-9 justify-start gap-2 px-2 text-xs"
              onClick={() => void chooseShortcut(shortcut)}
            >
              {saving === shortcut ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Keyboard className="size-3.5" />
              )}
              {t(SHORTCUT_LABEL_KEYS[shortcut])}
            </Button>
          ))}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.voiceTyping.conflictHint")}
        </p>

        {needsPermission && (
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
      </div>

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
