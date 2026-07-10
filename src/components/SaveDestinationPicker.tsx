import { useEffect, useState } from "react";
import { syncEnabled as cloudSyncEnabled } from "../lib/cloud/client";
import { listMyOrgs } from "../lib/cloud/orgs";
import type { CloudOrg } from "../lib/cloud/types";
import { listCloudFolders, listOrgFolders, type CloudFolder } from "../lib/cloud/folders";
import { listLocalFolders, listenForFoldersUpdated, type Folder as LocalFolder } from "../lib/history/folders";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import type { DefaultSaveLocation } from "../lib/types";

async function loadOrgFoldersEntry(orgId: string): Promise<readonly [string, CloudFolder[]]> {
  const folders = await listOrgFolders(orgId).catch(() => [] as CloudFolder[]);
  return [orgId, folders] as const;
}

/**
 * Where finished meetings save: a personal folder (or root), or an org folder.
 * One flat native select (optgroups per org). Shared by Settings and the
 * titlebar destination menu (`compact`), so the loading logic lives once.
 */
export function SaveDestinationPicker({
  value,
  syncOn,
  onChange,
  compact = false,
}: Readonly<{
  value: DefaultSaveLocation;
  syncOn: boolean;
  onChange: (loc: DefaultSaveLocation) => void;
  compact?: boolean;
}>) {
  const { t } = useI18n();
  const [personal, setPersonal] = useState<LocalFolder[]>(() => listLocalFolders());
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [orgFolders, setOrgFolders] = useState<Record<string, CloudFolder[]>>({});

  // Personal folders: prefer the cloud list when sync is on (cross-device truth).
  useEffect(() => {
    async function loadPersonalFolders() {
      if (!syncOn || !cloudSyncEnabled()) {
        setPersonal(listLocalFolders());
        return;
      }
      try {
        const cloud = await listCloudFolders();
        setPersonal(cloud.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })));
      } catch {
        setPersonal(listLocalFolders());
      }
    }
    loadPersonalFolders().catch((error) =>
      log.warn("save-dest: personal folders load failed", { error: String(error) })
    );
  }, [syncOn]);

  // Reflect personal-folder create/rename/delete done in the History window live.
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setPersonal(listLocalFolders()));
    return () => {
      un.then((fn) => fn()).catch((error) =>
        log.warn("save-dest: folder listener cleanup failed", { error: String(error) })
      );
    };
  }, []);

  // Org folders only matter for an org default, which needs sync on.
  useEffect(() => {
    if (!syncOn) return;
    let alive = true;
    async function loadOrgFolders() {
      try {
        const mine = await listMyOrgs();
        if (!alive) return;
        setOrgs(mine);
        const pairs = await Promise.all(mine.map((o) => loadOrgFoldersEntry(o.id)));
        if (alive) setOrgFolders(Object.fromEntries(pairs));
      } catch {
        /* leave orgs empty */
      }
    }
    loadOrgFolders().catch((error) =>
      log.warn("save-dest: org folders load failed", { error: String(error) })
    );
    return () => {
      alive = false;
    };
  }, [syncOn]);

  const serialize = (loc: DefaultSaveLocation): string => {
    if (loc.scope === "personal") {
      return loc.folderId ? `personal:${loc.folderId}` : "personal";
    }
    return loc.folderId ? `org:${loc.orgId}:${loc.folderId}` : `org:${loc.orgId}`;
  };

  const parse = (v: string): DefaultSaveLocation => {
    if (v === "personal") return { scope: "personal", folderId: null };
    if (v.startsWith("personal:")) return { scope: "personal", folderId: v.slice("personal:".length) };
    const rest = v.slice("org:".length);
    const idx = rest.indexOf(":");
    return idx === -1
      ? { scope: "org", orgId: rest, folderId: null }
      : { scope: "org", orgId: rest.slice(0, idx), folderId: rest.slice(idx + 1) };
  };

  return (
    <select
      value={serialize(value)}
      onChange={(e) => onChange(parse(e.target.value))}
      title={compact ? t("settings.account.defaultSave.title") : undefined}
      className={
        compact
          ? "h-6 max-w-44 truncate rounded-md border-none bg-muted px-1.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
          : "h-9 max-w-md rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      }
    >
      <optgroup label={t("settings.account.defaultSave.personal")}>
        <option value="personal">{t("settings.account.defaultSave.root")}</option>
        {personal.map((f) => (
          <option key={f.id} value={`personal:${f.id}`}>
            {f.name}
          </option>
        ))}
      </optgroup>
      {syncOn &&
        orgs.map((o) => (
          <optgroup key={o.id} label={o.name}>
            <option value={`org:${o.id}`}>{t("settings.account.defaultSave.root")}</option>
            {(orgFolders[o.id] ?? []).map((f) => (
              <option key={f.id} value={`org:${o.id}:${f.id}`}>
                {f.name}
              </option>
            ))}
          </optgroup>
        ))}
    </select>
  );
}
