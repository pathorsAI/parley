import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Building2, ChevronRight, Loader2, MoreHorizontal, Pencil, Plus, UserPlus, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import { translate } from "../i18n/messages";
import { useStore } from "../lib/store";
import { log } from "../lib/log";
import { broadcastSettings } from "../lib/settingsSync";
import { CloudError } from "../lib/cloud/client";
import {
  acceptInvitation,
  cancelInvitation,
  createOrg,
  deleteOrg,
  inviteToOrg,
  leaveOrg,
  listMyInvitations,
  listMyOrgs,
  listOrgInvitations,
  listOrgMembers,
  rejectInvitation,
  removeMember,
  renameOrg,
  transferOwnership,
  updateMemberRole,
} from "../lib/cloud/orgs";
import {
  canChangeRole,
  canLeave,
  canManage,
  canRemove,
  canTransferTo,
  classifyInviteEmails,
  hoursUntilExpiry,
  isInvitationExpired,
  isOwner,
  ownerCount,
  primaryRole,
  roleOptions,
  splitEmails,
  type InvitableRole,
  type InviteEmailStatus,
  type OrgRole,
} from "../lib/cloud/orgRoles";
import type { CloudInvitation, CloudOrg, CloudOrgMember } from "../lib/cloud/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type T = ReturnType<typeof useI18n>["t"];

const ROLE_KEY: Record<OrgRole, TranslationKey> = {
  owner: "settings.org.role.owner",
  admin: "settings.org.role.admin",
  member: "settings.org.role.member",
};

/**
 * Turn a cloud failure into a human, localized reason. better-auth returns a
 * machine `code` on a 4xx; map the ones a user can act on and fall back to the
 * backend's own message for the rest.
 */
