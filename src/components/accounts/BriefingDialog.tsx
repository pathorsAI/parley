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
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The generated battle briefing (design §4.2): prose is an OUTPUT of the claim
 * base, streamed on open, copyable as markdown. Corrections go to the claims.
 */
export function BriefingDialog({
  company,
  onClose,
}: Readonly<{ company: Company; onClose: () => void }>) {
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <button type="button" aria-label="close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-background p-4 shadow-xl">
        <div className="flex items-center justify-between pb-3">
          <h3 className="text-sm font-semibold">
            {t("accounts.briefing.title", { company: company.name })}
            {busy && <Loader2 className="ml-2 inline size-3.5 animate-spin text-muted-foreground" />}
          </h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={!text}
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast.success(t("accounts.briefing.copied"));
            }}
          >
            <Copy className="size-3.5" />
            {t("accounts.briefing.copy")}
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 rounded-md border">
          <div className="prose prose-sm dark:prose-invert max-w-none p-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </ScrollArea>
        <div className="flex justify-end pt-3">
          <Button size="sm" className="h-8" onClick={onClose}>
            {t("common.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}
