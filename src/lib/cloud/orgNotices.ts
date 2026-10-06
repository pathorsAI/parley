// Main-window org housekeeping, run once a signed-in session is known:
//
// 1. Invitations only lived at the bottom of Settings, so nobody found them.
//    Each new one now gets a single toast whose "View" opens Settings →
//    Organizations; the ids already announced are remembered per device so a
//    relaunch doesn't repeat them.
// 2. A default save location pointing at an org the user has left (or been
//    removed from) would fail on every meeting; point it back at Personal.

import { toast } from "sonner";
import { translate } from "../../i18n/messages";
import { useStore } from "../store";
import { log } from "../log";
import { openSettings } from "../nav/settings";
import { listMyInvitations, listMyOrgs } from "./orgs";

const NOTIFIED_KEY = "parley-org-invites-notified";

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveNotified(ids: Set<string>): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable — worst case a toast repeats next launch */
  }
}

/** Toast each invitation the user hasn't been told about yet. */
export async function announceNewInvitations(): Promise<void> {
  const invitations = await listMyInvitations();
  const notified = loadNotified();
  const lang = useStore.getState().settings.language;
  const fresh = invitations.filter((i) => !notified.has(i.id));
  for (const inv of fresh) {
    toast.message(translate(lang, "settings.org.inviteToast", { org: inv.organizationName ?? inv.organizationId }), {
      duration: 10_000,
      action: {
        label: translate(lang, "settings.org.inviteToastView"),
        onClick: () => openSettings("organizations"),
      },
    });
    notified.add(inv.id);
  }
  // Forget answered/expired ones so the list can't grow forever.
  const live = new Set(invitations.map((i) => i.id));
  saveNotified(new Set([...notified].filter((id) => live.has(id))));
}

/** Point a default save location at Personal when its org is no longer ours. */
export async function resetStaleDefaultSave(): Promise<void> {
  const def = useStore.getState().settings.defaultSaveLocation;
  if (def.scope !== "org" || !def.orgId) return;
  const orgs = await listMyOrgs();
  if (orgs.some((o) => o.id === def.orgId)) return;
  const { updateSettings, settings } = useStore.getState();
  updateSettings({ defaultSaveLocation: { scope: "personal", folderId: null } });
  toast.message(translate(settings.language, "settings.org.defaultSaveReset"));
  log.info("cloud: default save org gone, reset to personal", { orgId: def.orgId });
}

export async function runOrgNotices(): Promise<void> {
  await Promise.all([
    announceNewInvitations().catch((error) => log.warn("cloud: invitation check failed", { error: String(error) })),
    resetStaleDefaultSave().catch((error) => log.warn("cloud: default save check failed", { error: String(error) })),
  ]);
}
