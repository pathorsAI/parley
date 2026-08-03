import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArchiveRestore,
  Building2,
  Check,
  ChevronRight,
  Folder,
  FolderClosed,
  FolderPlus,
  House,
  Mic,
  Pencil,
  Plus,
  Swords,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useAccounts, threadsOf, triageClaims, personsOf } from "../../lib/accounts/store";
import { ensureCompanyFolder } from "../../lib/accounts/folders";
import { countInFolderNode } from "../../lib/library/scope";
import { useStore, type LibrarySelection } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { LibraryTree } from "./useLibraryTree";

/**
 * The one tree (issue #195).
 *
 * Before this, a company lived in the main window's account switcher and its
 * recordings lived in a separate History window's folder tree. The data layer
 * already paired them 1:1 (`Company.folderId`), but two trees in two windows is
 * a claim that they are two things — so "I picked a company, why is the folder
 * a different question?" was the only reading available.
 *
 * Here the company IS the trunk and its folder is one of its facets:
 *
 *   公司
 *     和運租車  ⚠2
 *       戰情 · 2 條戰線
 *       錄音 · 3 場       ← Company.folderId, named after the company
 *       人 · 4 位
 *   其他資料夾            ← folders that belong to no company
 *   未歸戶錄音 · 12        ← no folder, or a folder that no longer exists
 *   組織共享              ← never mixed into the personal tree
 */
