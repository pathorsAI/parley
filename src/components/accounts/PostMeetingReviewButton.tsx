import { useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { useStore, transcriptAsText } from "../../lib/store";
import { useAccounts, personsOf, threadsOf, activeClaims } from "../../lib/accounts/store";
import type { ExtractedOps } from "../../lib/accounts/store";
import { extractClaimOps } from "../../lib/accounts/extract";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { toast } from "sonner";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import { ReviewOpsPanel } from "./ReviewOpsPanel";

/**
 * Post-meeting review (design §5.4) — the ONLY write path from a meeting into
 * the claim base. Shown in the titlebar while a company-linked recording is
 * loaded; runs extraction over the transcript, then the item-by-item review.
 */
export function PostMeetingReviewButton() {
  const { t } = useI18n();
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const historyId = useStore((s) => s.loadedHistoryId);
  const company = useAccounts((s) => s.companies.find((c) => c.id === companyId) ?? null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ops, setOps] = useState<ExtractedOps | null>(null);

  if (!company || !historyId) return null;

  async function run() {
    const state = useStore.getState();
    if (!hasProviderKey(state.settings) || !company) return;
    setBusy(true);
    setOpen(true);
    try {
      const acc = useAccounts.getState();
      const proposed = await extractClaimOps({
        settings: state.settings,
        company,
        persons: personsOf(acc, company.id),
        threads: threadsOf(acc, company.id),
        existingClaims: activeClaims(acc, company.id),
        sourceText: transcriptAsText(state.segments, state.speakerNames),
        sourceLabel: "meeting transcript",
      });
      setOps(proposed);
    } catch (e) {
      log.error("accounts: post-meeting extraction failed", { error: String(e) });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function apply(approved: ExtractedOps) {
    if (!company || !historyId) return;
    useAccounts.getState().applyExtractedOps({
      companyId: company.id,
      threadId: threadId ?? undefined,
      ops: approved,
      provenance: { kind: "meeting", historyId, quote: "" },
    });
    const n =
      approved.newPersons.length + approved.newClaims.length + approved.claimUpdates.length;
    toast.success(t("accounts.review.applied", { n }));
    setOps(null);
    setOpen(false);
  }

  return (
    <>
      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardCheck className="size-3.5" />}
        {t("accounts.postmeeting.run")}
      </Button>
      {open &&
        createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
          <button
            type="button"
            aria-label="close"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-background p-4 shadow-xl">
            <h3 className="pb-3 text-sm font-semibold">
              {t("accounts.review.title")} — {company.name}
            </h3>
            {ops ? (
              <ReviewOpsPanel
                ops={ops}
                existingClaims={activeClaims(useAccounts.getState(), company.id)}
                onApply={apply}
                onCancel={() => setOpen(false)}
              />
            ) : (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
