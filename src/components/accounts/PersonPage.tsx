import { ArrowLeft } from "lucide-react";
import { useAccounts, claimsAbout } from "../../lib/accounts/store";
import type { Person } from "../../lib/accounts/types";
import { COMMITTEE_ROLES } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ClaimList } from "./ClaimCard";
import { StanceDot } from "./bits";

/** A person's profile: identity + committee role, then every claim about them. */
export function PersonPage({
  person,
  onBack,
}: Readonly<{ person: Person; onBack: () => void }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const claims = claimsAbout(acc, person.id);
  const influencers = person.influencedBy
    .map((id) => acc.persons.find((p) => p.id === id)?.name)
    .filter(Boolean);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        <div className="flex items-start gap-3">
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold leading-tight">
              <StanceDot stance={person.stance?.value} />
              {person.name}
            </h2>
            <div className="flex items-center gap-2 pt-0.5 text-sm text-muted-foreground">
              <input
                value={person.title}
                onChange={(e) => acc.updatePerson(person.id, { title: e.target.value })}
                placeholder={t("accounts.personTitle")}
                className="h-6 w-44 rounded border bg-transparent px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
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
                <span className="text-xs">
                  {t(`accounts.stance.${person.stance.value}`)}
                  {person.stance.confidence === "inferred" && (
                    <span className="text-muted-foreground">（{t("accounts.claim.inferred")}）</span>
                  )}
                </span>
              )}
            </div>
            {influencers.length > 0 && (
              <p className="pt-1 text-xs text-muted-foreground">← {influencers.join("、")}</p>
            )}
          </div>
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
    </ScrollArea>
  );
}
