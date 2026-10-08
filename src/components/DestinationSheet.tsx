import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Folder, FolderClosed, Loader2, Plus, Search, User, UsersRound } from "lucide-react";
import { toast } from "sonner";
import {
  createLocalFolder,
  emitFoldersUpdated,
  filingChoices,
  listLocalFolders,
  listenForFoldersUpdated,
  type Folder as LocalFolder,
} from "../lib/history/folders";
import { syncEnabled } from "../lib/cloud/client";
import { CLOUD_ENABLED } from "../lib/flags";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { LibraryDestination, OrgHandoffMode } from "../lib/library/destination";
import {
  PERSONAL_WORKSPACE,
  breadcrumb,
  canCreateFolder,
  filterFolders,
  formatBreadcrumb,
  initialDestination,
  inWorkspace,
  loadLastDestination,
  needsFolderSearch,
  offersKeepCopy,
  primaryAction,
  revealsToOrg,
  saveLastDestination,
  workspaceControl,
  workspaceOf,
  workspaceRoot,
  type DestinationVerb,
  type NamedFolder,
  type PrimaryAction,
  type WorkspaceRef,
} from "../lib/library/destinationPicker";

/**
 * THE answer to "where does this recording live" — Personal or an org, and
 * which folder — for every door that asks: the report page's 放進資料夾, the
 * library's move action, the import dialogs and the auto-share setting.
 *
 * One sheet, one flow: pick the workspace on top, the folder under it, and
 * press the one button that says what is about to happen
 * (「移到 Pathors › 客戶會議」). Nothing is applied until then — Esc or Cancel
 * leaves everything as it was, including a folder typed into 新增資料夾,
 * which is only created on confirm.
 *
 * Moving into an org is the same act as moving between folders. The org model
 * underneath is still copy-or-move (lib/library/destination OrgHandoffMode);
 * the copy survives as one checkbox instead of a separate share ritual.
 *
 * The folder list is part of the sheet's own scroll area. It used to live in a
 * combobox popover, which Radix portals to <body> — outside the sheet's modal
 * scroll lock, so the wheel was swallowed and the list would not scroll.
 */

// ── Sources ─────────────────────────────────────────────────────────────────

export interface DestinationSources {
  /** The personal folder registry, archived folders included. */
  personalFolders: LocalFolder[];
  /** The orgs the user can file into; null while they load. */
  orgs: WorkspaceRef[] | null;
  /** Each org's folders; a missing entry is still loading. */
  orgFolders: Record<string, NamedFolder[]>;
  /** Re-fetch after creating an org folder. */
  reload: () => void;
}

/**
 * Fetch one org's folders as an `[orgId, folders]` pair. Module scope keeps
 * the loader's callbacks shallow; the lister is passed in because the cloud
 * module is only ever reached through a lazy import.
 */
async function loadOrgFolderPair(
  orgId: string,
  listOrgFolders: (id: string) => Promise<NamedFolder[]>
): Promise<readonly [string, NamedFolder[]]> {
  const fs = await listOrgFolders(orgId).catch((): NamedFolder[] => []);
  return [orgId, fs.map((f) => ({ id: f.id, name: f.name }))] as const;
}

/**
 * The personal folders (live across windows) and, when the cloud edition is
 * signed in, the user's orgs and their folders. `gateOnSync` hides orgs while
 * sync is off — for the save paths that resolveMeetingSave would refuse.
 */
