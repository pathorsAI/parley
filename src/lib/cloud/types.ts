// Cloud (Parley Cloud) account + session types. The desktop app talks to the
// backend over HTTP only (see ../cloud/client) — it never imports private code.

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/** The signed-in session held (persisted) in the store. */
export interface CloudAuth {
  /** Bearer session token sent as `Authorization: Bearer <token>` to the cloud. */
  token: string;
  user: CloudUser;
  activeOrganizationId: string | null;
}

/** A Better Auth organization the signed-in user belongs to. */
export interface CloudOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  /** The signed-in user's role in this org ("owner" | "admin" | "member"), when
   *  the list came from /orgs/mine. Drives owner-only UI (e.g. the delete flow). */
  role?: string;
}

/** A pending invitation for the signed-in user to join an org. */
export interface CloudInvitation {
  id: string;
  organizationId: string;
  /** Present on `list-user-invitations`; the org's display name for the prompt. */
  organizationName?: string;
  email: string;
  role: string;
  status: string;
  expiresAt?: number;
}

/** A member of an org (for the org's member list). */
export interface CloudOrgMember {
  id: string;
  userId: string;
  role: string;
  /** Joined from the user row by /orgs/:orgId/members. */
  name?: string;
  email?: string;
  image?: string | null;
  /** Member join time as an ISO-8601 string (D1 timestamp → JSON). Ordering is
   *  done server-side (owner-first); the client doesn't parse this today. */
  createdAt?: string;
}

/**
 * A recording's card metadata as the cloud knows it (the synced mirror of a
 * desktop `HistoryEntrySummary`, plus the server's `updatedAt`). Listing these
 * lets the History grid render cloud entries without pulling the full bundle.
 */
export interface CloudRecordingSummary {
  id: string;
  title: string;
  source: "live" | "upload";
  createdAt: number;
  durationMs: number;
  speakerCount: number;
  findingsCount: number;
  actionItemsCount?: number;
  hasAudio: boolean;
  snippet: string;
  /** Folder the recording lives in, within its scope; null/absent = the scope root. */
  folderId?: string | null;
  /** Server push time (epoch ms) — last-writer-wins ordering. */
  updatedAt: number;
}
