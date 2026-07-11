import { Check } from "lucide-react";
import { toast } from "sonner";
import { useAccounts } from "../../lib/accounts/store";
import type { Claim } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";

/**
 * One conflict laid out as a decision (B-3): the two contradicting claims side
 * by side — each with its evidence quote and freshness — and a "keep this one"
 * per side. Keeping one marks the other wrong; the survivor is released from
 * the conflict (and confirmed, unless another conflict still hangs on it).
 */
export function ConflictPairCard({ a, b }: Readonly<{ a: Claim; b: Claim }>) {
  const { t } = useI18n();

  function keep(chosen: Claim, other: Claim) {
    const acc = useAccounts.getState();
    acc.markClaimWrong(other.id);
    // markClaimWrong released the survivor from THIS conflict; only vouch for
    // it outright when no other conflict still points at it.
    const survivor = useAccounts.getState().claims.find((c) => c.id === chosen.id);
    if (!survivor?.conflictsWith?.length) acc.confirmClaim(chosen.id);
    toast.success(t("accounts.triage.kept"));
  }

  return (
    <div className="overflow-hidden rounded-md border border-red-500/40">
      <div className="grid grid-cols-2 divide-x divide-red-500/30">
        {[
          { self: a, other: b },
          { self: b, other: a },
        ].map(({ self, other }) => {
          const quote = latestQuote(self);
          return (
            <div key={self.id} className="flex min-w-0 flex-col gap-1 p-2.5">
              <p className="min-w-0 break-words text-sm leading-snug">{self.text}</p>
              {quote && (
                <p className="line-clamp-3 text-xs italic text-muted-foreground" title={quote}>
                  「{quote}」
                </p>
              )}
              <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {new Date(self.lastSupportedAt).toISOString().slice(0, 10)}
                </span>
                <button
                  type="button"
                  onClick={() => keep(self, other)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300"
                >
                  <Check className="size-3" />
                  {t("accounts.triage.keep")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Newest provenance quote — the evidence a triage decision leans on. */
function latestQuote(c: Claim): string | null {
  for (let i = c.provenance.length - 1; i >= 0; i--) {
    const p = c.provenance[i];
    if (p.kind !== "user" && (p.quote ?? "").trim()) return (p.quote ?? "").trim();
  }
  return null;
}
