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
  hasAudio: boolean;
  snippet: string;
  /** Server push time (epoch ms) — last-writer-wins ordering. */
  updatedAt: number;
}
