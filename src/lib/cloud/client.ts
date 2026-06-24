import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { log } from "../log";
import type { CloudUser } from "./types";

/**
 * Parley Cloud HTTP client. The OSS app stays standalone — it only speaks to the
 * cloud over this API (auth + sync), never importing private code. Override the
 * endpoint with VITE_PARLEY_CLOUD_URL to point at a local `wrangler dev` backend.
 */
export const CLOUD_URL =
  (import.meta.env.VITE_PARLEY_CLOUD_URL as string | undefined)?.replace(/\/$/, "") ||
  "https://parley-cloud.pathors.workers.dev";

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
export async function signInWithGoogle(): Promise<void> {
  if (!isTauri()) throw new Error("desktop only");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { openUrl } = await import("@tauri-apps/plugin-opener");

  const port = await invoke<number>("start_oauth_loopback");

  const token = await new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => {
      unlisten?.();
      reject(new Error("timed out"));
    }, 3 * 60 * 1000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      unlisten?.();
      fn();
    };

    listen<{ token?: string; error?: string }>("auth://callback", (e) => {
      if (e.payload.token) done(() => resolve(e.payload.token!));
      else done(() => reject(new Error(e.payload.error || "sign-in failed")));
    }).then((fn) => {
      unlisten = fn;
    });

    // Open the WHOLE flow in the system browser (state cookie lives there). The
    // cloud initiates Google sign-in and routes the token back to our loopback.
    const signInUrl = `${CLOUD_URL}/desktop/sign-in?to=${encodeURIComponent(
      `http://127.0.0.1:${port}/cb`
    )}`;
    openUrl(signInUrl).catch((err) => done(() => reject(err)));
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
