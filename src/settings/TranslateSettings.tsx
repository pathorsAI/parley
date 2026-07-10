import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import { log } from "../lib/log";
import { TRANSLATE_LANGUAGES, TRANSLATE_USD_PER_MINUTE } from "../lib/translateLanguages";
import type { Settings } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DEFAULT_DEVICE = "__default__";

interface VirtualMicStatus {
  deviceVisible: boolean;
  driverInstalled: boolean;
  pkgAvailable: boolean;
  deviceName: string;
}

/**
 * Settings → 即時翻譯: the meeting-translation configuration (enable, target
 * language, output device, virtual-mic install). The titlebar 🌐 button is just
 * the on/off switch; everything configurable lives here.
 */
export function TranslateSettings() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const patch = useCallback(
    (p: Partial<Settings>) => {
      updateSettings(p);
      broadcastSettings({ ...useStore.getState().settings }).catch((e) =>
        log.warn("settings: broadcast failed", { error: String(e) })
      );
    },
    [updateSettings]
  );

  const [outputs, setOutputs] = useState<string[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [mic, setMic] = useState<VirtualMicStatus | null>(null);
  const [installing, setInstalling] = useState(false);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    invoke<string[]>("list_output_devices").then(setOutputs).catch(() => {});
    invoke<string[]>("list_input_devices").then(setInputs).catch(() => {});
    invoke<VirtualMicStatus>("virtual_mic_status").then(setMic).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const install = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await invoke("install_virtual_mic");
      // Device registration after the coreaudiod reload isn't instant.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const s = await invoke<VirtualMicStatus>("virtual_mic_status");
        setMic(s);
        if (s.deviceVisible) {
          patch({ translateOutputDevice: s.deviceName });
          break;
        }
      }
      refresh();
    } catch (e) {
      if (!String(e).includes("cancelled")) {
        log.error("virtual-mic: install failed", { error: String(e) });
      }
    } finally {
      setInstalling(false);
    }
  }, [installing, patch, refresh]);

  const hasKey = settings.geminiApiKey.trim().length > 0;

  return (
    <div className="flex max-w-md flex-col gap-5">
      {/* Gemini API key — shared with the LLM provider settings; translation
          needs a key with gemini-3.5-live-translate-preview access. */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{t("settings.translate.apiKey")}</Label>
        <PasswordInput
          value={settings.geminiApiKey}
          onChange={(e) => patch({ geminiApiKey: e.target.value })}
          placeholder="AIza…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">{t("settings.translate.apiKeyHint")}</p>
      </div>

      {/* Enable */}
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm">{t("meeting.translate.enable")}</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("meeting.translate.hint", { rate: TRANSLATE_USD_PER_MINUTE.toFixed(4) })}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.meetingTranslateEnabled}
          onClick={() => patch({ meetingTranslateEnabled: !settings.meetingTranslateEnabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            settings.meetingTranslateEnabled ? "bg-emerald-500" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
              settings.meetingTranslateEnabled ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Target language */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{t("meeting.translate.language")}</Label>
        <Select
          value={settings.translateTargetLanguage}
          onValueChange={(v) => patch({ translateTargetLanguage: v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSLATE_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.nativeLabel}
                <span className="ml-2 text-muted-foreground">{l.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Output device + virtual mic */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{t("meeting.translate.output")}</Label>
        <Select
          value={settings.translateOutputDevice || DEFAULT_DEVICE}
          onValueChange={(v) => patch({ translateOutputDevice: v === DEFAULT_DEVICE ? "" : v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_DEVICE}>{t("settings.transcription.systemDefault")}</SelectItem>
            {outputs.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mic?.deviceVisible ? (
          settings.translateOutputDevice === mic.deviceName ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" /> {t("meeting.translate.virtualMicOk")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("meeting.translate.pickVirtualMic")}</span>
          )
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("meeting.translate.noVirtualMic")}</span>
            {mic?.pkgAvailable && (
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={install} disabled={installing}>
                {installing ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                {t("settings.translate.install")}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Source mic for the standalone quick-interpreter window (meetings use
          the transcription mic). */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{t("settings.translate.inputDevice")}</Label>
        <Select
          value={settings.translateInputDevice || DEFAULT_DEVICE}
          onValueChange={(v) => patch({ translateInputDevice: v === DEFAULT_DEVICE ? "" : v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_DEVICE}>{t("settings.transcription.systemDefault")}</SelectItem>
            {inputs.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!hasKey && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t("meeting.translate.noKey")}
        </p>
      )}
    </div>
  );
}