export function AppSidebar({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const appMode = useStore((s) => s.appMode);
  const accountsCompanyId = useStore((s) => s.accountsCompanyId);
  const accountsFocus = useStore((s) => s.accountsFocus);
  const selection = useStore((s) => s.librarySelection);
  const openAccounts = useStore((s) => s.openAccounts);
  const openLibrary = useStore((s) => s.openLibrary);
  const openHome = useStore((s) => s.openHome);
  const enterPreflight = useStore((s) => s.enterPreflight);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newFolderScope, setNewFolderScope] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // R8a: creation lives behind the section header's ＋ — the tree is
  // navigation, not a permanently-open data-entry form.
  const [newCompanyOpen, setNewCompanyOpen] = useState(false);

  const companies = acc.companies.filter((c) => !c.archived);
  const archived = acc.companies.filter((c) => c.archived);

  const liveFolderIds = useMemo(
    () => new Set(tree.personalFolders.map((f) => f.id)),
    [tree.personalFolders]
  );

  // How many recordings sit on each node. Counted with the SAME predicate the
  // grid filters by (lib/library/scope) over the SAME folderId the save path
  // writes (resolveMeetingSave → Company.folderId) — so "錄音 · 3 場" is a count
  // of exactly the three cards clicking it opens, and 未歸戶 sweeps up anything
  // whose folder is gone rather than letting it fall out of the tree.
  const countAt = useMemo(() => {
    // Keyed on the folderId itself (null included) so there is no sentinel
    // string that a real id could ever collide with.
    const cache = new Map<string | null, number>();
    return (folderId: string | null) => {
      const hit = cache.get(folderId);
      if (hit !== undefined) return hit;
      const n = countInFolderNode(tree.summaries, folderId, liveFolderIds);
      cache.set(folderId, n);
      return n;
    };
  }, [tree.summaries, liveFolderIds]);

  // Folders that belong to no company. They still hold recordings, so they stay
  // reachable — demoting folders must never make an old recording disappear.
  const companyFolderIds = new Set(
    acc.companies.map((c) => c.folderId).filter((id): id is string => !!id)
  );
  const looseFolders = tree.personalFolders.filter((f) => !companyFolderIds.has(f.id));

  const libraryActive = appMode === "library";
  const personalSel = selection.kind === "personal" ? selection : null;
  const orgSel = selection.kind === "org" ? selection : null;

  const selectLibrary = (sel: LibrarySelection) => openLibrary(sel);

  return (
    <nav className="flex h-full min-h-0 w-full flex-col overflow-y-auto border-r bg-background/60 px-2 py-2">
      <button
        type="button"
        onClick={enterPreflight}
        className="mb-1 flex shrink-0 items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground"
      >
        <Mic className="size-3.5 shrink-0" />
        {t("titlebar.startMeeting")}
      </button>

      <Row
        icon={<House className="size-3.5" />}
        label={t("home.title")}
        active={appMode === "home"}
        onSelect={openHome}
      />

      <GroupLabel
        action={
          <HeaderAdd
            label={t("accounts.newCompany")}
            onClick={() => setNewCompanyOpen(true)}
          />
        }
      >
        {t("accounts.title")}
      </GroupLabel>

      {companies.map((c) => {
        const open = expanded[c.id] ?? c.id === accountsCompanyId;
        const nTriage = triageClaims(acc, c.id).length;
        const nThreads = threadsOf(acc, c.id).filter((x) => x.status === "active").length;
        const nPeople = personsOf(acc, c.id).length;
        const folderId = c.folderId ?? null;
        const nRecordings = folderId ? countAt(folderId) : 0;
        const companyActive = appMode === "accounts" && accountsCompanyId === c.id;
        const recordingsActive = libraryActive && personalSel?.folderId === folderId && !!folderId;
        return (
          <Fragment key={c.id}>
            <Row
              icon={<Building2 className="size-3.5" />}
              label={c.name}
              active={companyActive || recordingsActive}
              expandable
              expanded={open}
              onToggle={() => setExpanded((p) => ({ ...p, [c.id]: !open }))}
              onSelect={() => {
                setExpanded((p) => ({ ...p, [c.id]: true }));
                openAccounts(c.id);
              }}
              badge={
                nTriage > 0 ? (
                  <span className="shrink-0 rounded-full bg-orange-500/15 px-1.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300">
                    ⚠{nTriage}
                  </span>
                ) : null
              }
            />
            {open && (
              <>
                <Row
                  depth={1}
                  icon={<Swords className="size-3.5" />}
                  label={t("shell.facet.intel", { n: nThreads })}
                  active={companyActive && accountsFocus === "intel"}
                  onSelect={() => openAccounts(c.id, "intel")}
                />
                <Row
                  depth={1}
                  icon={<Folder className="size-3.5" />}
                  label={t("shell.facet.recordings", { n: nRecordings })}
                  active={recordingsActive}
                  onSelect={() => {
                    // A company that predates the pairing (or whose folder was
                    // deleted) gets one here and now, so the node it just showed
                    // is a real place before the grid tries to read it.
                    const fid = folderId ?? ensureCompanyFolder(c);
                    selectLibrary({ kind: "personal", folderId: fid });
                  }}
                />
                <Row
                  depth={1}
                  icon={<UsersRound className="size-3.5" />}
                  label={t("shell.facet.people", { n: nPeople })}
                  active={companyActive && accountsFocus === "people"}
                  onSelect={() => openAccounts(c.id, "people")}
                />
              </>
            )}
          </Fragment>
        );
      })}

      {newCompanyOpen && (
        <NewNameInput
          placeholder={t("accounts.companyName")}
          onCommit={(name) => {
            const company = useAccounts.getState().addCompany({ name });
            ensureCompanyFolder(company);
            setNewCompanyOpen(false);
            setExpanded((p) => ({ ...p, [company.id]: true }));
            openAccounts(company.id);
            tree.reloadFolders().catch(() => {});
          }}
          onCancel={() => setNewCompanyOpen(false)}
        />
      )}

      {/* Archived companies stay reachable: view on click, restore in one. */}
      {archived.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-muted/40"
          >
            <ChevronRight
              className={`size-3 transition-transform ${showArchived ? "rotate-90" : ""}`}
            />
            <span className="text-xs">{t("accounts.archived")}</span>
            <span className="text-[10px] tabular-nums">{archived.length}</span>
          </button>
          {showArchived &&
            archived.map((c) => (
              <div
                key={c.id}
                className="group/row flex items-center gap-1 rounded-md pl-4 pr-1 hover:bg-muted/50"
              >
                <button
                  type="button"
                  onClick={() => openAccounts(c.id)}
                  className="min-w-0 flex-1 truncate py-1.5 text-left text-sm text-muted-foreground"
                >
                  {c.name}
                </button>
                <button
                  type="button"
                  title={t("accounts.restore")}
                  onClick={() => {
                    acc.unarchiveCompany(c.id);
                    openAccounts(c.id);
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover/row:text-muted-foreground"
                >
                  <ArchiveRestore className="size-3.5" />
                </button>
              </div>
            ))}
        </div>
      )}

      {/* Folders that belong to no company — kept so nothing filed before the
          company pairing existed becomes unreachable. */}
      {looseFolders.length > 0 && (
        <>
          <GroupLabel>{t("shell.otherFolders")}</GroupLabel>
          {looseFolders.map((f) => (
            <Row
              key={f.id}
              icon={<Folder className="size-3.5" />}
              label={f.name}
              count={countAt(f.id)}
              active={libraryActive && personalSel?.folderId === f.id}
              onSelect={() => selectLibrary({ kind: "personal", folderId: f.id })}
              onRename={(name) => tree.renamePersonalFolder(f.id, name)}
              onDelete={() => {
                tree.deletePersonalFolder(f);
                if (personalSel?.folderId === f.id) {
                  selectLibrary({ kind: "personal", folderId: null });
                }
              }}
            />
          ))}
        </>
      )}
      <GroupLabel
        action={
          <HeaderAdd
            label={t("history.folder.create")}
            onClick={() => setNewFolderScope("personal")}
          />
        }
      >
        {t("shell.recordings")}
      </GroupLabel>
      {newFolderScope === "personal" && (
        <NewNameInput
          placeholder={t("history.folder.namePlaceholder")}
          onCommit={(name) => {
            tree.createPersonalFolder(name);
            setNewFolderScope(null);
          }}
          onCancel={() => setNewFolderScope(null)}
        />
      )}
      <Row
        icon={<FolderClosed className="size-3.5" />}
        label={t("library.unfiled")}
        count={countAt(null)}
        active={libraryActive && personalSel?.folderId === null}
        onSelect={() => selectLibrary({ kind: "personal", folderId: null })}
      />
      <Row
        icon={<Mic className="size-3.5" />}
        label={t("history.sidebar.voiceTyping")}
        active={libraryActive && selection.kind === "voice"}
        onSelect={() => selectLibrary({ kind: "voice" })}
      />

      {/* Org-shared recordings are their own tree on purpose: a shared copy is
          someone else's file, and folding it into the personal tree would make
          "where does this live" ambiguous again. */}
      {tree.signedIn && (
        <>
          <GroupLabel>{t("history.sidebar.shared")}</GroupLabel>
          {tree.orgs.map((o) => {
            const open = !!expanded[`org:${o.id}`];
            return (
              <Fragment key={o.id}>
                <Row
                  icon={<UsersRound className="size-3.5 text-sky-500" />}
                  label={o.name}
                  expandable
                  expanded={open}
                  onToggle={() => {
                    if (!open) tree.ensureOrgFolders(o.id);
                    setExpanded((p) => ({ ...p, [`org:${o.id}`]: !open }));
                  }}
                  active={libraryActive && orgSel?.id === o.id && orgSel.folderId === null}
                  onSelect={() => {
                    tree.ensureOrgFolders(o.id);
                    setExpanded((p) => ({ ...p, [`org:${o.id}`]: true }));
                    selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: null });
                  }}
                />
                {open &&
                  (tree.orgFolders[o.id] ?? []).map((f) => (
                    <Row
                      key={f.id}
                      depth={1}
                      icon={<Folder className="size-3.5" />}
                      label={f.name}
                      active={libraryActive && orgSel?.id === o.id && orgSel.folderId === f.id}
                      onSelect={() =>
                        selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: f.id })
                      }
                      onRename={(name) => {
                        tree.renameOrgFolder(o.id, f.id, name).catch(() => {});
                      }}
                      onDelete={() => {
                        tree
                          .deleteOrgFolder(o.id, f)
                          .then((deleted) => {
                            if (deleted && orgSel?.id === o.id && orgSel.folderId === f.id) {
                              selectLibrary({
                                kind: "org",
                                id: o.id,
                                name: o.name,
                                folderId: null,
                              });
                            }
                          })
                          .catch(() => {});
                      }}
                    />
                  ))}
                {open &&
                  (newFolderScope === o.id ? (
                    <NewNameInput
                      depth={1}
                      placeholder={t("history.folder.namePlaceholder")}
                      onCommit={(name) => {
                        tree.createOrgFolder(o.id, name).catch(() => {});
                        setNewFolderScope(null);
                      }}
                      onCancel={() => setNewFolderScope(null)}
                    />
                  ) : (
                    <AddFolderButton depth={1} onClick={() => setNewFolderScope(o.id)} />
                  ))}
              </Fragment>
            );
          })}
          {tree.orgs.length === 0 && (
            <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground/70">
              {t("history.org.noOrgs")}
            </p>
          )}
        </>
      )}

    </nav>
  );
}

