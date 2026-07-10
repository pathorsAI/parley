import { useEffect, useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, FolderClosed, Search } from "lucide-react";
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

interface DestOption {
  value: string;
  name: string;
}
interface DestGroup {
  label: string;
  options: DestOption[];
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
 * A searchable combobox (folder lists grow) shared by Settings and the titlebar
 * destination chip (`compact`), so the loading logic lives once.
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

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
  const groups: DestGroup[] = useMemo(() => {
    const g: DestGroup[] = [
      {
        label: t("settings.account.defaultSave.personal"),
        options: [
          { value: "personal", name: root },
          ...personal.map((f) => ({ value: `personal:${f.id}`, name: f.name })),
        ],
      },
    ];
    if (syncOn) {
      for (const o of orgs) {
        g.push({
          label: o.name,
          options: [
            { value: `org:${o.id}`, name: root },
            ...(orgFolders[o.id] ?? []).map((f) => ({ value: `org:${o.id}:${f.id}`, name: f.name })),
          ],
        });
      }
    }
    return g;
  }, [personal, orgs, orgFolders, syncOn, root, t]);

  const selected = serialize(value);
  // Trigger label: "folder" compact; "group / folder" in settings.
  const current = useMemo(() => {
    for (const g of groups) {
      const hit = g.options.find((o) => o.value === selected);
      if (hit) return compact ? (hit.value.includes(":") ? hit.name : g.label) : `${g.label} · ${hit.name}`;
    }
    return root;
  }, [groups, selected, compact, root]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({
          ...g,
          options: g.label.toLowerCase().includes(q)
            ? g.options
            : g.options.filter((o) => o.name.toLowerCase().includes(q)),
        }))
        .filter((g) => g.options.length > 0)
    : groups;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title={t("settings.account.defaultSave.title")}
          className={
            compact
              ? "flex max-w-48 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              : "flex h-9 w-full max-w-md items-center gap-1.5 rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-primary"
          }
        >
          <FolderClosed className={compact ? "size-3 shrink-0" : "size-3.5 shrink-0 text-muted-foreground"} />
          <span className="truncate">{current}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-64 rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- combobox pattern */}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("saveDest.search")}
              className="h-6 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("saveDest.empty")}</p>
            )}
            {filtered.map((g) => (
              <div key={g.label} className="mb-0.5">
                <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {g.label}
                </p>
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onChange(parse(o.value));
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
                      o.value === selected ? "font-medium" : ""
                    }`}
                  >
                    <span className="flex-1 truncate">{o.name}</span>
                    {o.value === selected && <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
