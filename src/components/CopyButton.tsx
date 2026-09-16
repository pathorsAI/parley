import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";

/** Copy-to-clipboard button with a 2s "copied" confirmation. */
export function CopyButton({
  value,
  label,
  title,
  className,
  iconOnly,
  disabled,
}: Readonly<{
  /** Text to copy, or a thunk evaluated at click time for computed values. */
  value: string | (() => string);
  label?: string;
  title?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
}>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // The checkmark is a claim about the clipboard, so it waits for the clipboard
  // to agree: WebView2 rejects writeText outright when its controller isn't the
  // focused window, and this button is how the MCP panel and the diagnostics
  // view hand out text a user is about to paste somewhere that matters.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      log.warn("clipboard copy failed", { error: String(e) });
      toast.error(t("common.copyFailed"));
    }
  };
  const onClick = () => void copy();
  if (iconOnly) {
    return (
      <Button variant="ghost" size="icon" className={className} title={title} disabled={disabled} onClick={onClick}>
        {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" className={className} title={title} disabled={disabled} onClick={onClick}>
      {copied ? (
        <>
          <Check className="size-3.5 text-emerald-500" />
          <span>{t("settings.mcp.copied")}</span>
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          <span>{label}</span>
        </>
      )}
    </Button>
  );
}
