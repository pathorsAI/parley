import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CircleUserRound, Loader2, Users } from "lucide-react";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { acceptInvitation, createOrg, listMyInvitations, listMyOrgs } from "../../lib/cloud/orgs";
import type { CloudInvitation, CloudOrg } from "../../lib/cloud/types";
import { orgErrMsg } from "../../lib/cloud/orgErrors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceCard, OrDivider } from "./ChoiceCard";
import { ConfirmCard } from "./ConfirmCard";

/**
 * Signed-in only: join the org someone invited you to, create one, or carry on
 * alone — two cards, each with its own button, which also moves the wizard on
 * (`onNext`), and Back under them (`onBack`); while they show, the wizard's
 * footer steps aside (`setChoosing`).
 * Already a member, the step just confirms it. Everything here can be redone
 * in Settings › Organizations.
 */
export function OrgStep({
  onNext,
  onBack,
  setChoosing,
}: Readonly<{ onNext: () => void; onBack: () => void; setChoosing: (choosing: boolean) => void }>) {
  const { t } = useI18n();
  const [orgs, setOrgs] = useState<CloudOrg[] | null>(null);
  const [invites, setInvites] = useState<CloudInvitation[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the lists couldn't be read. We then don't know whether the user is
  // already a member, so creating is not offered (it could duplicate an org
  // they're in); they retry or move on.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [mine, pending] = await Promise.all([listMyOrgs(), listMyInvitations()]);
    setOrgs(mine);
    setInvites(pending);
    setLoadError(null);
  }, []);

  const reload = useCallback(() => {
    setOrgs(null);
    setLoadError(null);
    load().catch((e) => {
      log.warn("onboarding: loading organizations failed", { error: String(e) });
      setLoadError(orgErrMsg(t, e));
    });
  }, [load, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  const member = (orgs?.length ?? 0) > 0;

  // The two cards show once we know the user isn't in an organization; while
  // loading, or when the lists couldn't be read, the footer stays (so Next can
  // carry on without one).
  const choosing = orgs !== null && !member && !loadError;
  useEffect(() => {
    setChoosing(choosing);
  }, [choosing, setChoosing]);
  useEffect(() => () => setChoosing(false), [setChoosing]);

  async function create() {
    if (!name.trim()) {
      setError(t("onboarding.org.nameRequired"));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createOrg(name);
      onNext();
    } catch (e) {
      setError(t("onboarding.org.failed", { error: orgErrMsg(t, e) }));
      setCreating(false);
    }
  }

  async function join(inv: CloudInvitation) {
    setJoining(inv.id);
    setError(null);
    try {
      await acceptInvitation(inv.id);
      await load();
    } catch (e) {
      setError(t("onboarding.org.failed", { error: orgErrMsg(t, e) }));
    } finally {
      setJoining(null);
    }
  }

  const inviteRows = invites.map((inv) => (
    <div key={inv.id} className="flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2.5">
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
  ));

  // Already in an organization: nothing to choose, so the step confirms it the
  // way the sign-in step confirms the account.
  if (member && orgs) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        <ConfirmCard
          pills={orgs.map((org) => ({ key: org.id, icon: <Users className="size-3.5" />, label: org.name }))}
          title={t("onboarding.org.joinedTitle")}
          body={t("onboarding.org.joinedNote")}
        >
          {inviteRows.length > 0 && <div className="relative flex w-full flex-col gap-2">{inviteRows}</div>}
        </ConfirmCard>
        {error && <p className="text-[11px] text-danger-foreground">{error}</p>}
      </div>
    );
  }

  if (choosing) {
    return (
      <div className="flex flex-col gap-6">
        {inviteRows.length > 0 && <div className="flex flex-col gap-2">{inviteRows}</div>}

        <ChoiceCard
          primary
          icon={<img src="/onboarding/icon-org-create.svg" alt="" className="size-3.5" />}
          label={t("onboarding.org.create")}
          note={t("onboarding.org.createNote")}
          art={{ src: "/onboarding/signin-member-lines.svg", className: "top-[-5px] left-[-444px] h-[200px] w-[967px]" }}
          action={
            <div className="flex flex-col items-end">
              <Button
                size="sm"
                className="h-8 gap-2 px-2.5 text-xs"
                disabled={creating}
                onClick={() => {
                  create().catch((e) => log.error("onboarding: create organization failed", { error: String(e) }));
                }}
              >
                {t("onboarding.org.createCta")}
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
              </Button>
              {error && (
                // Plain red text in the card's bottom padding, as on sign-in.
                <p className="absolute top-full right-0 mt-1 w-max max-w-[480px] text-right text-[11px] text-danger-foreground">
                  {error}
                </p>
              )}
            </div>
          }
        >
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !creating) {
                create().catch((err) => log.error("onboarding: create organization failed", { error: String(err) }));
              }
            }}
            aria-label={t("onboarding.org.create")}
            placeholder={t("onboarding.org.namePlaceholder")}
            className="h-auto rounded-[10px] border-[#dadee5] bg-background px-2.5 py-2 text-sm"
          />
        </ChoiceCard>

        <OrDivider label={t("onboarding.account.or")} />

        <ChoiceCard
          icon={<CircleUserRound className="size-3.5" />}
          label={t("onboarding.org.solo")}
          note={t("onboarding.org.soloNote")}
          art={{ src: "/onboarding/org-solo-lines.svg", className: "top-[38px] left-0 h-[116.52px] w-[774.18px]" }}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-2 bg-background px-2.5 text-xs hover:bg-background/80"
              disabled={creating}
              onClick={onNext}
            >
              {t("onboarding.org.soloCta")}
              <ChevronRight className="size-3.5" />
            </Button>
          }
        />

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 self-start px-2.5 text-xs"
          disabled={creating}
          onClick={onBack}
        >
          <ChevronLeft className="size-3.5" />
          {t("onboarding.back")}
        </Button>
      </div>
    );
  }

  // Still loading, or the lists couldn't be read.
  return (
    <div className="flex flex-col gap-3">
      {loadError ? (
        <div className="flex items-center gap-3 rounded-lg border border-warning-border bg-warning px-3 py-2.5">
          <span className="flex-1 text-xs leading-relaxed text-warning-foreground">
            {t("onboarding.org.loadFailed", { error: loadError })}
          </span>
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={reload}>
            {t("onboarding.org.retry")}
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("onboarding.org.loading")}
        </p>
      )}
    </div>
  );
}