export function useDestinationSources(enabled: boolean, gateOnSync = false): DestinationSources {
  const [personalFolders, setPersonalFolders] = useState<LocalFolder[]>(() => listLocalFolders());
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setPersonalFolders(listLocalFolders()));
    return () => {
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const signedIn = useStore((s) => !!s.cloudAuth);
  const orgsAvailable = CLOUD_ENABLED && signedIn && (!gateOnSync || syncEnabled());
  const [orgs, setOrgs] = useState<WorkspaceRef[] | null>(null);
  const [orgFolders, setOrgFolders] = useState<Record<string, NamedFolder[]>>({});
  const [epoch, setEpoch] = useState(0);

  // Dynamic import: the cloud modules must stay out of the OSS (local-only)
  // bundle, so they are only reached from inside a CLOUD_ENABLED branch.
  useEffect(() => {
    if (!orgsAvailable) {
      setOrgs([]);
      setOrgFolders({});
      return;
    }
    if (!enabled) return;
    let alive = true;
    async function load() {
      const { listMyOrgs } = await import("../lib/cloud/orgs");
      const { listOrgFolders } = await import("../lib/cloud/folders");
      const mine = await listMyOrgs();
      if (!alive) return;
      setOrgs(mine.map((o) => ({ id: o.id, name: o.name })));
      const pairs = await Promise.all(mine.map((o) => loadOrgFolderPair(o.id, listOrgFolders)));
      if (alive) setOrgFolders(Object.fromEntries(pairs));
    }
    load().catch((error) => {
      log.warn("destination: org load failed", { error: String(error) });
      if (alive) setOrgs((prev) => prev ?? []);
    });
    return () => {
      alive = false;
    };
  }, [orgsAvailable, enabled, epoch]);

  return { personalFolders, orgs, orgFolders, reload: () => setEpoch((n) => n + 1) };
}

/** A destination's crumbs, named from whatever the sources know so far. */
function useCrumb(sources: DestinationSources) {
  const { t } = useI18n();
  return (d: LibraryDestination, newFolder?: string | null): string => {
    const folders = d.scope === "personal" ? sources.personalFolders : (sources.orgFolders[d.orgId] ?? []);
    const crumbs = breadcrumb(d, { personal: t("destination.personal"), orgs: sources.orgs ?? [], folders });
    if (newFolder) crumbs.splice(1, crumbs.length - 1, newFolder);
    return formatBreadcrumb(crumbs);
  };
}

/** A workspace's filing folders; null while an org's are still loading. */
function workspaceFolders(
  ws: string,
  sources: DestinationSources,
  personalFolders: boolean,
  current: LibraryDestination | null
): NamedFolder[] | null {
  if (ws !== PERSONAL_WORKSPACE) return sources.orgFolders[ws] ?? null;
  if (!personalFolders) return [];
  // An archived folder is not a destination — except the one the recording is in.
  return filingChoices(sources.personalFolders, current?.scope === "personal" ? current.folderId : null);
}

/**
 * Where the sheet opens: the recording's place, else the caller's pick so far,
 * else (nothing yet) the last-used place. A remembered folder that has since
 * gone opens on its workspace root instead of a pick the list cannot show.
 */
function openingDestination(o: {
  current: LibraryDestination | null;
  initial: LibraryDestination | null;
  lastUsed: LibraryDestination | null;
  orgs: WorkspaceRef[] | null;
  lockWorkspace: string | undefined;
  foldersOf: (ws: string) => NamedFolder[] | null;
}): LibraryDestination {
  const known = o.current ?? o.initial;
  let proposed: LibraryDestination;
  if (o.lockWorkspace) proposed = known ?? workspaceRoot(o.lockWorkspace);
  else proposed = initialDestination(known, known ? null : o.lastUsed, o.orgs);
  const ws = workspaceOf(proposed);
  const folders = o.foldersOf(ws);
  const gone = !!proposed.folderId && !!folders && !folders.some((f) => f.id === proposed.folderId);
  return gone ? workspaceRoot(ws) : proposed;
}

/** Create the staged new folder (if any) in the picked workspace. */
async function createStagedFolder(
  selected: LibraryDestination,
  name: string | null,
  reload: () => void
): Promise<LibraryDestination> {
  if (!name) return selected;
  if (selected.scope === "personal") {
    const created = createLocalFolder(name);
    emitFoldersUpdated().catch(() => {});
    return { scope: "personal", folderId: created.id };
  }
  const { createOrgFolder } = await import("../lib/cloud/folders");
  const created = await createOrgFolder(selected.orgId, name);
  reload();
  return { scope: "org", orgId: selected.orgId, folderId: created.id };
}

