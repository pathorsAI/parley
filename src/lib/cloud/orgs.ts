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

import { cloudFetch } from "./client";
import { log } from "../log";
import type { CloudInvitation, CloudOrg, CloudOrgMember } from "./types";

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
 * Invite someone into an org by email. No email is sent (the backend has no mail
 * provider) — the invitee sees it in-app via {@link listMyInvitations} and accepts.
 * The invitee must sign in with that same (verified) Google email.
 */
export async function inviteToOrg(organizationId: string, email: string): Promise<void> {
  await cloudFetch("/auth/organization/invite-member", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `role` is required (no default); pass the org id explicitly rather than
    // relying on the session's active org.
    body: JSON.stringify({ email: email.trim(), role: "member", organizationId }),
  });
  log.info("cloud: invited member", { organizationId });
}

/** The signed-in user's own pending invitations (matched by their session email). */
export async function listMyInvitations(): Promise<CloudInvitation[]> {
  const res = await cloudFetch("/auth/organization/list-user-invitations");
  const data = (await res.json()) as CloudInvitation[] | { invitations?: CloudInvitation[] };
  const all = Array.isArray(data) ? data : (data.invitations ?? []);
  return all.filter((i) => i.status === "pending");
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
