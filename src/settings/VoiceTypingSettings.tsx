import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Keyboard, Loader2 } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import type { Settings, VoiceTypingShortcut } from "../lib/types";
import { Button } from "@/components/ui/button";
import type { TranslationKey } from "../i18n";

interface HotkeyStatus {
  authorized: boolean;
  active: boolean;
  shortcut: VoiceTypingShortcut;
}

const SHORTCUTS: VoiceTypingShortcut[] = ["fn", "right-option", "right-command", "right-control"];
const SHORTCUT_LABEL_KEYS: Record<VoiceTypingShortcut, TranslationKey> = {
  fn: "settings.voiceTyping.shortcut.fn",
  "right-option": "settings.voiceTyping.shortcut.right-option",
  "right-command": "settings.voiceTyping.shortcut.right-command",
  "right-control": "settings.voiceTyping.shortcut.right-control",
};

/**
 * Voice-typing options inside Transcription settings: a short description plus
 * push-to-talk key selection and the auto-paste opt-in.
 */
export function VoiceTypingSettings() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [saving, setSaving] = useState<VoiceTypingShortcut | null>(null);

  async function refreshStatus() {
    const s = await invoke<HotkeyStatus>("voice_typing_hotkey_status").catch(() => null);
    if (s) setStatus(s);
  }

  async function patch(p: Partial<Settings>) {
    updateSettings(p);
    await broadcastSettings({ ...useStore.getState().settings });
  }

  async function chooseShortcut(shortcut: VoiceTypingShortcut) {
    setSaving(shortcut);
    updateSettings({ voiceTypingShortcut: shortcut });
    await broadcastSettings({ ...useStore.getState().settings });
    const s = await invoke<HotkeyStatus>("set_voice_typing_shortcut", { shortcut }).catch(() => null);
    if (s) setStatus(s);
    setSaving(null);
  }

  useEffect(() => {
    refreshStatus().catch(() => {});
  }, []);

  if (!isTauri()) return null;

  const active = status?.active && status.authorized;
  const selected = settings.voiceTypingShortcut;

  return (
    <div className="mt-2 flex max-w-xl flex-col gap-4 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Keyboard className="size-4" />
            {t("settings.voiceTyping.title")}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.voiceTyping.hint")}
          </p>
        </div>
        <div className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${
          active ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
        }`}>
          {active ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          {active ? t("settings.voiceTyping.listenerActive") : t("settings.voiceTyping.listenerInactive")}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          {t("settings.voiceTyping.shortcut")}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SHORTCUTS.map((shortcut) => {
            const isSelected = selected === shortcut;
            return (
              <Button
                key={shortcut}
                variant={isSelected ? "secondary" : "outline"}
                size="sm"
                className="h-10 justify-start gap-2 px-2 text-xs"
                onClick={() => void chooseShortcut(shortcut)}
              >
                {saving === shortcut ? <Loader2 className="size-3.5 animate-spin" /> : <Keyboard className="size-3.5" />}
                {t(SHORTCUT_LABEL_KEYS[shortcut])}
              </Button>
            );
          })}
        </div>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("settings.voiceTyping.conflictHint")}</span>
          </div>
        </div>
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
            await patch({ voiceTypingAutoPaste: on });
            // Auto-paste needs Accessibility — prompt the moment it's enabled.
            if (on) await invoke("accessibility_status", { prompt: true }).catch(() => {});
          }}
        />
      </label>

      {!status?.authorized && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {t("settings.voiceTyping.inputMonitoringHelp")}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={async () => {
              await invoke("request_input_monitoring").catch(() => {});
              await invoke("set_voice_typing_shortcut", { shortcut: selected }).catch(() => {});
              await refreshStatus();
            }}
          >
            {t("settings.voiceTyping.grant")}
          </Button>
        </div>
      )}
    </div>
  );
}
