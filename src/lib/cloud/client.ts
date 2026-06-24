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
 * Sign in with Google. Opens the system browser to the cloud's Google flow with
 * a loopback callback; the cloud hands the session token back to a one-shot local
 * server (Rust `start_oauth_loopback`), which emits `auth://callback`. We then
 * fetch /me and stash the session. Works in `tauri dev` (no URL scheme needed).
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
    }, 5 * 60 * 1000);
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

    // Ask the cloud for the Google authorization URL, with the loopback as the
    // post-OAuth handoff target, then open it in the system browser.
    const callbackURL = `${CLOUD_URL}/desktop/auth-handoff?to=${encodeURIComponent(
      `http://127.0.0.1:${port}/cb`
    )}`;
    fetch(`${CLOUD_URL}/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL }),
    })
      .then((r) => r.json() as Promise<{ url?: string }>)
      .then((d) => {
        if (!d.url) throw new Error("no auth url");
        return openUrl(d.url);
      })
      .catch((err) => done(() => reject(err)));
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
