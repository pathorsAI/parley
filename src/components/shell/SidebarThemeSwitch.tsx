import { Monitor, Moon, Sun } from "lucide-react";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { AppTheme } from "../../lib/types";

/**
 * Light / Dark / System at the foot of the sidebar: the same setting as
 * Settings › Basic › Theme, one click away instead of a window away.
 */
export function SidebarThemeSwitch() {
  const { t } = useI18n();
  const theme = useStore((s) => s.settings.theme);
  const options = [
    ["light", t("settings.basic.themeLight"), Sun],
    ["dark", t("settings.basic.themeDark"), Moon],
    ["system", t("settings.basic.themeSystem"), Monitor],
  ] as const;
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.basic.theme")}
      className="grid shrink-0 grid-cols-3 rounded-md bg-muted p-0.5"
    >
      {options.map(([value, label, Icon]) => {
        const on = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            title={label}
            onClick={() => useStore.getState().updateSettings({ theme: value as AppTheme })}
            className={`flex h-7 min-w-0 cursor-pointer items-center justify-center gap-1 rounded-[5px] px-1 text-[11px] transition-colors ${
              on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
