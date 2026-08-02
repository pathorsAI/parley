import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ExternalLink, Languages, PictureInPicture2, Settings2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { formatElapsed, translateCostUsd, useMeetingTranslateElapsed } from "../lib/translateCost";
import { openInterpreterWindow, openLiveTranslateWindow } from "../lib/liveTranslate";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TranslateLanguagePicker, TranslateSwitch } from "./TranslateQuickControls";

interface VirtualMicStatus {
  deviceVisible: boolean;
  driverInstalled: boolean;
  pkgAvailable: boolean;
  deviceName: string;
}

/** One action row, styled like a dropdown-menu item. Disabled rows keep their
 *  reason-tooltip on a wrapping span (disabled = pointer-events:none). */
function MenuAction({
  icon: Icon,
  disabled = false,
  hint,
  onClick,
  children,
}: Readonly<{
  icon: LucideIcon;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <span title={disabled ? hint : undefined} className="block">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {children}
      </button>
    </span>
  );
}

/**
 * The ONE 🌐 entry (R4): a titlebar popover fronting every translation surface —
 * the meeting-translation master switch + target language, the floating
 * subtitle HUD, the standalone in-person window, and a deep-link into
 * Settings → 翻譯 for everything else (devices, virtual mic, API key).
 */
export function TranslateMenu() {
  const { t } = useI18n();
  const enabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const status = useStore((s) => s.meetingStatus);
  const openSettingsRoute = useStore((s) => s.openSettings);
  const meetingActive = status === "recording" || status === "paused";
  const { active: translating, elapsedSec } = useMeetingTranslateElapsed();
  const [open, setOpen] = useState(false);
  const [mic, setMic] = useState<VirtualMicStatus | null>(null);

  // Virtual-mic state is queried on open, not polled: installs happen in
  // Settings / the standalone window, and reopening the menu re-checks.
  useEffect(() => {
    if (!open || !isTauri()) return;
    invoke<VirtualMicStatus>("virtual_mic_status").then(setMic).catch(() => {});
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative h-8 w-8"
          aria-label={t("translate.menu.title")}
          title={t("translate.menu.title")}
        >
          <Languages className="size-4" />
          {enabled && (
            <span className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        {/* Master switch + status summary */}
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("translate.menu.meeting")}</p>
              {/* No language here: the picker two rows down already names it,
                  and repeating it read as two different settings. */}
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {mic &&
                  (mic.deviceVisible ? (
                    <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" />
                      {t("translate.menu.virtualMicOk")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5">
                      <X className="size-3" />
                      {t("translate.menu.virtualMicMissing")}
                    </span>
                  ))}
              </p>
            </div>
            <TranslateSwitch disabled={meetingActive} />
          </div>
          {translating && (
            <p className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatElapsed(elapsedSec)} · ${translateCostUsd(elapsedSec)}
            </p>
          )}
          {meetingActive && (
            <p className="text-[11px] text-muted-foreground">
              {t("translate.menu.lockedInMeeting")}
            </p>
          )}
          <TranslateLanguagePicker disabled={meetingActive} className="w-full" />
        </div>

        <div className="border-t p-1">
          <MenuAction
            icon={PictureInPicture2}
            disabled={!translating}
            hint={t("translate.menu.popoutHudHint")}
            onClick={() => {
              void openInterpreterWindow();
              setOpen(false);
            }}
          >
            {t("translate.menu.popoutHud")}
          </MenuAction>
          <MenuAction
            icon={ExternalLink}
            onClick={() => {
              openLiveTranslateWindow().catch((error) =>
                log.error("live-translate: open window failed", { error: String(error) })
              );
              setOpen(false);
            }}
          >
            {t("translate.menu.standalone")}
          </MenuAction>
        </div>

        <div className="border-t p-1">
          <MenuAction
            icon={Settings2}
            disabled={meetingActive}
            hint={t("titlebar.lockedWhileMeeting")}
            onClick={() => {
              openSettingsRoute("translate");
              setOpen(false);
            }}
          >
            {t("translate.menu.openSettings")}
          </MenuAction>
        </div>
      </PopoverContent>
    </Popover>
  );
}