function orgErrMsg(t: T, e: unknown): string {
  const code = e instanceof CloudError ? e.code : null;
  switch (code) {
    case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
      return t("settings.org.errAlreadyMember");
    case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
      return t("settings.org.errAlreadyInvited");
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION":
    case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER":
    case "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION":
    case "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION":
      return t("settings.org.errNotAllowed");
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER":
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER":
      return t("settings.org.leaveOnlyOwner");
    case "MEMBER_NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
      return t("settings.org.errOrgGone");
    case "INVITATION_NOT_FOUND":
      return t("settings.org.errInvitationGone");
    case "INVALID_EMAIL":
      return t("settings.org.errInvalidEmail");
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/** Button label while an action is in flight: a spinner + the text. */
function Spinning({ label }: Readonly<{ label: string }>) {
  return (
    <span className="flex items-center gap-1">
      <Loader2 className="size-3 animate-spin" />
      {label}
    </span>
  );
}

function Avatar({ name, image, className = "size-7" }: Readonly<{ name: string; image?: string | null; className?: string }>) {
  if (image) return <img src={image} alt="" className={`${className} shrink-0 rounded-full`} />;
  return (
    <div className={`${className} grid shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-medium text-secondary-foreground`}>
      {(name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

function SectionLabel({ children }: Readonly<{ children: React.ReactNode }>) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

/**
 * Point a default save location that targets an org we're no longer in back at
 * Personal. Module-level (not a hook) on purpose: `useI18n().t` is a fresh
 * function every render, so anything that closes over it and sits in an effect's
 * deps would refetch forever.
 */
function guardDefaultSave(orgIds: readonly string[]) {
  const { settings, updateSettings } = useStore.getState();
  const def = settings.defaultSaveLocation;
  if (def.scope !== "org" || !def.orgId || orgIds.includes(def.orgId)) return;
  updateSettings({ defaultSaveLocation: { scope: "personal", folderId: null } });
  broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
    log.warn("settings: broadcast failed", { error: String(error) }),
  );
  toast.message(translate(settings.language, "settings.org.defaultSaveReset"));
}

/**
 * Settings → Organizations (listed only while signed in). A list of the user's orgs (plus invitations waiting
 * for them) that drills into one org's page: the roster as the management
 * surface, invitations it has sent, and rename / leave / delete. Everything goes
 * through ../lib/cloud/orgs; ../lib/cloud/orgRoles decides what to offer, and the
 * server re-checks every call.
 */
export function OrgSettings({ onPendingCount }: Readonly<{ onPendingCount: (n: number) => void }>) {
  const { t } = useI18n();
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [orgs, setOrgs] = useState<CloudOrg[] | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [myInvites, setMyInvites] = useState<CloudInvitation[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [answering, setAnswering] = useState<Record<string, boolean>>({});
  // A lone org opens straight to its page — but only on first load, so the
  // breadcrumb can still take you back to the list.
  const autoOpened = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [mine, invites] = await Promise.all([listMyOrgs(), listMyInvitations()]);
      setOrgs(mine);
      setMyInvites(invites);
      onPendingCount(invites.length);
      setLoadFailed(false);
      guardDefaultSave(mine.map((o) => o.id));
      if (!autoOpened.current) {
        autoOpened.current = true;
        if (mine.length === 1 && invites.length === 0) setSelectedId(mine[0].id);
      }
      setSelectedId((cur) => (cur && !mine.some((o) => o.id === cur) ? null : cur));
      const counts = await Promise.all(
        mine.map((o) =>
          listOrgMembers(o.id)
            .then((m) => [o.id, m.length] as const)
            .catch(() => [o.id, 0] as const),
        ),
      );
      setMemberCounts(Object.fromEntries(counts));
    } catch (error) {
      log.warn("settings: org list load failed", { error: String(error) });
      setLoadFailed(true);
    }
  }, [onPendingCount]);

  useEffect(() => {
    if (!cloudAuth) {
      setOrgs(null);
      return;
    }
    reload().catch(() => {});
  }, [cloudAuth, reload]);

  async function answer(inv: CloudInvitation, accept: boolean) {
    if (answering[inv.id]) return;
    setAnswering((m) => ({ ...m, [inv.id]: true }));
    try {
      if (accept) await acceptInvitation(inv.id);
      else await rejectInvitation(inv.id);
      await reload();
      if (accept) setSelectedId(inv.organizationId);
    } catch (e) {
      toast.error(t(accept ? "settings.org.acceptFailed" : "settings.org.declineFailed", { error: orgErrMsg(t, e) }));
    } finally {
      setAnswering((m) => ({ ...m, [inv.id]: false }));
    }
  }

  // The nav only lists this page while signed in (SettingsApp); this covers the
  // instant between signing out and the panel switching away.
  if (!cloudAuth) return null;

  if (loadFailed && orgs === null) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">{t("settings.org.loadFailed")}</p>
        <Button variant="secondary" size="sm" onClick={() => reload().catch(() => {})}>
          {t("settings.org.retry")}
        </Button>
      </div>
    );
  }

  const selected = orgs?.find((o) => o.id === selectedId) ?? null;
  if (selected) {
    return (
      <OrgDetail
        key={selected.id}
        org={selected}
        selfUserId={cloudAuth.user.id}
        onBack={() => setSelectedId(null)}
        onOrgsChanged={reload}
        onGone={() => {
          setSelectedId(null);
          reload().catch(() => {});
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">{t("settings.nav.organizations")}</h2>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus />
          {t("settings.org.create")}
        </Button>
      </div>

      {myInvites.map((inv) => (
        <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/10 px-3 py-2.5">
          <span className="min-w-0 text-sm">
            {t("settings.org.myInvitation", {
              org: inv.organizationName ?? inv.organizationId,
              role: t(ROLE_KEY[primaryRole(inv.role)]),
            })}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" disabled={answering[inv.id]} onClick={() => answer(inv, false).catch(() => {})}>
              {t("settings.org.decline")}
            </Button>
            <Button size="sm" disabled={answering[inv.id]} onClick={() => answer(inv, true).catch(() => {})}>
              {answering[inv.id] ? <Spinning label={t("settings.org.accept")} /> : t("settings.org.accept")}
            </Button>
          </span>
        </div>
      ))}

      {orgs === null && (
        <div className="flex flex-col">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b py-3">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      )}

      {orgs?.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
          <Building2 className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
          <p className="text-sm font-medium">{t("settings.org.empty")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.org.emptyHint")}</p>
          <Button size="sm" className="mt-2" onClick={() => setCreating(true)}>
            <Plus />
            {t("settings.org.create")}
          </Button>
        </div>
      )}

      {orgs && orgs.length > 0 && (
        <ul className="flex flex-col">
          {orgs.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => setSelectedId(o.id)}
                className="flex w-full cursor-pointer items-center gap-3 border-b px-1 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <Avatar name={o.name} image={o.logo} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(ROLE_KEY[primaryRole(o.role)])}</span>
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                  {memberCounts[o.id] ? t("settings.org.memberCount", { count: memberCounts[o.id] }) : ""}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <CreateOrgSheet
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (org) => {
          await reload();
          setSelectedId(org.id);
        }}
      />
    </div>
  );
}

function CreateOrgSheet({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{ open: boolean; onOpenChange: (o: boolean) => void; onCreated: (org: CloudOrg) => Promise<void> }>) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const org = await createOrg(name);
      onOpenChange(false);
      await onCreated(org);
    } catch (e) {
      toast.error(t("settings.org.createFailed", { error: orgErrMsg(t, e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={t("settings.org.create")}
        closeLabel={t("settings.org.close")}
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings.org.cancel")}
            </Button>
            <Button size="sm" disabled={busy || !name.trim()} onClick={() => submit().catch(() => {})}>
              {busy ? <Spinning label={t("settings.org.creating")} /> : t("settings.org.createSubmit")}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-1.5 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit().catch(() => {});
          }}
        >
          <Label htmlFor="org-create-name" className="text-xs text-muted-foreground">
            {t("settings.org.createName")}
          </Label>
          <Input
            id="org-create-name"
            autoFocus
            value={name}
            placeholder={t("settings.org.createPlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </form>
      </SheetContent>
    </Sheet>
  );
}

type Confirm =
  | { kind: "remove"; member: CloudOrgMember }
  | { kind: "transfer"; member: CloudOrgMember }
  | { kind: "leave" }
  | { kind: "delete" };

function OrgDetail({
  org,
  selfUserId,
  onBack,
  onOrgsChanged,
  onGone,
}: Readonly<{
  org: CloudOrg;
  selfUserId: string;
  onBack: () => void;
  onOrgsChanged: () => Promise<void>;
  /** The caller left or deleted this org. */
  onGone: () => void;
}>) {
  const { t } = useI18n();
  const language = useStore((s) => s.settings.language);
  const [members, setMembers] = useState<CloudOrgMember[] | null>(null);
  const [invites, setInvites] = useState<CloudInvitation[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(org.name);
  const [deleteTyped, setDeleteTyped] = useState("");

  const load = useCallback(async () => {
    const [m, inv] = await Promise.all([
      listOrgMembers(org.id),
      listOrgInvitations(org.id).catch((error) => {
        log.warn("settings: org invitations load failed", { error: String(error) });
        return [] as CloudInvitation[];
      }),
    ]);
    setMembers(m);
    setInvites(inv);
  }, [org.id]);

  useEffect(() => {
    load().catch((error) => {
      log.warn("settings: org roster load failed", { error: String(error) });
      toast.error(translate(useStore.getState().settings.language, "settings.org.loadFailed"));
    });
  }, [load]);

  const me = members?.find((m) => m.userId === selfUserId);
  // The roster is fresher than the org list's cached role (e.g. right after a transfer).
  const myRole = me?.role ?? org.role;
  const owners = members ? ownerCount(members) : 0;
  const manage = canManage(myRole);
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(language === "en" ? "en" : "zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }),
    [language],
  );

  /** Run one mutation with a per-key busy flag, refresh, and toast a failure. */
  async function run(key: string, failKey: TranslationKey, fn: () => Promise<void>) {
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } catch (e) {
      toast.error(t(failKey, { error: orgErrMsg(t, e) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      await load().catch(() => {});
    }
  }

  async function confirmAction(c: Confirm) {
    const key = `confirm:${c.kind}`;
    if (c.kind === "remove") {
      await run(key, "settings.org.removeFailed", () => removeMember(org.id, c.member.id));
    } else if (c.kind === "transfer") {
      if (!me) return;
      await run(key, "settings.org.transferFailed", async () => {
        const { demotedSelf } = await transferOwnership(org.id, c.member.id, me.id);
        if (!demotedSelf) toast.warning(t("settings.org.transferPartial", { name: c.member.name || c.member.email || "" }));
        await onOrgsChanged();
      });
    } else if (c.kind === "leave") {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await leaveOrg(org.id);
        onGone();
      } catch (e) {
        toast.error(t("settings.org.leaveFailed", { error: orgErrMsg(t, e) }));
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
      return;
    } else if (c.kind === "delete") {
      if (deleteTyped.trim() !== org.name.trim()) return;
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await deleteOrg(org.id);
        onGone();
      } catch (e) {
        toast.error(t("settings.org.deleteFailed", { error: orgErrMsg(t, e) }));
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
      return;
    }
    setConfirm(null);
  }

  async function saveName() {
    const name = newName.trim();
    if (!name || name === org.name) {
      setRenaming(false);
      return;
    }
    await run("rename", "settings.org.renameFailed", async () => {
      await renameOrg(org.id, name);
      await onOrgsChanged();
      setRenaming(false);
    });
  }

  const memberLabel = (m: CloudOrgMember) => m.name || m.email || "";

  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb + header */}
      <div className="flex flex-col gap-1">
        <nav className="flex items-center gap-1 text-xs text-muted-foreground">
          <button type="button" className="cursor-pointer hover:text-foreground" onClick={onBack}>
            {t("settings.nav.organizations")}
          </button>
          <ChevronRight className="size-3" />
          <span className="truncate text-foreground">{org.name}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {renaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveName().catch(() => {});
              }}
            >
              <Input
                autoFocus
                className="h-8 max-w-xs"
                value={newName}
                aria-label={t("settings.org.rename")}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setNewName(org.name);
                    setRenaming(false);
                  }
                }}
              />
              <Button type="submit" size="sm" disabled={busy.rename || !newName.trim()}>
                {busy.rename ? <Spinning label={t("settings.org.saving")} /> : t("settings.org.save")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNewName(org.name);
                  setRenaming(false);
                }}
              >
                {t("settings.org.cancel")}
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="truncate text-base font-semibold tracking-tight">{org.name}</h2>
              {manage && (
                <button
                  type="button"
                  className="cursor-pointer self-center rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("settings.org.rename")}
                  title={t("settings.org.rename")}
                  onClick={() => {
                    setNewName(org.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {members ? `${t("settings.org.memberCount", { count: members.length })} · ` : ""}
                {t("settings.org.yourRole", { role: t(ROLE_KEY[primaryRole(myRole)]) })}
              </span>
            </div>
          )}
          {manage && !renaming && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus />
              {t("settings.org.invite")}
            </Button>
          )}
        </div>
      </div>

      {/* Members */}
      <div className="flex flex-col gap-1">
        <SectionLabel>{t("settings.org.members")}</SectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="py-2 pr-2 font-normal">{t("settings.org.colMember")}</th>
                <th className="w-32 py-2 pr-2 font-normal">{t("settings.org.colRole")}</th>
                <th className="w-24 py-2 pr-2 font-normal">{t("settings.org.colJoined")}</th>
                <th className="w-8 py-2" />
              </tr>
            </thead>
            <tbody>
              {members === null &&
                [0, 1, 2].map((i) => (
                  <tr key={i} className="border-b">
                    <td className="py-2.5 pr-2">
                      <div className="flex items-center gap-2.5">
                        <Skeleton className="size-7 rounded-full" />
                        <div className="flex flex-col gap-1">
                          <Skeleton className="h-3.5 w-28" />
                          <Skeleton className="h-3 w-36" />
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-2"><Skeleton className="h-6 w-20" /></td>
                    <td className="py-2.5 pr-2"><Skeleton className="h-3 w-16" /></td>
                    <td />
                  </tr>
                ))}
              {members?.map((m) => {
                const isSelf = m.userId === selfUserId;
                const role = primaryRole(m.role);
                const editable = canChangeRole(myRole, m, isSelf, owners);
                const transfer = canTransferTo(myRole, m, isSelf);
                const removable = canRemove(myRole, m, isSelf, owners);
                return (
                  <tr key={m.id} className="border-b transition-colors hover:bg-muted/40">
                    <td className="py-2 pr-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={memberLabel(m)} image={m.image} />
                        <div className="min-w-0">
                          <div className="truncate">
                            {m.name || m.email}
                            {isSelf && <span className="text-muted-foreground"> {t("settings.org.you")}</span>}
                          </div>
                          {m.name && m.email && <div className="truncate text-xs text-muted-foreground">{m.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-2">
                      {editable ? (
                        <Select
                          value={role}
                          disabled={busy[`role:${m.id}`]}
                          onValueChange={(v) =>
                            run(`role:${m.id}`, "settings.org.roleFailed", async () => {
                              await updateMemberRole(org.id, m.id, v);
                              if (isSelf) await onOrgsChanged();
                            }).catch(() => {})
                          }
                        >
                          <SelectTrigger size="sm" className="h-7 w-28 text-xs" aria-label={t("settings.org.colRole")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roleOptions(m).map((r) => (
                              <SelectItem key={r} value={r} className="text-xs">
                                {t(ROLE_KEY[r])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t(ROLE_KEY[role])}</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-xs whitespace-nowrap text-muted-foreground">
                      {m.createdAt ? dateFmt.format(new Date(m.createdAt)) : ""}
                    </td>
                    <td className="py-2 text-right">
                      {(transfer || removable) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t("settings.org.actions")}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {transfer && (
                              <DropdownMenuItem onSelect={() => setConfirm({ kind: "transfer", member: m })}>
                                {t("settings.org.makeOwner")}
                              </DropdownMenuItem>
                            )}
                            {transfer && removable && <DropdownMenuSeparator />}
                            {removable && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setConfirm({ kind: "remove", member: m })}
                              >
                                {t("settings.org.remove")}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invitations the org has sent */}
      {invites.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionLabel>
            {t("settings.org.invitations")} · {invites.length}
          </SectionLabel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <tbody>
                {invites.map((inv) => {
                  const expired = isInvitationExpired(inv);
                  return (
                    <tr key={inv.id} className="border-b">
                      <td className="py-2 pr-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar name="?" />
                          <span className="truncate">{inv.email}</span>
                        </div>
                      </td>
                      <td className="w-32 py-2 pr-2 text-xs text-muted-foreground">{t(ROLE_KEY[primaryRole(inv.role)])}</td>
                      <td className={`w-28 py-2 pr-2 text-xs whitespace-nowrap ${expired ? "text-warning-foreground" : "text-muted-foreground"}`}>
                        {expired ? t("settings.org.expired") : t("settings.org.expiresIn", { hours: hoursUntilExpiry(inv) ?? 48 })}
                      </td>
                      <td className="w-36 py-2 text-right whitespace-nowrap">
                        {manage && expired && (
                          <Button
                            variant="link"
                            size="xs"
                            disabled={busy[`inv:${inv.id}`]}
                            onClick={() =>
                              run(`inv:${inv.id}`, "settings.org.renewFailed", () =>
                                inviteToOrg(org.id, inv.email, primaryRole(inv.role) === "admin" ? "admin" : "member", { resend: true }),
                              ).catch(() => {})
                            }
                          >
                            {t("settings.org.renew")}
                          </Button>
                        )}
                        {manage && (
                          <Button
                            variant="link"
                            size="xs"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={busy[`inv:${inv.id}`]}
                            onClick={() =>
                              run(`inv:${inv.id}`, "settings.org.revokeFailed", () => cancelInvitation(inv.id)).catch(() => {})
                            }
                          >
                            {t("settings.org.revoke")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Danger zone */}
      {members && (
        <div className="mt-2 flex flex-col gap-2 border-t pt-4">
          <SectionLabel>{t("settings.org.dangerZone")}</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canLeave(myRole, owners)}
              onClick={() => setConfirm({ kind: "leave" })}
            >
              {t("settings.org.leave")}
            </Button>
            {isOwner(myRole) && (
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  setDeleteTyped("");
                  setConfirm({ kind: "delete" });
                }}
              >
                {t("settings.org.delete")}
              </Button>
            )}
          </div>
          {!canLeave(myRole, owners) && <p className="text-xs text-muted-foreground">{t("settings.org.leaveOnlyOwner")}</p>}
        </div>
      )}

      <InviteSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        org={org}
        members={members ?? []}
        invitations={invites}
        onSent={() => load().catch(() => {})}
      />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          {confirm && (
            <ConfirmBody
              confirm={confirm}
              org={org}
              memberLabel={memberLabel}
              busy={!!busy[`confirm:${confirm.kind}`]}
              deleteTyped={deleteTyped}
              setDeleteTyped={setDeleteTyped}
              onConfirm={() => confirmAction(confirm).catch(() => {})}
            />
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConfirmBody({
  confirm,
  org,
  memberLabel,
  busy,
  deleteTyped,
  setDeleteTyped,
  onConfirm,
}: Readonly<{
  confirm: Confirm;
  org: CloudOrg;
  memberLabel: (m: CloudOrgMember) => string;
  busy: boolean;
  deleteTyped: string;
  setDeleteTyped: (s: string) => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  let title = "";
  let desc = "";
  let action = "";
  let destructive = true;
  if (confirm.kind === "remove") {
    title = t("settings.org.removeTitle", { name: memberLabel(confirm.member), org: org.name });
    desc = t("settings.org.removeDesc");
    action = t("settings.org.removeConfirm");
  } else if (confirm.kind === "transfer") {
    title = t("settings.org.transferTitle", { name: memberLabel(confirm.member), org: org.name });
    desc = t("settings.org.transferDesc", { name: memberLabel(confirm.member) });
    action = t("settings.org.transferConfirm");
    destructive = false;
  } else if (confirm.kind === "leave") {
    title = t("settings.org.leaveTitle", { org: org.name });
    desc = t("settings.org.leaveDesc");
    action = t("settings.org.leaveConfirm");
  } else {
    title = t("settings.org.deleteTitle", { org: org.name });
    desc = t("settings.org.deleteWarning");
    action = t("settings.org.deleteConfirm");
  }
  const blocked = confirm.kind === "delete" && deleteTyped.trim() !== org.name.trim();
  return (
    <>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{desc}</AlertDialogDescription>
      {confirm.kind === "delete" && (
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="org-delete-confirm" className="text-xs text-muted-foreground">
            {t("settings.org.deleteConfirmPrompt", { org: org.name })}
          </Label>
          <Input
            id="org-delete-confirm"
            autoFocus
            className="h-8"
            placeholder={org.name}
            value={deleteTyped}
            onChange={(e) => setDeleteTyped(e.target.value)}
          />
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{t("settings.org.cancel")}</AlertDialogCancel>
        <AlertDialogAction
          variant={destructive ? "destructive" : "default"}
          disabled={busy || blocked}
          onClick={(e) => {
            // Keep the dialog open until the call settles; the parent closes it.
            e.preventDefault();
            onConfirm();
          }}
        >
          {busy ? <Spinning label={action} /> : action}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}

const STATUS_KEY: Record<Exclude<InviteEmailStatus, "ok">, TranslationKey> = {
  invalid: "settings.org.emailInvalid",
  member: "settings.org.emailMember",
  invited: "settings.org.emailInvited",
  duplicate: "settings.org.emailDuplicate",
};

function InviteSheet({
  open,
  onOpenChange,
  org,
  members,
  invitations,
  onSent,
}: Readonly<{
  open: boolean;
  onOpenChange: (o: boolean) => void;
  org: CloudOrg;
  members: readonly CloudOrgMember[];
  invitations: readonly CloudInvitation[];
  onSent: () => void;
}>) {
  const { t } = useI18n();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (open) {
      setEmails([]);
      setDraft("");
      setRole("member");
    }
  }, [open]);

  const classified = useMemo(() => classifyInviteEmails(emails, members, invitations), [emails, members, invitations]);
  const sendable = classified.filter((c) => c.status === "ok").map((c) => c.email);

  function commit(text: string) {
    const parts = splitEmails(text);
    // A repeat of an address already in the box is dropped, not flagged — pasting
    // an overlapping list twice is normal and needs no error.
    if (parts.length)
      setEmails((cur) => {
        const seen = new Set(cur.map((e) => e.toLowerCase()));
        const next = [...cur];
        for (const p of parts) {
          if (seen.has(p.toLowerCase())) continue;
          seen.add(p.toLowerCase());
          next.push(p);
        }
        return next;
      });
    setDraft("");
  }

  async function send() {
    // Whatever is still in the box counts too, so Send doesn't silently drop it.
    const pending = splitEmails(draft);
    const all = classifyInviteEmails([...emails, ...pending], members, invitations)
      .filter((c) => c.status === "ok")
      .map((c) => c.email);
    if (!all.length || sending) return;
    setSending(true);
    const results = await Promise.allSettled(all.map((e) => inviteToOrg(org.id, e, role)));
    setSending(false);
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failed.push(all[i]);
        toast.error(t("settings.org.inviteFailed", { email: all[i], error: orgErrMsg(t, r.reason) }));
      }
    });
    const sent = all.length - failed.length;
    if (sent > 0) toast.success(t("settings.org.invited", { count: sent }));
    onSent();
    if (failed.length === 0) onOpenChange(false);
    else {
      setEmails(failed);
      setDraft("");
    }
  }

  const count = sendable.length + splitEmails(draft).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={t("settings.org.inviteTitle", { org: org.name })}
        closeLabel={t("settings.org.close")}
        className="sm:max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings.org.cancel")}
            </Button>
            <Button size="sm" disabled={sending || count === 0} onClick={() => send().catch(() => {})}>
              {sending ? <Spinning label={t("settings.org.inviting")} /> : t("settings.org.inviteSubmit", { count })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-invite-emails" className="text-xs text-muted-foreground">
              {t("settings.org.inviteEmails")}
            </Label>
            <div className="flex min-h-20 flex-wrap content-start items-start gap-1.5 rounded-md border bg-background p-1.5 focus-within:ring-1 focus-within:ring-ring">
              {classified.map((c, i) => (
                <span
                  key={`${c.email}-${i}`}
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                    c.status === "ok" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {c.email}
                  {c.status !== "ok" && <span className="opacity-80">· {t(STATUS_KEY[c.status])}</span>}
                  <button
                    type="button"
                    className="cursor-pointer rounded-full opacity-70 hover:opacity-100"
                    aria-label={t("settings.org.removeEmail", { email: c.email })}
                    onClick={() => setEmails((cur) => cur.filter((_, j) => j !== i))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id="org-invite-emails"
                autoFocus
                className="min-w-40 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
                placeholder={emails.length ? "" : t("settings.org.invitePlaceholder")}
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  // A separator typed or pasted turns everything before it into chips.
                  if (/[\s,;]$/u.test(v)) commit(v);
                  else setDraft(v);
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (/[\s,;]/u.test(text.trim())) {
                    e.preventDefault();
                    commit(draft + text);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (draft.trim()) commit(draft);
                    else send().catch(() => {});
                  } else if (e.key === "Backspace" && !draft && emails.length) {
                    setEmails((cur) => cur.slice(0, -1));
                  }
                }}
                onBlur={() => draft.trim() && commit(draft)}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.org.inviteEmailsHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{t("settings.org.inviteRole")}</span>
            <div role="radiogroup" aria-label={t("settings.org.inviteRole")} className="grid grid-cols-2 overflow-hidden rounded-md border">
              {(["member", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  onClick={() => setRole(r)}
                  className={`cursor-pointer py-1.5 text-sm transition-colors ${
                    role === r ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t(ROLE_KEY[r])}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t(role === "admin" ? "settings.org.roleHint.admin" : "settings.org.roleHint.member")}</p>
          </div>

          <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t("settings.org.inviteNoMail")}</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
