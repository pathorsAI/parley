// The trial-build sign-in shortcut. A build made with VITE_PARLEY_DEV_SESSION=1
// (and VITE_PARLEY_CLOUD_URL pointing at a local `wrangler dev`) starts already
// signed in: it asks the local backend's POST /dev/session for a test session
// and skips the onboarding's account choice. Release builds don't set the
// variable, so DEV_SESSION is the constant `false` there and Vite drops all of
// this; the backend route itself only answers on a loopback host with
// DEV_SESSION=1 (parley-internal src/devSession.ts), so production never
// issues one either way.

import { useStore } from "../store";
import { log } from "../log";
import { cloudRoutePatch } from "../onboarding/setupMode";
import { CLOUD_URL, fetchMe } from "./client";

export const DEV_SESSION = import.meta.env.VITE_PARLEY_DEV_SESSION === "1";

/** Signed in with a working session, or get one from the local backend and
 *  land the app on the cloud route with onboarding done. Call after
 *  refreshSession, which clears a stored token the backend no longer knows. */
export async function ensureDevSession(): Promise<void> {
  if (!DEV_SESSION) return;
  const s = useStore.getState();
  if (!s.cloudAuth) {
    const res = await fetch(`${CLOUD_URL}/dev/session`, { method: "POST" });
    if (!res.ok) throw new Error(`dev session: ${res.status} (is the local backend running with DEV_SESSION=1?)`);
    const { token } = (await res.json()) as { token: string };
    const me = await fetchMe(token);
    if (!me.user) throw new Error("dev session: the backend issued a token it does not recognise");
    s.setCloudAuth({ token, user: me.user, activeOrganizationId: me.activeOrganizationId });
    log.info("cloud: signed in with a dev session", { email: me.user.email });
  }
  if (!useStore.getState().settings.onboarded) {
    useStore.getState().updateSettings({ ...cloudRoutePatch(), onboarded: true });
  }
}
