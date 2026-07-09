import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Languages, CheckCircle2 } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { TRANSLATE_LANGUAGES, TRANSLATE_USD_PER_MINUTE } from "../lib/translateLanguages";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DEFAULT_DEVICE = "__default__";
/** The virtual device published by the bundled driver (virtual_mic.rs). */
const VIRTUAL_MIC = "Parley Microphone";

/**
 * The meeting-translation composer: a 🌐 titlebar button opening a small panel
 * where THIS meeting's translation is configured in place — enable, target
 * language, output device — so starting a translated meeting never requires a
 * trip to another window. State lives in settings (remembered across meetings).
 */
export function TranslateMenu() {
  const { t } = useI18n();
  const enabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const language = useStore((s) => s.settings.translateTargetLanguage);
  const outputDevice = useStore((s) => s.settings.translateOutputDevice);
  const geminiApiKey = useStore((s) => s.settings.geminiApiKey);
  const updateSettings = useStore((s) => s.updateSettings);

  const [open, setOpen] = useState(false);
  const [outputs, setOutputs] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh the device list every time the panel opens (the virtual mic may
  // have just been installed).
  useEffect(() => {
    if (!open || !isTauri()) return;
    invoke<string[]>("list_output_devices").then(setOutputs).catch(() => {});
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasVirtualMic = outputs.includes(VIRTUAL_MIC);
  const hasKey = geminiApiKey.trim().length > 0;

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant={enabled ? "secondary" : "ghost"}
        onClick={() => setOpen((o) => !o)}
        title={t("titlebar.translate.tooltip")}
        className={`h-8 ${enabled ? "text-emerald-600 dark:text-emerald-400" : ""}`}
      >
        <Languages className="size-3.5" />
        {enabled ? language.toUpperCase() : t("titlebar.translate")}
      </Button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
          {/* Enable */}
          <button
            type="button"
            onClick={() => updateSettings({ meetingTranslateEnabled: !enabled })}
            className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <span>{t("meeting.translate.enable")}</span>
            <span
              className={`relative h-4.5 w-8 rounded-full transition-colors ${
                enabled ? "bg-emerald-500" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-[left,right] ${
                  enabled ? "right-0.5 left-auto" : "left-0.5"
                }`}
              />
            </span>
          </button>
          <p className="mb-2 px-1 text-xs leading-relaxed text-muted-foreground">
            {t("meeting.translate.hint", {
              rate: TRANSLATE_USD_PER_MINUTE.toFixed(4),
            })}
          </p>

          {enabled && (
            <div className="flex flex-col gap-2.5 border-t pt-2.5">
              {/* Target language */}
              <div className="flex flex-col gap-1">
                <span className="px-1 text-xs font-medium text-muted-foreground">
                  {t("meeting.translate.language")}
                </span>
                <Select
                  value={language}
                  onValueChange={(v) => updateSettings({ translateTargetLanguage: v })}
                >
                  <SelectTrigger className="h-8 w-full">
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

              {/* Output device */}
              <div className="flex flex-col gap-1">
                <span className="px-1 text-xs font-medium text-muted-foreground">
                  {t("meeting.translate.output")}
                </span>
                <Select
                  value={outputDevice || DEFAULT_DEVICE}
                  onValueChange={(v) =>
                    updateSettings({ translateOutputDevice: v === DEFAULT_DEVICE ? "" : v })
                  }
                >
                  <SelectTrigger className="h-8 w-full">
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
                {hasVirtualMic && outputDevice === VIRTUAL_MIC ? (
                  <span className="flex items-center gap-1 px-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> {t("meeting.translate.virtualMicOk")}
                  </span>
                ) : (
                  <span className="px-1 text-xs text-muted-foreground">
                    {hasVirtualMic
                      ? t("meeting.translate.pickVirtualMic")
                      : t("meeting.translate.noVirtualMic")}
                  </span>
                )}
              </div>

              {!hasKey && (
                <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                  {t("meeting.translate.noKey")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
