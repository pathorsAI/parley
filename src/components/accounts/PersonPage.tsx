import { ArrowLeft, X } from "lucide-react";
import { useAccounts, claimsAbout, personsOf } from "../../lib/accounts/store";
import type { Person } from "../../lib/accounts/types";
import { COMMITTEE_ROLES } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ClaimList } from "./ClaimCard";
import { AliasesEdit, ArchiveButton, InlineEdit, StanceDot } from "./bits";

/** A person's profile: identity (all editable in place) + every claim about them. */
export function PersonPage({
  person,
  onBack,
}: Readonly<{ person: Person; onBack: () => void }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const claims = claimsAbout(acc, person.id);
  const colleagues = personsOf(acc, person.companyId).filter((p) => p.id !== person.id);
  const influencers = person.influencedBy
    .map((id) => acc.persons.find((p) => p.id === id))
    .filter((p): p is Person => !!p);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        <div className="flex items-start gap-3">
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StanceDot stance={person.stance?.value} />
              <InlineEdit
                value={person.name}
                required
                onCommit={(name) => acc.updatePerson(person.id, { name })}
                className="h-8 text-lg font-semibold leading-tight"
              />
            </div>
            <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
              <InlineEdit
                value={person.title}
                onCommit={(title) => acc.updatePerson(person.id, { title })}
                placeholder={t("accounts.personTitle")}
                className="h-6 w-44 text-xs"
              />
              <select
                value={person.committeeRole ?? ""}
                onChange={(e) =>
                  acc.updatePerson(person.id, {
                    committeeRole: (e.target.value || undefined) as Person["committeeRole"],
                  })
                }
                className="h-6 rounded border bg-background px-1 text-xs"
              >
                <option value="">—</option>
                {COMMITTEE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`accounts.role.${r}`)}
                  </option>
                ))}
              </select>
              {person.stance && (
                <span className="shrink-0 text-xs">
                  {t(`accounts.stance.${person.stance.value}`)}
                  {person.stance.confidence === "inferred" && (
                    <span className="text-muted-foreground">（{t("accounts.claim.inferred")}）</span>
                  )}
                </span>
              )}
            </div>
            {/* Aliases feed transcript/extraction matching — 「貴哥」「Jasper」. */}
            <div className="flex items-center gap-1.5 pt-1">
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("accounts.aliases")}
              </span>
              <AliasesEdit
                aliases={person.aliases}
                onCommit={(aliases) => acc.updatePerson(person.id, { aliases })}
              />
            </div>
            {/* Influenced-by: chips with remove + an add picker (design D5). */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("accounts.influencedBy")}
              </span>
              {influencers.map((p) => (
                <span
                  key={p.id}
                  className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                >
                  {p.name}
                  <button
                    type="button"
                    onClick={() =>
                      acc.updatePerson(person.id, {
                        influencedBy: person.influencedBy.filter((id) => id !== p.id),
                      })
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {colleagues.some((p) => !person.influencedBy.includes(p.id)) && (
                <select
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    acc.updatePerson(person.id, {
                      influencedBy: [...person.influencedBy, e.target.value],
                    });
                  }}
                  className="h-6 rounded border bg-background px-1 text-[10px] text-muted-foreground"
                >
                  <option value="">{t("accounts.addInfluencer")}</option>
                  {colleagues
                    .filter((p) => !person.influencedBy.includes(p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </div>
          <ArchiveButton
            onArchive={() => {
              acc.archivePerson(person.id);
              onBack();
            }}
          />
        </div>

        <ClaimList
          claims={claims}
          onAdd={(category, text) =>
            acc.addClaim({
              companyId: person.companyId,
              subjects: [person.id],
              category,
              text,
              provenance: [{ kind: "user" }],
              confidence: "confirmed",
            })
          }
        />
      </div>
    </div>
  );
}
