import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { log } from "../log";
import { CLOUD_ENABLED } from "../flags";
import type { CloudUser } from "./types";

/**
 * Parley Cloud HTTP client. The OSS app stays standalone — it only speaks to the
 * cloud over this API (auth + sync), never importing private code. Override the
 * endpoint with VITE_PARLEY_CLOUD_URL to point at a local `wrangler dev` backend.
 */
export const CLOUD_URL =
  (import.meta.env.VITE_PARLEY_CLOUD_URL as string | undefined)?.replace(/\/$/, "") ||
  "https://api.parley.tw";

type Me = { user: CloudUser | null; activeOrganizationId: string | null };

/** Who am I? `user` is null when the token is missing/expired (a 200, not an error). */
export async function fetchMe(token: string): Promise<Me> {
  const res = await fetch(`${CLOUD_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/me ${res.status}`);
  return (await res.json()) as Me;
}

/**
 * Sign in with Google. Opens the cloud's `/desktop/sign-in` in the SYSTEM BROWSER
 * — the entire OAuth flow (incl. the state cookie) lives there, which is what
 * avoids `state_mismatch`. After Google, the cloud hands the session token back
 * to a one-shot local server (Rust `start_oauth_loopback`) that emits
 * `auth://callback`. We then fetch /me and stash the session. Works in `tauri dev`.
 */
export async function signInWithGoogle(signal?: AbortSignal): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  if (signal?.aborted) throw new Error("cancelled");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { openUrl } = await import("@tauri-apps/plugin-opener");

  const port = await invoke<number>("start_oauth_loopback");

  const token = await new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => settle(() => reject(new Error("cancelled")));
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      unlisten?.();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    // Bail if the browser flow never routes back (closed tab, an error Better
    // Auth couldn't redirect, etc.) — so the UI doesn't hang on a stuck spinner.
    timer = setTimeout(() => settle(() => reject(new Error("timed out"))), 2 * 60 * 1000);
    signal?.addEventListener("abort", onAbort);

    listen<{ token?: string; error?: string }>("auth://callback", (e) => {
      if (e.payload.token) settle(() => resolve(e.payload.token!));
      else settle(() => reject(new Error(e.payload.error || "sign-in failed")));
    }).then((fn) => {
      unlisten = fn;
    });

    // Open the WHOLE flow in the system browser (state cookie lives there). The
    // cloud initiates Google sign-in and routes the token back to our loopback.
    const signInUrl = `${CLOUD_URL}/desktop/sign-in?to=${encodeURIComponent(
      `http://127.0.0.1:${port}/cb`
    )}`;
    openUrl(signInUrl).catch((err) => settle(() => reject(err)));
  });

  const me = await fetchMe(token);
  if (!me.user) throw new Error("no session after sign-in");
  useStore.getState().setCloudAuth({ token, user: me.user, activeOrganizationId: me.activeOrganizationId });
  log.info("cloud: signed in", { email: me.user.email });
}

/** Sign out: clear locally, then best-effort revoke the session on the cloud. */
export async function signOut(): Promise<void> {
  const token = useStore.getState().cloudAuth?.token;
  useStore.getState().setCloudAuth(null);
  if (!token) return;
  try {
    await fetch(`${CLOUD_URL}/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* best-effort revoke */
  }
}

/** Re-validate the stored token on startup: refresh the user, or clear if expired. */
export async function refreshSession(): Promise<void> {
  const auth = useStore.getState().cloudAuth;
  if (!auth) return;
  try {
    const me = await fetchMe(auth.token);
    if (me.user) {
      useStore.getState().setCloudAuth({ token: auth.token, user: me.user, activeOrganizationId: me.activeOrganizationId });
    } else {
      useStore.getState().setCloudAuth(null); // token no longer valid
    }
  } catch (e) {
    // Network blip — keep the stored session; don't sign the user out offline.
    log.warn("cloud: session refresh failed", { error: String(e) });
  }
}

// ── Authenticated fetch ───────────────────────────────────────────────────────
// The shared bearer-fetch seam, here in the client so every cloud feature (sync,
// orgs, replay download) speaks to the backend the same way and a dead session is
// cleared in exactly one place.

/** The current bearer session token, or null when signed out. */
export function cloudToken(): string | null {
  return useStore.getState().cloudAuth?.token ?? null;
}

/**
 * Whether automatic PERSONAL cloud sync is active: the cloud edition, signed in,
 * AND the user's sync toggle is on. This is the single gate every automatic
 * personal-sync path funnels through — the save-time push (history.ts pushToCloud),
 * the background sweep, and the merged-history cloud read. Org features are
 * intentionally NOT gated on it: an org is inherently a cloud space, so sharing /
 * org listing stay available (gated only on a valid session) even with sync off.
 */
export function syncEnabled(): boolean {
  if (!CLOUD_ENABLED) return false;
  const s = useStore.getState();
  return !!s.cloudAuth && s.settings.syncEnabled;
}

/** A thrown cloud-auth failure (the session was cleared) — lets sweeps short-circuit
 *  instead of retrying every entry against a dead session. */
export function isAuthError(e: unknown): boolean {
  return e instanceof Error && /\bauth\b/.test(e.message);
}

/**
 * A non-2xx cloud response. Carries the backend's own `code`/`message` (better-auth
 * returns `{ code, message }`) and the HTTP `status`, so callers can map a specific
 * failure to a friendly, localized toast instead of showing a bare "→ 400".
 */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/**
 * Bearer-authenticated fetch against the cloud; throws on a non-2xx response. A
 * 401 means the SESSION is dead (missing/expired token) → clear the stored auth so
 * the whole UI reflects signed-out consistently. A 403 is RESOURCE-level ("signed
 * in but not allowed" — e.g. a non-owner deleting an org, or a non-member touching
 * an org): the session is valid, so we must NOT sign the user out — just throw a
 * normal error the caller surfaces (a toast), or the next 403 would log them out.
 */
export async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const t = cloudToken();
  if (!t) throw new Error("not signed in");
  const res = await fetch(`${CLOUD_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}` },
  });
  if (res.status === 401) {
    useStore.getState().setCloudAuth(null);
    throw new Error(`cloud auth ${res.status}`);
  }
  if (!res.ok) {
    // Pull the backend's own error (better-auth: `{ code, message }`) so the caller
    // can show why it failed (e.g. "already a member") instead of an opaque status.
    let code: string | null = null;
    let message = "";
    try {
      const body = (await res.clone().json()) as { code?: string; message?: string };
      code = body.code ?? null;
      message = body.message ?? "";
    } catch {
      /* non-JSON body — fall back to the status line below */
    }
    throw new CloudError(
      message || `cloud ${init?.method ?? "GET"} ${path} → ${res.status}`,
      code,
      res.status,
    );
  }
  return res;
}
