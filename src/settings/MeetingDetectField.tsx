import { X } from "lucide-react";
import { unmuteApp } from "../lib/meeting/detect";
import { useI18n } from "../i18n";
import type { SettingsPanelProps } from "./categories/types";

/** Settings: ask to record when another app starts a call (#606), and the
 *  apps the user told it not to ask about. */
export function MeetingDetectField({ settings, patch }: Readonly<SettingsPanelProps>) {
  const { t } = useI18n();
  const muted = settings.meetingDetectMutedApps;
  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={settings.meetingDetectEnabled}
          onChange={(e) => patch({ meetingDetectEnabled: e.target.checked })}
        />
        {t("settings.meetingDetect.title")}
      </label>
      <p className="text-[11px] text-muted-foreground">{t("settings.meetingDetect.hint")}</p>
      {muted.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">{t("settings.meetingDetect.muted")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {muted.map((app) => (
              <li
                key={app.id}
                className="flex h-6 items-center gap-1 rounded-full border bg-muted/50 pr-1 pl-2.5 text-xs"
                title={app.id}
              >
                {app.name}
                <button
                  type="button"
                  aria-label={t("settings.meetingDetect.unmute", { app: app.name })}
                  onClick={() => patch({ meetingDetectMutedApps: unmuteApp(muted, app.id) })}
                  className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
