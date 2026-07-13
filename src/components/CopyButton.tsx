import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../i18n";
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
  const copy = () => {
    navigator.clipboard.writeText(typeof value === "function" ? value() : value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  if (iconOnly) {
    return (
      <Button variant="ghost" size="icon" className={className} title={title} disabled={disabled} onClick={copy}>
        {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" className={className} title={title} disabled={disabled} onClick={copy}>
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
