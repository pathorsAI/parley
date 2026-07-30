import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import { generateBattleBriefing } from "../../lib/accounts/briefing";
import type { Company } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * The generated battle briefing (design §4.2): prose is an OUTPUT of the claim
 * base, streamed on open, copyable as markdown. Corrections go to the claims.
 *
 * A side sheet, not a centered modal — the briefing is read ALONGSIDE the war
 * room or the pre-flight columns it summarizes, and a modal hides exactly the
 * cards the reader wants to check it against.
 */
export function BriefingSheet({
  company,
  open,
  onOpenChange,
}: Readonly<{ company: Company; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // survive StrictMode double-mount
    started.current = true;
    const acc = useAccounts.getState();
    const settings = useStore.getState().settings;
    generateBattleBriefing({
      settings,
      company,
      persons: personsOf(acc, company.id),
      threads: threadsOf(acc, company.id),
      claims: activeClaims(acc, company.id),
      onDelta: (chunk) => setText((v) => v + chunk),
    })
      .catch((e) => {
        log.error("accounts: briefing failed", { error: String(e) });
        setText((v) => v + `\n\n> ${String(e)}`);
      })
      .finally(() => setBusy(false));
  }, [company]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="max-w-xl"
        closeLabel={t("common.close")}
        title={t("accounts.briefing.title", { company: company.name })}
        footer={
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!text}
              onClick={() => {
                void navigator.clipboard.writeText(text);
                toast.success(t("accounts.briefing.copied"));
              }}
            >
              <Copy className="size-3.5" />
              {t("accounts.briefing.copy")}
            </Button>
            <Button size="sm" className="h-8" onClick={() => onOpenChange(false)}>
              {t("common.done")}
            </Button>
          </>
        }
      >
        <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("accounts.briefing.generating")}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
