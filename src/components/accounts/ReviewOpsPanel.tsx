import { useMemo, useState } from "react";
import { Check, Square } from "lucide-react";
import type {
  ExtractedClaimUpdate,
  ExtractedNewClaim,
  ExtractedNewPerson,
  ExtractedOps,
} from "../../lib/accounts/store";
import type { Claim } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The diff-review surface (design §5.4): every proposed op rendered as a row
 * with a checkbox (default ON), new-claim text editable inline. Approving
 * builds a filtered ExtractedOps that the caller hands to applyExtractedOps —
 * this panel itself never writes.
 */
export function ReviewOpsPanel({
  ops,
  existingClaims,
  onApply,
  onCancel,
}: Readonly<{
  ops: ExtractedOps;
  existingClaims: Claim[];
  onApply: (approved: ExtractedOps) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const [persons, setPersons] = useState<{ item: ExtractedNewPerson; on: boolean }[]>(
    ops.newPersons.map((item) => ({ item, on: true }))
  );
  const [claims, setClaims] = useState<{ item: ExtractedNewClaim; on: boolean }[]>(
    ops.newClaims.map((item) => ({ item, on: true }))
  );
  const [updates, setUpdates] = useState<{ item: ExtractedClaimUpdate; on: boolean }[]>(
    ops.claimUpdates.map((item) => ({ item, on: true }))
  );

  const byId = useMemo(
    () => new Map(existingClaims.map((c) => [c.id, c])),
    [existingClaims]
  );

  const total =
    persons.filter((x) => x.on).length +
    claims.filter((x) => x.on).length +
    updates.filter((x) => x.on).length;
  const empty = !persons.length && !claims.length && !updates.length;

  function approve() {
    onApply({
      newPersons: persons.filter((x) => x.on).map((x) => x.item),
      newClaims: claims.filter((x) => x.on).map((x) => x.item),
      claimUpdates: updates.filter((x) => x.on).map((x) => x.item),
    });
  }

  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
    >
      {on ? <Check className="size-4 text-emerald-500" /> : <Square className="size-4" />}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="pb-2 text-xs text-muted-foreground">{t("accounts.review.hint")}</p>
      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        <div className="flex flex-col gap-3 p-2.5">
          {empty && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("accounts.review.empty")}
            </p>
          )}

          {persons.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("accounts.review.persons")}
              </h4>
              {persons.map((row, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Toggle
                    on={row.on}
                    onClick={() =>
                      setPersons((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))
                    }
                  />
                  <div className={row.on ? "" : "opacity-40"}>
                    <b>{row.item.name}</b>
                    {row.item.title && <span className="text-muted-foreground">（{row.item.title}）</span>}
                    {row.item.committeeRole && (
                      <span className="ml-1 rounded bg-muted px-1 text-[10px]">{row.item.committeeRole}</span>
                    )}
                    <p className="text-xs text-muted-foreground">{row.item.reason}</p>
                  </div>
                </div>
              ))}
            </section>
          )}

          {claims.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("accounts.review.claims")}
              </h4>
              {claims.map((row, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Toggle
                    on={row.on}
                    onClick={() =>
                      setClaims((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))
                    }
                  />
                  <div className={`min-w-0 flex-1 ${row.on ? "" : "opacity-40"}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                        {t(`accounts.cat.${row.item.category}`)}
                      </span>
                      {row.item.subjects.length > 0 && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          @{row.item.subjects.join(", ")}
                        </span>
                      )}
                    </div>
                    <input
                      value={row.item.text}
                      onChange={(e) =>
                        setClaims((xs) =>
                          xs.map((x, j) =>
                            j === i ? { ...x, item: { ...x.item, text: e.target.value } } : x
                          )
                        )
                      }
                      className="mt-0.5 w-full rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                    />
                    {row.item.quote && (
                      <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                        「{row.item.quote}」
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}

          {updates.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("accounts.review.updates")}
              </h4>
              {updates.map((row, i) => {
                const target = byId.get(row.item.claimId);
                return (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Toggle
                      on={row.on}
                      onClick={() =>
                        setUpdates((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))
                      }
                    />
                    <div className={`min-w-0 flex-1 ${row.on ? "" : "opacity-40"}`}>
                      <span
                        className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          row.item.action === "support"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : row.item.action === "supersede"
                              ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                              : "bg-red-500/15 text-red-700 dark:text-red-300"
                        }`}
                      >
                        {t(`accounts.review.${row.item.action}`)}
                      </span>
                      <span className="text-xs text-muted-foreground line-through">
                        {target?.text ?? row.item.claimId}
                      </span>
                      {row.item.newText && <p className="text-sm">{row.item.newText}</p>}
                      {row.item.quote && (
                        <p className="truncate text-xs italic text-muted-foreground">
                          「{row.item.quote}」
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </ScrollArea>
      <div className="flex justify-end gap-2 pt-3">
        <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>
          {t("accounts.back")}
        </Button>
        <Button size="sm" className="h-8" disabled={total === 0} onClick={approve}>
          {t("accounts.review.apply", { n: total })}
        </Button>
      </div>
    </div>
  );
}