/** Into an org from Personal is a handoff — a copy when the personal original
 *  is kept, else a move. Anything else is not a handoff at all. */
function handoffMode(
  dest: LibraryDestination,
  current: LibraryDestination | null,
  keepCopy: boolean
): OrgHandoffMode | null {
  if (dest.scope !== "org" || current?.scope === "org") return null;
  return keepCopy ? "copy" : "move";
}

function orgNameOf(orgs: WorkspaceRef[] | null, d: LibraryDestination): string {
  if (d.scope !== "org") return "";
  return orgs?.find((o) => o.id === d.orgId)?.name ?? "";
}

// ── The sheet ───────────────────────────────────────────────────────────────

function actionLabel(t: ReturnType<typeof useI18n>["t"], action: PrimaryAction): string {
  switch (action.kind) {
    case "move":
      return t("dest.action.move", { target: action.target });
    case "save":
      return t("dest.action.save", { target: action.target });
    case "share":
      return t("dest.action.share", { target: action.target });
    case "stay":
      return t("dest.action.stay", { target: action.target });
    case "shareOff":
      return t("dest.action.shareOff");
  }
}

export function DestinationSheet({
  open,
  onOpenChange,
  title,
  verb,
  current,
  initial = null,
  initialMode = null,
  onConfirm,
  gateOnSync = false,
  lockWorkspace,
  personalFolders = true,
  allowKeepCopy = true,
  sources: sourcesProp,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  verb: DestinationVerb;
  /** Where the recording is now — null for one that does not exist yet. */
  current: LibraryDestination | null;
  /** For a new recording: the pick so far. Null falls back to the last-used place. */
  initial?: LibraryDestination | null;
  /** For a new recording heading into an org: whether the personal copy was kept. */
  initialMode?: OrgHandoffMode | null;
  /** The pick. `mode` is null for Personal; for an org it is "copy" when the
   *  personal original is kept, else "move". */
  onConfirm: (destination: LibraryDestination, mode: OrgHandoffMode | null) => void;
  gateOnSync?: boolean;
  /** Pin the sheet to one workspace (an org recording files within its org). */
  lockWorkspace?: string;
  /** Offer Personal's folders. Off for the auto-share default, where Personal
   *  only means "don't share". */
  personalFolders?: boolean;
  allowKeepCopy?: boolean;
  /** Supply sources already loaded by the caller instead of fetching again. */
  sources?: DestinationSources;
}>) {
  const { t } = useI18n();
  const ownSources = useDestinationSources(open && !sourcesProp, gateOnSync);
  const sources = sourcesProp ?? ownSources;
  const crumb = useCrumb(sources);

  // What the sheet opens on. Re-derived on every open; the user's own pick in
  // this session overrides it until the sheet closes.
  const [picked, setPicked] = useState<LibraryDestination | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [keepCopy, setKeepCopy] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastUsed = useMemo(() => (open ? loadLastDestination() : null), [open]);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setNewFolder(null);
    setKeepCopy(initialMode === "copy");
    setQuery("");
    setCreating(false);
    setBusy(false);
  }, [open, initialMode]);

  const workspaces: WorkspaceRef[] = useMemo(
    () => [{ id: PERSONAL_WORKSPACE, name: t("destination.personal") }, ...(sources.orgs ?? [])],
    [sources.orgs, t]
  );

  const foldersOf = (ws: string) => workspaceFolders(ws, sources, personalFolders, current);
  const selected =
    picked ?? openingDestination({ current, initial, lastUsed, orgs: sources.orgs, lockWorkspace, foldersOf });
  const workspace = workspaceOf(selected);
  const folders = foldersOf(workspace);
  const showFolderList = workspace !== PERSONAL_WORKSPACE || personalFolders;

  function pickWorkspace(ws: string) {
    setNewFolder(null);
    setQuery("");
    setCreating(false);
    // Coming back to the workspace the recording is in lands on its folder.
    setPicked(current && workspaceOf(current) === ws ? current : workspaceRoot(ws));
  }

  function pickFolder(folderId: string | null) {
    setNewFolder(null);
    setPicked(inWorkspace(workspace, folderId));
  }

  function stageNewFolder(name: string) {
    const clean = name.trim();
    if (!clean) return;
    // A name that already exists is that folder, not a second one.
    const existing = folders?.find((f) => f.name.trim() === clean);
    if (existing) {
      pickFolder(existing.id);
    } else {
      setPicked(workspaceRoot(workspace));
      setNewFolder(clean);
    }
    setCreating(false);
    setQuery("");
  }

  // A folder still to be created is never "where it already is".
  const action = primaryAction(verb, newFolder ? null : current, selected, crumb(selected, newFolder));
  const showKeepCopy = allowKeepCopy && offersKeepCopy(current, selected);
  const disabled = busy || action.kind === "stay" || (showFolderList && folders === null);

  async function confirm() {
    if (disabled) return;
    setBusy(true);
    try {
      const dest = await createStagedFolder(selected, newFolder, sources.reload);
      if (verb !== "share") saveLastDestination(dest);
      onOpenChange(false);
      onConfirm(dest, handoffMode(dest, current, showKeepCopy && keepCopy));
    } catch (error) {
      log.error("destination: folder create failed", { error: String(error) });
      toast.error(t("dest.createFailed", { error: String(error instanceof Error ? error.message : error) }));
      setBusy(false);
    }
  }

  const showSwitch = !lockWorkspace && workspaces.length > 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={title}
        description={current ? t("dest.currentlyIn", { place: crumb(current) }) : undefined}
        closeLabel={t("common.close")}
        // Esc while naming a new folder closes the field, not the sheet.
        onEscapeKeyDown={(e) => {
          if (!creating) return;
          e.preventDefault();
          setCreating(false);
        }}
        footer={
          <SheetActions
            orgNote={revealsToOrg(current, selected) ? t("dest.orgNote", { org: orgNameOf(sources.orgs, selected) }) : null}
            keepCopy={showKeepCopy ? keepCopy : null}
            onKeepCopyChange={setKeepCopy}
            label={actionLabel(t, action)}
            busy={busy}
            disabled={disabled}
            onCancel={() => onOpenChange(false)}
            onConfirm={() => void confirm()}
          />
        }
      >
        {/* The workspace switch and the search stay put while the list scrolls
            under them — the list is the sheet's own scroll area. */}
        <FolderPane
          switcher={
            showSwitch ? (
              <WorkspaceSwitch workspaces={workspaces} value={workspace} onChange={pickWorkspace} />
            ) : null
          }
          folders={showFolderList ? folders : []}
          hidden={!showFolderList}
          query={query}
          onQueryChange={setQuery}
          selectedFolderId={newFolder ? undefined : selected.folderId}
          currentFolderId={current && workspaceOf(current) === workspace ? current.folderId : undefined}
          newFolder={newFolder}
          creating={creating}
          onStartCreate={() => setCreating(true)}
          onPick={pickFolder}
          onStage={stageNewFolder}
        />
      </SheetContent>
    </Sheet>
  );
}

