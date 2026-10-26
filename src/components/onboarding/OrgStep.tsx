import { useCallback, useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { acceptInvitation, createOrg, listMyInvitations, listMyOrgs } from "../../lib/cloud/orgs";
import type { CloudInvitation, CloudOrg } from "../../lib/cloud/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceRow } from "./ChoiceRow";

/** Runs when the user presses Next; false keeps them on the step. */
export type BeforeNext = () => Promise<boolean>;

/**
 * Signed-in only: join the org someone invited you to, create one, or carry on
 * alone. Creating happens on Next, so the name field and the choice stay
 * editable until then. Everything here can be redone in Settings › Organizations.
 */
export function OrgStep({ setBeforeNext }: Readonly<{ setBeforeNext: (fn: BeforeNext | null) => void }>) {
  const { t } = useI18n();
  const [orgs, setOrgs] = useState<CloudOrg[] | null>(null);
  const [invites, setInvites] = useState<CloudInvitation[]>([]);
  const [choice, setChoice] = useState<"create" | "solo">("solo");
  const [name, setName] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [mine, pending] = await Promise.all([listMyOrgs(), listMyInvitations()]);
    setOrgs(mine);
    setInvites(pending);
  }, []);

  useEffect(() => {
    load().catch((e) => {
      log.warn("onboarding: loading organizations failed", { error: String(e) });
      // Treat as "none yet": the user can still choose, and Settings can retry.
      setOrgs([]);
    });
  }, [load]);

  const member = (orgs?.length ?? 0) > 0;

  useEffect(() => {
    setBeforeNext(async () => {
      if (member || choice === "solo") return true;
      if (!name.trim()) {
        setError(t("onboarding.org.nameRequired"));
        return false;
      }
      try {
        await createOrg(name);
        return true;
      } catch (e) {
        setError(t("onboarding.org.failed", { error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    });
    return () => setBeforeNext(null);
  }, [member, choice, name, setBeforeNext, t]);

  async function join(inv: CloudInvitation) {
    setJoining(inv.id);
    setError(null);
    try {
      await acceptInvitation(inv.id);
      await load();
    } catch (e) {
      setError(t("onboarding.org.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setJoining(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{t("onboarding.org.title")}</h2>

      {orgs === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("onboarding.org.loading")}
        </p>
      ) : (
        <>
          {orgs.map((org) => (
            <div
              key={org.id}
              className="flex items-center gap-2 rounded-lg border border-success-border bg-success px-3 py-2.5 text-sm text-success-foreground"
            >
              <Users className="size-4 shrink-0" />
              {t("onboarding.org.joined", { name: org.name })}
            </div>
          ))}
          {member && <p className="text-xs leading-relaxed text-muted-foreground">{t("onboarding.org.joinedNote")}</p>}

          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <Users className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-sm">
                {t("onboarding.org.invited", { name: inv.organizationName ?? inv.organizationId })}
              </span>
              <Button
                size="sm"
                className="h-7 text-[11px]"
                disabled={joining !== null}
                onClick={() => {
                  join(inv).catch((e) => log.error("onboarding: accept invitation failed", { error: String(e) }));
                }}
              >
                {joining === inv.id && <Loader2 className="size-3.5 animate-spin" />}
                {t("onboarding.org.accept")}
              </Button>
            </div>
          ))}

          {!member && (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.org.body")}</p>
              <div role="radiogroup" aria-label={t("onboarding.org.title")} className="flex flex-col gap-2">
                <ChoiceRow
                  selected={choice === "create"}
                  label={t("onboarding.org.create")}
                  note={t("onboarding.org.createNote")}
                  onSelect={() => {
                    setChoice("create");
                    setError(null);
                  }}
                />
                {choice === "create" && (
                  <Input
                    autoFocus
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setError(null);
                    }}
                    aria-label={t("onboarding.org.create")}
                    placeholder={t("onboarding.org.namePlaceholder")}
                  />
                )}
                <ChoiceRow
                  selected={choice === "solo"}
                  label={t("onboarding.org.solo")}
                  note={t("onboarding.org.soloNote")}
                  onSelect={() => {
                    setChoice("solo");
                    setError(null);
                  }}
                />
              </div>
            </>
          )}
        </>
      )}

      {error && (
        <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">{error}</p>
      )}
    </div>
  );
}
