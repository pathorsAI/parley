import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "../i18n";
import { ICON_NAMES, resolveIcon } from "../lib/icons";

/**
 * Pick a scenario / kind icon from the fixed registry — the replacement for the
 * emoji text field that used to sit in these forms.
 *
 * A Popover rather than an inline grid because both callers live in a dense
 * `flex items-end` row of small labelled fields (kind sheet: icon + name; the
 * settings meta row: name + icon + eval template + delete). Expanding a 22-cell
 * grid in place would shove those rows apart every time the picker opens; the
 * popover keeps the row exactly one control tall. Not a Dialog: picking an icon
 * is a glance, not a task worth dimming the screen for.
 *
 * `z-[95]` matches Combobox — the plain `z-50` popover default renders BEHIND
 * the kind sheet, which sits at `z-[91]`.
 */
export function IconPicker({
  value,
  onChange,
  className,
}: Readonly<{
  /** Registry name; a legacy emoji or unknown string shows the default icon. */
  value: string | undefined;
  onChange: (name: string) => void;
  className?: string;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Current = resolveIcon(value);
  // A legacy emoji has no cell to highlight, so nothing is marked selected
  // until the user picks — which is honest: the stored value isn't in the set.
  const selected = value?.trim() ?? "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t("icons.pick")}
        title={t("icons.pick")}
        className={`flex h-8 w-10 cursor-pointer items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${className ?? ""}`}
      >
        <Current className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[95] w-auto p-2">
        <div className="grid grid-cols-6 gap-1">
          {ICON_NAMES.map((name) => {
            const Icon = resolveIcon(name);
            const isOn = name === selected;
            return (
              <button
                key={name}
                type="button"
                aria-label={name}
                aria-pressed={isOn}
                title={name}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
                className={`flex size-8 cursor-pointer items-center justify-center rounded-md border transition-colors ${
                  isOn
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
