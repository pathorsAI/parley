import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import type { ExtractedOps } from "../../lib/accounts/store";
import { extractClaimOps } from "../../lib/accounts/extract";
import { hasProviderKey } from "../../lib/ai/settings";
import type { Company } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { toast } from "sonner";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ReviewOpsPanel } from "./ReviewOpsPanel";

/**
 * Onboarding / continuous feeding (design §5.1): paste source material for a
 * company → extraction proposes ops → item-by-item review → apply. External
 * analyses enter as `inferred` no matter how confidently they're written.
 */
export function FeedDataDialog({
  company,
  onClose,
}: Readonly<{ company: Company; onClose: () => void }>) {
  const { t } = useI18n();
  // Default to transcript — the most common thing pasted in (design D11).
  const [kind, setKind] = useState<"transcript" | "note" | "chatlog">("transcript");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ops, setOps] = useState<ExtractedOps | null>(null);

  async function run() {
    const state = useStore.getState();
    if (!hasProviderKey(state.settings, "deep") || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const acc = useAccounts.getState();
      const proposed = await extractClaimOps({
        settings: state.settings,
        company,
        persons: personsOf(acc, company.id),
        threads: threadsOf(acc, company.id),
        existingClaims: activeClaims(acc, company.id),
        sourceText: text,
        sourceLabel:
          kind === "transcript" ? "meeting transcript" : kind === "chatlog" ? "chat log" : "notes",
      });
      setOps(proposed);
    } catch (e) {
      log.error("accounts: feed extraction failed", { error: String(e) });
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function apply(approved: ExtractedOps) {
    const acc = useAccounts.getState();
    // The pasted material becomes an attachment; approved claims cite it.
    const attachment = acc.addAttachment({
      companyId: company.id,
      name: name || t(`accounts.feed.kind.${kind}`),
      // Pasted transcripts live as "doc" sources for now; the real text-ingest
      // path (transcript → HistoryEntry) is a tracked follow-up (issue #130).
      kind: kind === "transcript" ? "doc" : kind,
      text,
    });
    acc.applyExtractedOps({
      companyId: company.id,
      ops: approved,
      provenance: { kind: "import", attachmentId: attachment.id },
    });
    const n =
      approved.newPersons.length + approved.newClaims.length + approved.claimUpdates.length;
    toast.success(t("accounts.review.applied", { n }));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <button type="button" aria-label="close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-background p-4 shadow-xl">
        <h3 className="pb-3 text-sm font-semibold">
          {ops ? t("accounts.review.title") : t("accounts.feed.title", { company: company.name })}
        </h3>

        {ops ? (
          <ReviewOpsPanel
            ops={ops}
            existingClaims={activeClaims(useAccounts.getState(), company.id)}
            onApply={apply}
            onCancel={() => setOps(null)}
          />
        ) : (
          <>
            <div className="flex gap-2 pb-2">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "transcript" | "note" | "chatlog")}
                className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
                title={t("accounts.feed.kindLabel")}
              >
                <option value="transcript">{t("accounts.feed.kind.transcript")}</option>
                <option value="note">{t("accounts.feed.kind.note")}</option>
                <option value="chatlog">{t("accounts.feed.kind.chatlog")}</option>
              </select>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("accounts.feed.name")}
                className="h-8 text-xs"
              />
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("accounts.feed.paste")}
              // Fixed-size + internal scroll: the primitive's field-sizing-content
              // would grow with a pasted hour-long transcript and burst the dialog.
              className="h-64 min-h-0 flex-1 resize-none overflow-y-auto text-sm [field-sizing:fixed]"
            />
            {error && (
              <p className="pt-2 text-xs text-red-600">{t("accounts.feed.error", { error })}</p>
            )}
            <div className="flex justify-end gap-2 pt-3">
              <Button size="sm" variant="outline" className="h-8" onClick={onClose}>
                {t("accounts.back")}
              </Button>
              <Button size="sm" className="h-8" disabled={busy || !text.trim()} onClick={() => void run()}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {busy ? t("accounts.feed.running") : t("accounts.feed.run")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