function GroupLabel({
  children,
  action,
}: Readonly<{ children: ReactNode; action?: ReactNode }>) {
  return (
    <div className="group/label mt-3 flex shrink-0 items-center px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </div>
  );
}

/** The section header's ＋ (R8a): visible on hover/focus, so creation is one
 *  click away without living in the tree as a permanent form. */
function HeaderAdd({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground/0 transition-colors hover:!text-foreground focus-visible:text-muted-foreground group-hover/label:text-muted-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/** A tree row: selectable, optionally expandable, optionally renameable. */
function Row({
  icon,
  label,
  depth = 0,
  active,
  count,
  badge,
  onSelect,
  expandable,
  expanded,
  onToggle,
  onRename,
  onDelete,
}: Readonly<{
  icon: ReactNode;
  label: string;
  depth?: number;
  active: boolean;
  count?: number;
  badge?: ReactNode;
  onSelect: () => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
}>) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(label);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }
  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== label) onRename?.(draft);
  }

  const pad = { paddingLeft: `${0.375 + depth * 0.9}rem` };

  if (editing) {
    return (
      <div className="flex shrink-0 items-center gap-1 rounded-md py-1 pr-1" style={pad}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-primary"
        />
      </div>
    );
  }

  return (
    <div
      className={`group/row flex shrink-0 items-center rounded-md transition-colors ${
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
      style={pad}
    >
      {expandable && (
        <button
          type="button"
          // Distinct from the row's own name: a chevron that reads as "和運租車"
          // gives a screen reader two controls with the same label and no way
          // to tell "open this company" from "expand its facets".
          aria-label={t("shell.toggle", { name: label })}
          aria-expanded={!!expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          className="grid size-4 shrink-0 place-items-center text-muted-foreground/70 hover:text-foreground"
        >
          <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onRename ? startEdit : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1 pr-1 text-left text-sm"
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge}
        {typeof count === "number" && count > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{count}</span>
        )}
      </button>
      {(onRename ?? onDelete) && (
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition group-hover/row:opacity-100">
          {onRename && (
            <button
              type="button"
              aria-label={t("history.folder.rename")}
              title={t("history.folder.rename")}
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              aria-label={t("history.folder.delete")}
              title={t("history.folder.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline name composer, opened on demand from a section header's ＋ (company
 *  or folder — the placeholder is the only difference). */
function NewNameInput({
  depth = 0,
  placeholder,
  onCommit,
  onCancel,
}: Readonly<{
  depth?: number;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-md py-1 pr-1"
      style={{ paddingLeft: `${0.375 + depth * 0.9}rem` }}
    >
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => (value.trim() ? onCommit(value) : onCancel())}
        className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-primary"
      />
      <button
        type="button"
        aria-label={t("history.folder.create")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (value.trim() ? onCommit(value) : onCancel())}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
      >
        <Check className="size-3.5" />
      </button>
    </div>
  );
}

function AddFolderButton({
  depth = 0,
  onClick,
}: Readonly<{ depth?: number; onClick: () => void }>) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${0.375 + depth * 0.9}rem` }}
      className="flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
    >
      <FolderPlus className="size-3.5" />
      {t("history.folder.new")}
    </button>
  );
}
