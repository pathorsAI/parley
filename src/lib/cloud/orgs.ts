// Organizations: create/join/manage via Better Auth's `organization` plugin, which
// the cloud mounts under `/auth/organization/*`. The desktop talks to it with the
// same bearer token as the rest of the cloud API (see ./client) — it never imports
// private code. Endpoint shapes here are pinned to the deployed backend's verified
// contract (better-auth org plugin):
//
//   POST /auth/organization/create            { name, slug }            → org
//   GET  /auth/organization/list                                        → org[]
//   POST /auth/organization/invite-member     { email, role, organizationId }
//   GET  /auth/organization/list-user-invitations                       → invitation[] (pending)
//   POST /auth/organization/accept-invitation { invitationId }          → { invitation, member }
//   GET  /auth/organization/list-members?organizationId=                → { members, total }
//   GET  /auth/organization/list-invitations?organizationId=            → invitation[] (all states)
//   POST /auth/organization/cancel-invitation { invitationId }
//   POST /auth/organization/reject-invitation { invitationId }
//   POST /auth/organization/remove-member     { memberIdOrEmail, organizationId }
//   POST /auth/organization/update-member-role { memberId, role, organizationId }
//   POST /auth/organization/leave             { organizationId }
//   POST /auth/organization/update            { data: { name }, organizationId }
//
// Permissions are better-auth's default roles (see ./orgRoles for the mirror the
// UI uses to hide what the server would refuse); the server is the authority.

import { cloudFetch } from "./client";
import { log } from "../log";
import type { CloudInvitation, CloudOrg, CloudOrgMember } from "./types";
import { isInvitationLive, type InvitableRole } from "./orgRoles";

