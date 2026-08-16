import { useEffect, useMemo, useState } from "react";
import { UsersRound } from "lucide-react";
import { Combobox, type ComboGroup } from "@/components/ui/combobox";
import { listMyOrgs } from "../lib/cloud/orgs";
import type { CloudOrg } from "../lib/cloud/types";
import { listOrgFolders, type CloudFolder } from "../lib/cloud/folders";
import { useI18n } from "../i18n";
import { log } from "../lib/log";

async function loadOrgFoldersEntry(orgId: string): Promise<readonly [string, CloudFolder[]]> {
  const folders = await listOrgFolders(orgId).catch(() => [] as CloudFolder[]);
  return [orgId, folders] as const;
}

export interface OrgShareTarget {
  orgId: string;
  folderId: string | null;
}

const OFF = "off";
const serialize = (v: OrgShareTarget | null): string =>
  v ? (v.folderId ? `${v.orgId}:${v.folderId}` : v.orgId) : OFF;
const parse = (v: string): OrgShareTarget | null => {
  if (v === OFF) return null;
  const idx = v.indexOf(":");
  return idx === -1
    ? { orgId: v, folderId: null }
    : { orgId: v.slice(0, idx), folderId: v.slice(idx + 1) };
};

/**
 * "Also share a copy to an org" — the ONLY save decision left (#211).
 *
 * This replaces the save-destination picker. That picker listed personal
 * folders, which after #211 meant offering a second answer to a question the
 * customer field already answers; its sole surviving purpose was the org copy,
 * so now it says exactly that and nothing else.
 */
export function OrgSharePicker({
  value,
  onChange,
}: Readonly<{
  value: OrgShareTarget | null;
  onChange: (target: OrgShareTarget | null) => void;
}>) {
  const { t } = useI18n();
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [orgFolders, setOrgFolders] = useState<Record<string, CloudFolder[]>>({});

  useEffect(() => {
    let alive = true;
    async function load() {
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
    load().catch((error) => log.warn("org-share: load failed", { error: String(error) }));
    return () => {
      alive = false;
    };
  }, []);

  const root = t("settings.account.defaultSave.root");
  const groups: ComboGroup[] = useMemo(() => {
    const g: ComboGroup[] = [{ options: [{ value: OFF, label: t("share.off") }] }];
    for (const o of orgs) {
      g.push({
        label: o.name,
        options: [
          { value: o.id, label: `${o.name} · ${root}` },
          ...(orgFolders[o.id] ?? []).map((f) => ({
            value: `${o.id}:${f.id}`,
            label: `${o.name} · ${f.name}`,
          })),
        ],
      });
    }
    return g;
  }, [orgs, orgFolders, root, t]);

  return (
    <Combobox
      size="sm"
      value={serialize(value)}
      groups={groups}
      onChange={(v) => onChange(parse(v))}
      title={t("share.toOrg")}
      placeholder={t("share.off")}
      searchPlaceholder={t("share.search")}
      emptyText={t("saveDest.empty")}
      icon={<UsersRound className="size-3.5 shrink-0 text-muted-foreground" />}
    />
  );
}
