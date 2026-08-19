import { useEffect, useMemo, useState } from "react";
import {
  createLocalFolder,
  emitFoldersUpdated,
  listLocalFolders,
  listenForFoldersUpdated,
  type Folder,
} from "../lib/history/folders";
import { syncEnabled } from "../lib/cloud/client";
import { CLOUD_ENABLED } from "../lib/flags";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { Combobox, type ComboGroup } from "@/components/ui/combobox";
import { MoveDialog } from "./library/LibraryCards";
import {
  parseDestination,
  personalDestination,
  serializeDestination,
  type LibraryDestination,
  type OrgHandoffMode,
} from "../lib/library/destination";

/**
 * THE control for "where does this recording live".
 *
 * One folder is one customer, so this is also the only "whose call was this"
 * affordance — the import dialogs and the replay chips all mount this same
 * picker rather than each growing their own, which is how the app used to end
 * up with two disagreeing answers. Typing a name nothing matches creates that
 * folder in the scope currently selected, so a first-time customer costs one
 * keystroke.
 *
 * It lists the ORGS the signed-in user belongs to alongside the personal
 * folders. Before that, an org's shared folders were visible in the sidebar but
 * unreachable from any door a recording actually comes through: filing into one
 * meant saving personally first, then finding the card in the library and
 * sharing it — and even then only into the org root.
 *
 * Landing in an org is a copy-or-move decision (see OrgHandoffMode), so picking
 * one raises that question here instead of letting the caller guess; the caller
 * gets the answer alongside the destination.
 */
export function DestinationPicker({
  value,
  mode = null,
  onChange,
  size = "sm",
  gateOnSync = false,
}: Readonly<{
  value: LibraryDestination;
  /** The handoff already chosen for an org `value`. Supplying it lets a change
   *  of folder WITHIN the same org skip the copy/move question. */
  mode?: OrgHandoffMode | null;
  onChange: (destination: LibraryDestination, mode: OrgHandoffMode | null) => void;
  size?: "sm" | "default";
  /**
   * Hide org destinations while cloud sync is off. Set by the callers whose
   * save runs through `resolveMeetingSave`, which refuses an org share without
   * the sync toggle — offering the option there would be a dead end. Callers
   * that share directly (an already-saved recording) need only a session.
   */
  gateOnSync?: boolean;
}>) {
  const { t } = useI18n();
  // The registry is shared across windows, so re-read on the broadcast rather
  // than snapshotting it once at mount.
  const [folders, setFolders] = useState<Folder[]>(() => listLocalFolders());
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setFolders(listLocalFolders()));
    return () => {
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const signedIn = useStore((s) => !!s.cloudAuth);
  const orgsAvailable = CLOUD_ENABLED && signedIn && (!gateOnSync || syncEnabled());
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [orgFolders, setOrgFolders] = useState<Record<string, Folder[]>>({});
  /** Reload token — bumped after creating an org folder so the list re-fetches. */
  const [orgEpoch, setOrgEpoch] = useState(0);

  // Dynamic import: the cloud modules must stay out of the OSS (local-only)
  // bundle, so they are only ever reached from inside a CLOUD_ENABLED branch.
  useEffect(() => {
    if (!orgsAvailable) {
      setOrgs([]);
      setOrgFolders({});
      return;
    }
    let alive = true;
    async function load() {
      const { listMyOrgs } = await import("../lib/cloud/orgs");
      const { listOrgFolders } = await import("../lib/cloud/folders");
      const mine = await listMyOrgs();
      if (!alive) return;
      setOrgs(mine.map((o) => ({ id: o.id, name: o.name })));
      const pairs = await Promise.all(
        mine.map(async (o) => {
          const fs = await listOrgFolders(o.id).catch(() => []);
          return [o.id, fs.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt }))] as const;
        })
      );
      if (alive) setOrgFolders(Object.fromEntries(pairs));
    }
    load().catch((error) => log.warn("destination: org load failed", { error: String(error) }));
    return () => {
      alive = false;
    };
  }, [orgsAvailable, orgEpoch]);

  const orgRoot = t("history.move.rootLabel");
  const groups: ComboGroup[] = useMemo(() => {
    const personal = {
      // Unlabelled while there is nothing to tell it apart from — a local-only
      // user sees exactly the flat folder list this picker has always shown.
      label: orgs.length ? t("destination.personal") : undefined,
      options: [
        { value: "p", label: t("library.unassigned") },
        ...folders.map((f) => ({ value: `p:${f.id}`, label: f.name })),
      ],
    };
    return [
      personal,
      ...orgs.map((o) => ({
        label: o.name,
        options: [
          { value: `o:${o.id}`, label: orgRoot },
          ...(orgFolders[o.id] ?? []).map((f) => ({ value: `o:${o.id}:${f.id}`, label: f.name })),
        ],
      })),
    ];
  }, [folders, orgs, orgFolders, orgRoot, t]);

  /** An org pick waiting on the copy-or-move answer. */
  const [pending, setPending] = useState<LibraryDestination | null>(null);

  /** Commit a pick — raising the copy/move question only when this is a fresh
   *  landing in an org (staying inside one keeps the handoff already chosen). */
  function commit(next: LibraryDestination) {
    if (next.scope !== "org") {
      onChange(next, null);
      return;
    }
    if (value.scope === "org" && mode) {
      onChange(next, mode);
      return;
    }
    setPending(next);
  }

  function create(name: string) {
    if (value.scope === "org") {
      const orgId = value.orgId;
      import("../lib/cloud/folders")
        .then(({ createOrgFolder }) => createOrgFolder(orgId, name))
        .then((created) => {
          setOrgEpoch((n) => n + 1);
          commit({ scope: "org", orgId, folderId: created.id });
        })
        .catch((error) => {
          log.error("destination: org folder create failed", { orgId, error: String(error) });
        });
      return;
    }
    const created = createLocalFolder(name);
    setFolders(listLocalFolders());
    commit(personalDestination(created.id));
    emitFoldersUpdated().catch(() => {});
  }

  const pendingOrg = pending?.scope === "org" ? orgs.find((o) => o.id === pending.orgId) : undefined;
  const pendingFolder =
    pending?.scope === "org" && pending.folderId
      ? (orgFolders[pending.orgId] ?? []).find((f) => f.id === pending.folderId)
      : undefined;

  return (
    <>
      <Combobox
        size={size}
        value={serializeDestination(value)}
        groups={groups}
        onChange={(v) => commit(parseDestination(v))}
        onCreate={create}
        createLabel={(name) => t("owner.create", { name })}
        placeholder={t("library.unassigned")}
        searchPlaceholder={t("folder.search")}
        emptyText={t("folder.noMatch")}
      />

      {pending && pendingOrg && (
        <MoveDialog
          orgName={pendingOrg.name}
          target={pendingFolder ? `${pendingOrg.name} / ${pendingFolder.name}` : `${pendingOrg.name} ${orgRoot}`}
          onCopy={() => {
            setPending(null);
            onChange(pending, "copy");
          }}
          onMove={() => {
            setPending(null);
            onChange(pending, "move");
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
