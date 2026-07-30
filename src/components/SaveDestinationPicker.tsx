import { useEffect, useMemo, useState } from "react";
import { FolderClosed } from "lucide-react";
import { Combobox, type ComboGroup } from "@/components/ui/combobox";
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

/**
 * Where finished meetings save: a personal folder (or root), or an org folder.
 * Shared by Settings (the fallback default) and the pre-flight screen's
 * "save somewhere else" override, so the folder/org loading logic lives once.
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
  /** Compact: the trigger shows the folder name only (rail/inline use). */
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

  const root = t("settings.account.defaultSave.root");
  // Non-compact triggers spell out "group · folder"; compact shows the folder
  // (or the group name when the selection IS a root).
  const groups: ComboGroup[] = useMemo(() => {
    const personalLabel = t("settings.account.defaultSave.personal");
    // Compact triggers have room for one word: the folder, or the group name
    // when the selection IS that group's root.
    const label = (group: string, name: string, isRoot: boolean) => {
      if (!compact) return `${group} · ${name}`;
      return isRoot ? group : name;
    };
    const g: ComboGroup[] = [
      {
        label: personalLabel,
        options: [
          { value: "personal", label: label(personalLabel, root, true) },
          ...personal.map((f) => ({
            value: `personal:${f.id}`,
            label: label(personalLabel, f.name, false),
          })),
        ],
      },
    ];
    if (syncOn) {
      for (const o of orgs) {
        g.push({
          label: o.name,
          options: [
            { value: `org:${o.id}`, label: label(o.name, root, true) },
            ...(orgFolders[o.id] ?? []).map((f) => ({
              value: `org:${o.id}:${f.id}`,
              label: label(o.name, f.name, false),
            })),
          ],
        });
      }
    }
    return g;
  }, [personal, orgs, orgFolders, syncOn, root, compact, t]);

  return (
    <Combobox
      value={serialize(value)}
      groups={groups}
      onChange={(v) => onChange(parse(v))}
      title={t("settings.account.defaultSave.title")}
      placeholder={root}
      searchPlaceholder={t("saveDest.search")}
      emptyText={t("saveDest.empty")}
      size={compact ? "bare" : "default"}
      className={compact ? "max-w-48" : "max-w-md"}
      icon={
        <FolderClosed
          className={compact ? "size-3 shrink-0" : "size-3.5 shrink-0 text-muted-foreground"}
        />
      }
    />
  );
}