/** The workspace switch and search (sticky), then the folder list — the
 *  sheet's own scroll area, so the list scrolls with the sheet. */
function FolderPane({
  switcher,
  folders,
  hidden,
  query,
  onQueryChange,
  selectedFolderId,
  currentFolderId,
  newFolder,
  creating,
  onStartCreate,
  onPick,
  onStage,
}: Readonly<{
  switcher: ReactNode;
  /** null while loading. */
  folders: NamedFolder[] | null;
  /** No folder list at all (Personal in the auto-share setting). */
  hidden: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  /** The picked folder (null = root); undefined when a new folder is staged. */
  selectedFolderId: string | null | undefined;
  /** The recording's folder in this workspace; undefined when it is elsewhere. */
  currentFolderId: string | null | undefined;
  newFolder: string | null;
  creating: boolean;
  onStartCreate: () => void;
  onPick: (folderId: string | null) => void;
  onStage: (name: string) => void;
}>) {
  const { t } = useI18n();
  const shown = folders ? filterFolders(folders, query) : [];
  const offerCreate = !!folders && canCreateFolder(folders, query);
  const showSearch = !hidden && !!folders && needsFolderSearch(folders.length);
  const header = !!switcher || showSearch;

  return (
    <>
      {header && (
        <div className="sticky top-0 z-10 flex flex-col gap-3 bg-background px-4 pb-2 pt-3">
          {switcher}
          {showSearch && (
            <FolderSearchField
              value={query}
              onChange={onQueryChange}
              onSubmit={() => {
                if (offerCreate && shown.length === 0) onStage(query);
              }}
            />
          )}
        </div>
      )}
      {!hidden && (
        <div className={cn("px-4 pb-3", !header && "pt-3")}>
          {folders ? (
            <div className="flex flex-col gap-px">
              {!query && (
                <FolderRow
                  icon={<FolderClosed className="size-3.5" />}
                  label={t("dest.noFolder")}
                  selected={selectedFolderId === null}
                  isCurrent={currentFolderId === null}
                  onSelect={() => onPick(null)}
                />
              )}
              {shown.map((f) => (
                <FolderRow
                  key={f.id}
                  icon={<Folder className="size-3.5" />}
                  label={f.name}
                  selected={selectedFolderId === f.id}
                  isCurrent={currentFolderId === f.id}
                  onSelect={() => onPick(f.id)}
                />
              ))}
              {newFolder && (
                <FolderRow icon={<Plus className="size-3.5" />} label={newFolder} selected isCurrent={false} />
              )}
              {query && shown.length === 0 && !offerCreate && (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("dest.noMatch")}</p>
              )}
              <NewFolderRow
                creating={creating}
                query={offerCreate ? query.trim() : ""}
                onStart={onStartCreate}
                onSubmit={onStage}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** The org note, the keep-a-copy box, and the two buttons. */
function SheetActions({
  orgNote,
  keepCopy,
  onKeepCopyChange,
  label,
  busy,
  disabled,
  onCancel,
  onConfirm,
}: Readonly<{
  /** Who will see the recording; null when nobody new will. */
  orgNote: string | null;
  /** The box's state; null hides it. */
  keepCopy: boolean | null;
  onKeepCopyChange: (keep: boolean) => void;
  label: string;
  busy: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-col gap-2.5">
      {orgNote && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UsersRound className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{orgNote}</span>
        </p>
      )}
      {keepCopy !== null && (
        <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={keepCopy}
            onChange={(e) => onKeepCopyChange(e.target.checked)}
          />
          {t("dest.keepCopy")}
        </label>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" className="h-8 min-w-0 max-w-[75%]" disabled={disabled} onClick={onConfirm}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          <span className="truncate">{label}</span>
        </Button>
      </div>
    </div>
  );
}

function FolderSearchField({
  value,
  onChange,
  onSubmit,
}: Readonly<{ value: string; onChange: (q: string) => void; onSubmit: () => void }>) {
  const { t } = useI18n();
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={t("dest.search")}
        aria-label={t("dest.search")}
        className="h-full w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** Personal + each org: a segmented control while they fit, a search past that. */
function WorkspaceSwitch({
  workspaces,
  value,
  onChange,
}: Readonly<{ workspaces: WorkspaceRef[]; value: string; onChange: (id: string) => void }>) {
  const { t } = useI18n();
  if (workspaceControl(workspaces.length) === "combobox") {
    return (
      <Combobox
        value={value}
        groups={[{ options: workspaces.map((w) => ({ value: w.id, label: w.name })) }]}
        onChange={onChange}
        contentClassName="w-[var(--radix-popover-trigger-width)]"
        placeholder={t("destination.personal")}
        searchPlaceholder={t("dest.searchWorkspace")}
        emptyText={t("folder.noMatch")}
        icon={
          value === PERSONAL_WORKSPACE ? (
            <User className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <UsersRound className="size-3.5 shrink-0 text-muted-foreground" />
          )
        }
      />
    );
  }
  return (
    <Tabs value={value} onValueChange={onChange}>
      <TabsList aria-label={t("dest.workspace")} className="w-full">
        {workspaces.map((w) => (
          <TabsTrigger key={w.id} value={w.id} className="min-w-0 text-xs">
            {w.id === PERSONAL_WORKSPACE ? <User className="size-3.5" /> : <UsersRound className="size-3.5" />}
            <span className="truncate">{w.name}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function FolderRow({
  icon,
  label,
  selected,
  isCurrent,
  onSelect,
}: Readonly<{
  icon: ReactNode;
  label: string;
  selected: boolean;
  isCurrent: boolean;
  /** Omit for a row that only shows the pick (a folder still to be created). */
  onSelect?: () => void;
}>) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted",
        selected && "bg-muted font-medium"
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {isCurrent && <span className="shrink-0 text-[10px] text-muted-foreground">{t("dest.here")}</span>}
      {selected && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}

/** 「新增資料夾」: a row that opens into a name field. When the search found
 *  nothing it offers the search itself — 建立「…」. */
function NewFolderRow({
  creating,
  query,
  onStart,
  onSubmit,
}: Readonly<{
  creating: boolean;
  query: string;
  onStart: () => void;
  onSubmit: (name: string) => void;
}>) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!creating) return;
    setName(query);
    inputRef.current?.focus();
  }, [creating, query]);

  if (query && !creating) {
    return (
      <button
        type="button"
        onClick={() => onSubmit(query)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-primary transition-colors hover:bg-muted"
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("owner.create", { name: query })}</span>
      </button>
    );
  }
  if (!creating) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-primary transition-colors hover:bg-muted"
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("dest.newFolder")}</span>
      </button>
    );
  }
  return (
    <div className="flex h-8 items-center gap-2 rounded-md border border-input px-2">
      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(name);
          }
        }}
        placeholder={t("dest.folderName")}
        aria-label={t("dest.folderName")}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ── The field ───────────────────────────────────────────────────────────────

/**
 * The destination as a form field — for the doors that ask before a recording
 * exists (the import dialogs) and for the auto-share setting. Shows the pick
 * as a breadcrumb; clicking opens {@link DestinationSheet}.
 */
export function DestinationField({
  value,
  mode = null,
  fresh = false,
  onChange,
  verb,
  title,
  gateOnSync = false,
  personalFolders = true,
  allowKeepCopy = true,
}: Readonly<{
  value: LibraryDestination;
  mode?: OrgHandoffMode | null;
  /** Nothing has been picked yet — the sheet may open on the last-used place. */
  fresh?: boolean;
  onChange: (destination: LibraryDestination, mode: OrgHandoffMode | null) => void;
  verb: Exclude<DestinationVerb, "move">;
  title: string;
  gateOnSync?: boolean;
  personalFolders?: boolean;
  allowKeepCopy?: boolean;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sources = useDestinationSources(true, gateOnSync);
  const crumb = useCrumb(sources);
  // A stored org the user can no longer reach reads as Personal.
  const shownValue =
    value.scope === "org" && sources.orgs && !sources.orgs.some((o) => o.id === value.orgId)
      ? workspaceRoot(PERSONAL_WORKSPACE)
      : value;
  const label =
    verb === "share" && shownValue.scope === "personal" ? t("dest.action.shareOff") : crumb(shownValue);
  const isOrg = shownValue.scope === "org";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={title}
        title={title}
        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {isOrg ? (
          <UsersRound className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {isOrg && mode === "copy" && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{t("dest.keepCopyHint")}</span>
        )}
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </button>
      <DestinationSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        verb={verb}
        current={null}
        initial={fresh ? null : shownValue}
        initialMode={mode}
        onConfirm={onChange}
        gateOnSync={gateOnSync}
        personalFolders={personalFolders}
        allowKeepCopy={allowKeepCopy}
        sources={sources}
      />
    </>
  );
}
