import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Pencil, X } from "lucide-react";
// (icons shared by the grouped list below)
import { useAccounts } from "../../lib/accounts/store";
import type { Claim, ClaimCategory } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { loadHistoryEntry } from "../../lib/history/history";
import { log } from "../../lib/log";

/** Category → chip tint. Red lines scream; the rest stay muted. */
const CAT_CLASS: Record<ClaimCategory, string> = {
  stance: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  relation: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  leverage: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  goal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  risk: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  redline: "bg-red-500/15 text-red-700 dark:text-red-300",
  competitor: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  nextmove: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  openq: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
};

/** Category → group-header dot color. */
const CAT_DOT: Record<ClaimCategory, string> = {
  stance: "bg-sky-500",
  relation: "bg-violet-500",
  leverage: "bg-emerald-500",
  goal: "bg-teal-500",
  risk: "bg-amber-500",
  redline: "bg-red-500",
  competitor: "bg-rose-500",
  nextmove: "bg-indigo-500",
  openq: "bg-orange-500",
};

/** Display/edit order for the category pickers. */
export const CATEGORY_ORDER: ClaimCategory[] = [
  "redline",
  "openq",
  "stance",
  "relation",
  "leverage",
  "goal",
  "risk",
  "competitor",
  "nextmove",
];

