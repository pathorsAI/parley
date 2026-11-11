import { Monitor, Moon, Sun } from "lucide-react";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { AppTheme } from "../../lib/types";

/**
 * Light / Dark / System at the foot of the sidebar, as a small icon-only
 * toggle (names on hover): the same setting as Settings › Basic › Theme, one
 * click away instead of a window away.
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
      className="pointer-events-auto inline-flex shrink-0 items-center gap-0.5 rounded-full border border-foreground/[0.06] bg-sidebar/40 p-0.5 shadow-sm backdrop-blur-md"
    >
      {options.map(([value, label, Icon]) => {
        const on = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => useStore.getState().updateSettings({ theme: value as AppTheme })}
            className={`grid size-6 cursor-pointer place-items-center rounded-full transition-colors ${
              on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground/70 hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
