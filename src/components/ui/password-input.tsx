import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "./input";
import { translate } from "../../i18n/messages";
import { useStore } from "../../lib/store";

/**
 * A secret input (API keys) that masks its value like `type="password"` but adds
 * an eye button to reveal/hide it. Behaves like {@link Input}; `className` sizes
 * the field (applied to the wrapper so width constraints like `max-w-sm` still
 * work). The toggle is hidden while the field is disabled, since there's nothing
 * meaningful to reveal.
 */
function PasswordInput({
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = React.useState(false);
  const language = useStore((s) => s.settings.language);
  const shown = visible && !disabled;

  return (
    <div className={cn("relative", className)}>
      <Input
        {...props}
        type={shown ? "text" : "password"}
        disabled={disabled}
        className="pr-9"
      />
      {!disabled && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={translate(language, shown ? "common.hideKey" : "common.showKey")}
          aria-pressed={shown}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
    </div>
  );
}

export { PasswordInput };