/** Slugify a name into a URL-safe, unique-ish org slug (better-auth requires one). */
function toSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .join("-")
    .slice(0, 32);
  // A short random suffix keeps slugs unique without a round-trip to check.
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base || "org"}-${suffix}`;
}

/** Create an org (the caller becomes its owner). */
export async function createOrg(name: string): Promise<CloudOrg> {
  const res = await cloudFetch("/auth/organization/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), slug: toSlug(name) }),
  });
  const org = (await res.json()) as CloudOrg;
  log.info("cloud: created org", { id: org.id, name: org.name });
  return org;
}

/**
 * Every org the signed-in user is a member of, each carrying the caller's `role`.
 * Uses the cloud's own /orgs/mine (a member⋈organization join) rather than
 * better-auth's /organization/list, because the latter drops the membership role —
 * which the UI needs to gate owner-only actions like deleting an org.
 */
export async function listMyOrgs(): Promise<CloudOrg[]> {
  const res = await cloudFetch("/orgs/mine");
  const data = (await res.json()) as CloudOrg[];
  return Array.isArray(data) ? data : [];
}

/**
 * Invite someone into an org by email, as a member or an admin (owners only come
 * from a transfer). No email is sent (the backend has no mail provider) — the
 * invitee sees it in-app via {@link listMyInvitations} and accepts. They must sign
 * in with that same email. `resend` renews an existing pending invitation's
 * 48-hour expiry instead of failing with "already invited".
 */
export async function inviteToOrg(
  organizationId: string,
  email: string,
  role: InvitableRole = "member",
  opts: { resend?: boolean } = {},
): Promise<void> {
  await cloudFetch("/auth/organization/invite-member", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `role` is required (no default); pass the org id explicitly rather than
    // relying on the session's active org.
    body: JSON.stringify({ email: email.trim(), role, organizationId, resend: opts.resend ?? false }),
  });
  log.info("cloud: invited member", { organizationId, role, resend: !!opts.resend });
}

/** The signed-in user's own pending invitations (matched by their session email). */
export async function listMyInvitations(): Promise<CloudInvitation[]> {
  const res = await cloudFetch("/auth/organization/list-user-invitations");
  const data = (await res.json()) as CloudInvitation[] | { invitations?: CloudInvitation[] };
  const all = Array.isArray(data) ? data : (data.invitations ?? []);
  // An expired invitation can't be accepted (the server 400s), so it isn't one.
  return all.filter((i) => isInvitationLive(i));
}

/** Decline an invitation sent to the signed-in user. */
export async function rejectInvitation(invitationId: string): Promise<void> {
  await cloudFetch("/auth/organization/reject-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationId }),
  });
  log.info("cloud: rejected invitation", { invitationId });
}

/**
 * Invitations an org has sent that nobody has answered yet — still pending,
 * including ones past their expiry (the UI offers to renew those). Any member may
 * read this; cancelling is owner/admin-only.
 */
export async function listOrgInvitations(organizationId: string): Promise<CloudInvitation[]> {
  const res = await cloudFetch(
    `/auth/organization/list-invitations?organizationId=${encodeURIComponent(organizationId)}`,
  );
  const data = (await res.json()) as CloudInvitation[] | null;
  return (Array.isArray(data) ? data : []).filter((i) => i.status === "pending");
}

/** Withdraw an invitation the org sent (owner/admin). */
export async function cancelInvitation(invitationId: string): Promise<void> {
  await cloudFetch("/auth/organization/cancel-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationId }),
  });
  log.info("cloud: cancelled invitation", { invitationId });
}

/**
 * Remove someone from an org (owner/admin; only an owner can remove an owner, and
 * never the last one). Recordings they shared into the org stay there — a shared
 * recording is the org's copy; their personal original is untouched.
 */
export async function removeMember(organizationId: string, memberId: string): Promise<void> {
  await cloudFetch("/auth/organization/remove-member", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberIdOrEmail: memberId, organizationId }),
  });
  log.info("cloud: removed member", { organizationId, memberId });
}

/** Change a member's role. Only an owner may grant or take away "owner". */
export async function updateMemberRole(
  organizationId: string,
  memberId: string,
  role: string,
): Promise<void> {
  await cloudFetch("/auth/organization/update-member-role", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId, role, organizationId }),
  });
  log.info("cloud: updated member role", { organizationId, memberId, role });
}

/**
 * Hand an org to someone else: make them an owner, then step the caller down to
 * admin. Two calls because better-auth allows several owners and has no transfer
 * endpoint. If the second step fails the org simply has two owners — nothing is
 * lost, and the caller can demote themselves from the roster — so this reports
 * which step failed instead of trying to roll the first one back.
 */
export async function transferOwnership(
  organizationId: string,
  toMemberId: string,
  selfMemberId: string,
): Promise<{ demotedSelf: boolean }> {
  await updateMemberRole(organizationId, toMemberId, "owner");
  try {
    await updateMemberRole(organizationId, selfMemberId, "admin");
    return { demotedSelf: true };
  } catch (error) {
    log.warn("cloud: transfer kept a second owner", { organizationId, error: String(error) });
    return { demotedSelf: false };
  }
}

/** Leave an org. The server refuses the last owner (transfer first). */
export async function leaveOrg(organizationId: string): Promise<void> {
  await cloudFetch("/auth/organization/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId }),
  });
  log.info("cloud: left org", { organizationId });
}

/** Rename an org (owner/admin). The slug is left alone — nothing user-facing reads it. */
export async function renameOrg(organizationId: string, name: string): Promise<void> {
  await cloudFetch("/auth/organization/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { name: name.trim() }, organizationId }),
  });
  log.info("cloud: renamed org", { organizationId });
}

/** Accept a pending invitation → the user becomes a member of that org. */
export async function acceptInvitation(invitationId: string): Promise<void> {
  await cloudFetch("/auth/organization/accept-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationId }),
  });
  log.info("cloud: accepted invitation", { invitationId });
}

/**
 * Delete an org outright (owner-only — the cloud rejects non-owners with 403).
 * Irreversible: the backend purges every recording shared into the org and its
 * R2 blobs, then deletes the org and cascades its members + invitations. The UI
 * gates this behind a retype-the-name confirmation; this just fires the request.
 */
export async function deleteOrg(organizationId: string): Promise<void> {
  await cloudFetch(`/orgs/${encodeURIComponent(organizationId)}`, { method: "DELETE" });
  log.info("cloud: deleted org", { organizationId });
}

/**
 * Who's in an org — name/email/avatar/role, owner-first. Uses the cloud's
 * member-gated /orgs/:orgId/members (a member⋈user join) rather than better-auth's
 * list-members, which nests the user under `member.user` and needs admin perms.
 */
export async function listOrgMembers(organizationId: string): Promise<CloudOrgMember[]> {
  const res = await cloudFetch(`/orgs/${encodeURIComponent(organizationId)}/members`);
  const data = (await res.json()) as CloudOrgMember[];
  return Array.isArray(data) ? data : [];
}