function freshness(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One intel claim: category chip, the assertion, confidence + freshness, and
 * the universal affordances — expand evidence (jump back to the meeting),
 * EDIT (text + category; an edit is a user assertion), confirm, mark wrong
 * (design §4.3).
 */
export function ClaimCard({
  claim,
  row = false,
}: Readonly<{
  claim: Claim;
  /** Row mode: rendered inside a category group — no own border, no chip. */
  row?: boolean;
}>) {
  const { t } = useI18n();
  const confirmClaim = useAccounts((s) => s.confirmClaim);
  const markClaimWrong = useAccounts((s) => s.markClaimWrong);
  const updateClaim = useAccounts((s) => s.updateClaim);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftCat, setDraftCat] = useState<ClaimCategory>(claim.category);

  const quotes = claim.provenance.filter(
    (p): p is Extract<typeof p, { kind: "meeting" } | { kind: "import" }> =>
      p.kind !== "user" && !!(p.quote ?? "").trim()
  );

  const confidenceLabel =
    claim.confidence === "confirmed"
      ? t("accounts.claim.confirmed")
      : claim.confidence === "conflicted"
        ? t("accounts.claim.conflicted")
        : t("accounts.claim.inferred");
  const confidenceClass =
    claim.confidence === "confirmed"
      ? "text-emerald-600 dark:text-emerald-400"
      : claim.confidence === "conflicted"
        ? "font-semibold text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  async function jumpToMeeting(historyId: string) {
    try {
      await loadHistoryEntry(historyId);
    } catch (e) {
      log.warn("accounts: jump to meeting failed", { historyId, error: String(e) });
    }
  }

  function startEdit() {
    setDraftText(claim.text);
    setDraftCat(claim.category);
    setEditing(true);
  }

  function saveEdit() {
    const text = draftText.trim();
    if (!text) return;
    updateClaim(claim.id, { text, category: draftCat });
    // An edit is the user vouching for the corrected content.
    confirmClaim(claim.id);
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        className={
          row
            ? "border-l-2 border-ring/60 bg-muted/30 px-2.5 py-2"
            : "rounded-md border border-ring/50 bg-background/60 px-2.5 py-2"
        }
      >
        <div className="flex items-center gap-1.5">
          <select
            value={draftCat}
            onChange={(e) => setDraftCat(e.target.value as ClaimCategory)}
            className="h-7 shrink-0 rounded-md border bg-background px-1.5 text-xs"
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {t(`accounts.cat.${c}`)}
              </option>
            ))}
          </select>
          <input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="h-6 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("accounts.cancel")}
          </button>
          <button
            type="button"
            onClick={saveEdit}
            disabled={!draftText.trim()}
            className="h-6 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
          >
            {t("accounts.save")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        row
          ? "group px-2.5 py-2 transition-colors hover:bg-muted/40"
          : "group rounded-md border bg-background/60 px-2.5 py-1.5"
      }
    >
      <div className="flex items-start gap-2">
        {!row && (
          <span
            className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${CAT_CLASS[claim.category]}`}
          >
            {t(`accounts.cat.${claim.category}`)}
          </span>
        )}
        <p className="min-w-0 flex-1 text-sm leading-snug">{claim.text}</p>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            title={t("accounts.edit")}
            onClick={startEdit}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
          {claim.confidence !== "confirmed" && (
            <button
              type="button"
              title={t("accounts.claim.confirm")}
              onClick={() => confirmClaim(claim.id)}
              className="rounded p-0.5 text-muted-foreground hover:text-emerald-600"
            >
              <Check className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t("accounts.claim.wrong")}
            onClick={() => markClaimWrong(claim.id)}
            className="rounded p-0.5 text-muted-foreground hover:text-red-600"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-0.5 text-[10px] text-muted-foreground">
        <span className={confidenceClass}>{confidenceLabel}</span>
        <span>{freshness(claim.lastSupportedAt)}</span>
        {quotes.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-0.5 hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("accounts.claim.evidence")} ({quotes.length})
          </button>
        )}
      </div>
      {open && quotes.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-l-2 pl-2">
          {quotes.map((q, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              <span className="italic">「{q.quote}」</span>{" "}
              {q.kind === "meeting" ? (
                <button
                  type="button"
                  onClick={() => void jumpToMeeting(q.historyId)}
                  className="text-[10px] underline underline-offset-2 hover:text-foreground"
                >
                  {t("accounts.claim.fromMeeting")}
                </button>
              ) : (
                <span className="text-[10px]">{t("accounts.claim.fromImport")}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Claims grouped the way knowledge tools present dense info (Notion/Linear
 * grouped lists): one collapsible section per category — colored dot, label,
 * count — with light divided rows inside, instead of a flat wall of uniform
 * cards. The category chip lives on the group header, not on every row.
 */
export function ClaimList({
  claims,
  onAdd,
}: Readonly<{
  claims: Claim[];
  /** When present, renders the add row; the caller binds subjects/thread. */
  onAdd?: (category: ClaimCategory, text: string) => void;
}>) {
  const { t } = useI18n();
  const [category, setCategory] = useState<ClaimCategory>("stance");
  const [text, setText] = useState("");
  const [collapsed, setCollapsed] = useState<Partial<Record<ClaimCategory, boolean>>>({});

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: claims
      .filter((c) => c.category === cat)
      .sort((a, b) => b.lastSupportedAt - a.lastSupportedAt),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-2.5">
      {groups.length === 0 && (
        <p className="py-2 text-center text-xs text-muted-foreground">{t("accounts.noClaims")}</p>
      )}
      {groups.map((g) => {
        const isCollapsed = !!collapsed[g.cat];
        return (
          <section key={g.cat}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [g.cat]: !c[g.cat] }))}
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3 text-muted-foreground" />
              )}
              <span className={`size-2 rounded-full ${CAT_DOT[g.cat]}`} />
              <span className="text-xs font-semibold">{t(`accounts.cat.${g.cat}`)}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{g.items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="mt-1 divide-y divide-border/60 rounded-md border bg-background/60">
                {g.items.map((c) => (
                  <ClaimCard key={c.id} claim={c} row />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {onAdd && (
        <form
          className="mt-1 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onAdd(category, text.trim());
            setText("");
          }}
        >
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ClaimCategory)}
            className="h-7 shrink-0 rounded-md border bg-background px-1.5 text-xs"
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {t(`accounts.cat.${c}`)}
              </option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("accounts.claim.placeholder")}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="h-7 shrink-0 rounded-md border px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {t("accounts.claim.add")}
          </button>
        </form>
      )}
    </div>
  );
}
