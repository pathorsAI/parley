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

/**
 * The signed-in user's hosted-plan usage for the current billing period, as
 * returned by GET {CLOUD_URL}/me/usage. Drives the "parley" provider's quota
 * bars in Settings. Two independent meters:
 *  - STT seconds: meeting transcription AND voice typing share one pool (both
 *    stream through the same cloud relay). Free tier: 20h/month.
 *  - LLM credits: a credit is a USD-denominated unit, debited by the actual
 *    backend model cost. Free tier default: 10 credits/month.
 */
export interface HostedQuota {
  /** Plan id, e.g. "free". */
  plan: string;
  /** Speech-to-text seconds consumed this period (meeting + voice typing). */
  sttSecondsUsed: number;
  /** Speech-to-text seconds allowed this period (free tier: 20h = 72000). */
  sttSecondsLimit: number;
  /** LLM credits consumed this period. */
  llmCreditsUsed: number;
  /** LLM credits allowed this period (free tier default: 10). */
  llmCreditsLimit: number;
  /** @deprecated Superseded by the credit meter; kept optional so an older
   *  backend response still parses. Prefer `llmCredits*`. */
  llmTokensUsed?: number;
  /** @deprecated Superseded by the credit meter. */
  llmTokensLimit?: number;
  /** Epoch ms when the period resets and counters roll back to zero. */
  periodResetTs: number;
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
