import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
} from "lucide-react";
import { useAccounts, claimsAbout, personsOf } from "../../lib/accounts/store";
import type { Person } from "../../lib/accounts/types";
import { COMMITTEE_ROLES } from "../../lib/accounts/types";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ClaimList } from "./ClaimCard";
import { AliasesEdit, ArchiveButton, InlineEdit, StanceDot } from "./bits";

/**
 * Right rail of the accounts workspace: the stakeholder roster — who's who at
 * this company, stance at a glance. Clicking a person opens their profile in
 * the rail (identity, aliases, influence, every claim about them) without
 * losing the war room in the center.
 */
export function PeopleRail({ companyId }: Readonly<{ companyId: string }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const persons = personsOf(acc, companyId);
  const archived = acc.persons.filter((p) => p.companyId === companyId && p.archived);
  const [personId, setPersonId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  // Archived people stay viewable — look the id up across the whole roster.
  const person = personId
    ? acc.persons.find((p) => p.id === personId && p.companyId === companyId)
    : null;
  if (person) {
    return (
      <PersonDetail person={person} onBack={() => setPersonId(null)} />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 pt-2.5 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("accounts.people")}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex flex-col gap-1">
          {persons.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPersonId(p.id)}
              className="flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left hover:bg-muted/50"
            >
              <span className="flex items-center gap-2">
                <StanceDot stance={p.stance?.value} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                {p.committeeRole && (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">
                    {t(`accounts.role.${p.committeeRole}`)}
                  </span>
                )}
              </span>
              {p.title && (
                <span className="truncate pl-4 text-xs text-muted-foreground">{p.title}</span>
              )}
            </button>
          ))}
        </div>

        {/* Archived people: view on click, restore in one. */}
        {archived.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
            >
              {showArchived ? (
                <ChevronDown className="size-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 text-muted-foreground" />
              )}
              <span className="text-xs text-muted-foreground">{t("accounts.archived")}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {archived.length}
              </span>
            </button>
            {showArchived && (
              <div className="flex flex-col gap-0.5">
                {archived.map((p) => (
                  <div
                    key={p.id}
                    className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      onClick={() => setPersonId(p.id)}
                      className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground"
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      title={t("accounts.restore")}
                      onClick={() => acc.unarchivePerson(p.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover:text-muted-foreground"
                    >
                      <ArchiveRestore className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <form
        className="flex shrink-0 flex-col gap-1.5 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const p = useAccounts.getState().addPerson({ companyId, name, title });
          setName("");
          setTitle("");
          setPersonId(p.id);
        }}
      >
        <div className="flex items-center gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("accounts.personName")}
            className="h-7 w-24 shrink-0 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("accounts.personTitle")}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            title={t("accounts.newPerson")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}

/** In-rail person profile: identity all editable in place + claims about them. */
function PersonDetail({
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-2 pt-2">
        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <StanceDot stance={person.stance?.value} />
        <InlineEdit
          value={person.name}
          required
          onCommit={(name) => acc.updatePerson(person.id, { name })}
          className="h-7 text-sm font-semibold"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="flex flex-col gap-1.5 pt-1.5">
          {person.archived && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5">
              <Archive className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="min-w-0 flex-1 text-xs text-amber-700 dark:text-amber-300">
                {t("accounts.archivedPersonBanner")}
              </span>
              <button
                type="button"
                onClick={() => acc.unarchivePerson(person.id)}
                className="flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <ArchiveRestore className="size-3" />
                {t("accounts.restore")}
              </button>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <InlineEdit
              value={person.title}
              onCommit={(title) => acc.updatePerson(person.id, { title })}
              placeholder={t("accounts.personTitle")}
              className="h-6 min-w-0 flex-1 text-xs text-muted-foreground"
            />
            <select
              value={person.committeeRole ?? ""}
              onChange={(e) =>
                acc.updatePerson(person.id, {
                  committeeRole: (e.target.value || undefined) as Person["committeeRole"],
                })
              }
              className="h-6 shrink-0 rounded border bg-background px-1 text-xs"
            >
              <option value="">—</option>
              {COMMITTEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`accounts.role.${r}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("accounts.aliases")}
            </span>
            <AliasesEdit
              aliases={person.aliases}
              onCommit={(aliases) => acc.updatePerson(person.id, { aliases })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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

          <div className="pt-1.5">
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

          {!person.archived && (
            <div className="flex justify-end pt-2">
              <ArchiveButton
                onArchive={() => {
                  acc.archivePerson(person.id);
                  onBack();
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
