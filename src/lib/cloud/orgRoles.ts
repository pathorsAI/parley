// Who may do what in an org — a mirror of better-auth's default organization
// roles, so the Organizations page can hide what the server would refuse. The
// server re-checks every call; these only decide what the UI offers.
//
//   owner  — everything, including delete and granting/removing "owner"
//   admin  — invite/cancel, change member↔admin, remove non-owners, rename
//   member — read the roster and pending invitations
//
// Roles are stored comma-separated by better-auth; Parley only ever assigns one,
// but read them as a set so a hand-edited row can't fool the gates.

import type { CloudInvitation, CloudOrgMember } from "./types";

export type OrgRole = "owner" | "admin" | "member";
/** Roles an invitation may carry. "owner" is only ever reached by a transfer. */
export type InvitableRole = Exclude<OrgRole, "owner">;

function roles(role: string | undefined | null): Set<string> {
  return new Set((role ?? "").split(",").map((r) => r.trim()).filter(Boolean));
}

export function isOwner(role: string | undefined | null): boolean {
  return roles(role).has("owner");
}

/** Owner or admin — the roles that can invite, remove, and change roles. */
export function canManage(role: string | undefined | null): boolean {
  const r = roles(role);
  return r.has("owner") || r.has("admin");
}

/** The highest single role, for display and the role picker. */
export function primaryRole(role: string | undefined | null): OrgRole {
  const r = roles(role);
  if (r.has("owner")) return "owner";
  if (r.has("admin")) return "admin";
  return "member";
}

export function ownerCount(members: readonly CloudOrgMember[]): number {
  return members.filter((m) => isOwner(m.role)).length;
}

/**
 * Whether `actorRole` may change `target`'s role from the roster. Nobody edits
 * themselves there, except an owner stepping down while another owner remains
 * (the server refuses to leave an org ownerless). Touching an owner needs an owner.
 */
export function canChangeRole(
  actorRole: string | undefined,
  target: CloudOrgMember,
  isSelf: boolean,
  owners: number,
): boolean {
  if (!canManage(actorRole)) return false;
  if (isSelf) return isOwner(actorRole) && isOwner(target.role) && owners > 1;
  if (isOwner(target.role)) return isOwner(actorRole);
  return true;
}

/** Roles the picker offers for a target: owner only when they already are one. */
export function roleOptions(target: CloudOrgMember): OrgRole[] {
  return isOwner(target.role) ? ["owner", "admin", "member"] : ["admin", "member"];
}

/** Whether `actorRole` may remove `target` (never themselves — that's "leave"). */
export function canRemove(
  actorRole: string | undefined,
  target: CloudOrgMember,
  isSelf: boolean,
  owners: number,
): boolean {
  if (isSelf || !canManage(actorRole)) return false;
  if (isOwner(target.role)) return isOwner(actorRole) && owners > 1;
  return true;
}

/** Only an owner hands the org over, and only to someone who isn't one yet. */
export function canTransferTo(actorRole: string | undefined, target: CloudOrgMember, isSelf: boolean): boolean {
  return !isSelf && isOwner(actorRole) && !isOwner(target.role);
}

/** The last owner can't leave — they transfer (or delete) first. */
export function canLeave(role: string | undefined, owners: number): boolean {
  return !isOwner(role) || owners > 1;
}

function toMs(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Past its expiry? An invitation without one never expires. */
export function isInvitationExpired(inv: Pick<CloudInvitation, "expiresAt">, now = Date.now()): boolean {
  const ms = toMs(inv.expiresAt);
  return ms !== null && ms < now;
}

/** Pending and not expired — the only kind an invitee can accept. */
export function isInvitationLive(inv: Pick<CloudInvitation, "status" | "expiresAt">, now = Date.now()): boolean {
  return inv.status === "pending" && !isInvitationExpired(inv, now);
}

/** Whole hours until an invitation expires (0 once expired; null when it never does). */
export function hoursUntilExpiry(inv: Pick<CloudInvitation, "expiresAt">, now = Date.now()): number | null {
  const ms = toMs(inv.expiresAt);
  if (ms === null) return null;
  return Math.max(0, Math.ceil((ms - now) / 3_600_000));
}

// ── Invite input ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Split pasted text ("a@x.com, b@x.com\nc@x.com" or "Name <a@x.com>") into addresses. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/u)
    .map((s) => s.replace(/^<|>$/gu, "").trim())
    .filter(Boolean);
}

export type InviteEmailStatus = "ok" | "invalid" | "member" | "invited" | "duplicate";

/**
 * Classify each address as it becomes a chip, so problems show before submit:
 * malformed, already in the org, already invited (a live invitation — an expired
 * one is renewed from the invitations list instead), or typed twice.
 */
export function classifyInviteEmails(
  emails: readonly string[],
  members: readonly CloudOrgMember[],
  invitations: readonly CloudInvitation[],
  now = Date.now(),
): { email: string; status: InviteEmailStatus }[] {
  const memberEmails = new Set(members.map((m) => (m.email ?? "").toLowerCase()).filter(Boolean));
  const invited = new Set(
    invitations.filter((i) => isInvitationLive(i, now)).map((i) => i.email.toLowerCase()),
  );
  const seen = new Set<string>();
  return emails.map((email) => {
    const key = email.toLowerCase();
    let status: InviteEmailStatus = "ok";
    if (!EMAIL_RE.test(email)) status = "invalid";
    else if (seen.has(key)) status = "duplicate";
    else if (memberEmails.has(key)) status = "member";
    else if (invited.has(key)) status = "invited";
    seen.add(key);
    return { email, status };
  });
}
