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
