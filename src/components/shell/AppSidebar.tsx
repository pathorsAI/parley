import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronRight,
  Folder,
  FolderClosed,
  FolderPlus,
  House,
  Mic,
  Pencil,
  Plus,
  Trash2,
  UsersRound,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  openMenuFromKeyboard,
  preventFocusRestore,
} from "../ui/context-menu";
import { buildOwnershipIndex, countByNode, nodeKey, type LibraryNode } from "../../lib/library/scope";
import { beginMeeting } from "../../lib/meeting/start";
import { useStore, type LibrarySelection } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { LibraryTree } from "./useLibraryTree";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { CloudOrg } from "../../lib/cloud/types";

/**
 * The one tree (issue #195).
 *
 * A recording's node is the FOLDER it is filed in — one customer, one folder,
 * and the number beside a row is a count of exactly what clicking it opens.
 *
 *   資料夾
 *     和運租車 · 8
 *     台數科 · 3
 *   還沒歸檔 · 7           ← filed nowhere yet
 *   語音輸入
 *   組織共享              ← never mixed into the personal tree
 */
export function AppSidebar({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t } = useI18n();
  const appMode = useStore((s) => s.appMode);
  const selection = useStore((s) => s.librarySelection);
  const openLibrary = useStore((s) => s.openLibrary);
  const openHome = useStore((s) => s.openHome);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newFolderScope, setNewFolderScope] = useState<string | null>(null);
  // R8a: creation lives behind the section header's ＋ — the tree is
  // navigation, not a permanently-open data-entry form.
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  // Folder facts + every node's count in one pass. The grid filters with the
  // SAME index and the SAME rule (lib/library/scope), so "和運租車 · 8" is a
  // count of exactly the eight cards clicking it opens.
  const index = buildOwnershipIndex(tree.personalFolders);
  const counts = countByNode(tree.summaries, index);
  // `all` owns nothing, so it is not in the one-pass count — what it opens is
  // simply every summary, which is what its number has to be.
  const countAt = (node: LibraryNode) =>
    node.kind === "all" ? tree.summaries.length : counts.get(nodeKey(node)) ?? 0;

  const libraryActive = appMode === "library";
  const personalSel = selection.kind === "personal" ? selection : null;
  const orgSel = selection.kind === "org" ? selection : null;
  const nodeActive = (node: LibraryNode) =>
    libraryActive && !!personalSel && nodeKey(personalSel.node) === nodeKey(node);

  const selectLibrary = (sel: LibrarySelection) => openLibrary(sel);

  const nav = (
    <nav className="flex h-full min-h-0 w-full flex-col overflow-y-auto border-r bg-background/60 px-2 py-2">
      <button
        type="button"
        onClick={() => void beginMeeting()}
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

      {/* Every recording, by date (#330). Above the folders on purpose: it is the
          answer when you cannot remember which folder you filed something in,
          which is most of the time. */}
      <Row
        icon={<AudioLines className="size-3.5" />}
        label={t("library.all")}
        count={countAt({ kind: "all" })}
        active={nodeActive({ kind: "all" })}
        onSelect={() => selectLibrary({ kind: "personal", node: { kind: "all" } })}
      />

      <GroupLabel
        action={
          <HeaderAdd label={t("history.folder.new")} onClick={() => setNewFolderOpen(true)} />
        }
      >
        {t("shell.folders")}
      </GroupLabel>

      {tree.personalFolders.map((f) => {
        const node: LibraryNode = { kind: "folder", folderId: f.id };
        return (
          <Row
            key={f.id}
            icon={<Folder className="size-3.5" />}
            label={f.name}
            count={countAt(node)}
            active={nodeActive(node)}
            onSelect={() => selectLibrary({ kind: "personal", node })}
            onRename={(name) => tree.renamePersonalFolder(f.id, name)}
            onDelete={() => {
              tree.deletePersonalFolder(f);
              if (nodeActive(node)) {
                selectLibrary({ kind: "personal", node: { kind: "unassigned" } });
              }
            }}
          />
        );
      })}

      {newFolderOpen && (
        <NewNameInput
          placeholder={t("history.folder.namePlaceholder")}
          onCommit={(name) => {
            const id = tree.createPersonalFolder(name);
            setNewFolderOpen(false);
            if (id) selectLibrary({ kind: "personal", node: { kind: "folder", folderId: id } });
          }}
          onCancel={() => setNewFolderOpen(false)}
        />
      )}

      {/* Everything filed nowhere yet, in one place — one click from a folder. */}
      <Row
        icon={<FolderClosed className="size-3.5" />}
        label={t("library.unassigned")}
        count={countAt({ kind: "unassigned" })}
        active={nodeActive({ kind: "unassigned" })}
        onSelect={() => selectLibrary({ kind: "personal", node: { kind: "unassigned" } })}
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
                    <OrgFolderRow
                      key={f.id}
                      tree={tree}
                      org={o}
                      folder={f}
                      active={libraryActive && orgSel?.id === o.id && orgSel.folderId === f.id}
                      onSelect={() =>
                        selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: f.id })
                      }
                      onDeleted={() => {
                        if (orgSel?.id === o.id && orgSel.folderId === f.id) {
                          selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: null });
                        }
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

  // The tree's own menu. Rows carry their own (see Row), and stop the event
  // there, so this one only answers right-clicks on the section headers and the
  // empty space below the tree — where "what can I even do here" has no answer
  // other than the ＋ hiding in a header until you hover it.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{nav}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={preventFocusRestore}>
        <ContextMenuItem onSelect={() => setNewFolderOpen(true)}>
          <FolderPlus className="size-3.5" />
          {t("sidebar.menu.newFolder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One shared folder under an org. Its own component so the rename/delete
 * promise handlers don't sit five callbacks deep inside the org list.
 */
function OrgFolderRow({
  tree,
  org,
  folder,
  active,
  onSelect,
  onDeleted,
}: Readonly<{
  tree: LibraryTree;
  org: CloudOrg;
  folder: LocalFolder;
  active: boolean;
  onSelect: () => void;
  /** Called only when the delete actually went through. */
  onDeleted: () => void;
}>) {
  return (
    <Row
      depth={1}
      icon={<Folder className="size-3.5" />}
      label={folder.name}
      active={active}
      onSelect={onSelect}
      onRename={(name) => {
        tree.renameOrgFolder(org.id, folder.id, name).catch(() => {});
      }}
      onDelete={() => {
        tree
          .deleteOrgFolder(org.id, folder)
          .then((deleted) => {
            if (deleted) onDeleted();
          })
          .catch(() => {});
      }}
    />
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
  const selectRef = useRef<HTMLButtonElement>(null);
  // The menu's close handler runs from a listener Radix registered on an
  // earlier render, so reading `editing` through the closure can report the
  // stale value and steal focus back off the name input.
  const editingRef = useRef(editing);
  editingRef.current = editing;

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
          // Right-clicking a text field has to reach the webview's own edit
          // menu; without this the sidebar's menu swallows cut/copy/paste.
          onContextMenu={(e) => e.stopPropagation()}
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

  // Same two actions the hover icons run — the menu is a second way to reach
  // them, not a second implementation of them.
  const actionable = !!(onRename ?? onDelete);

  const row = (
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
        ref={selectRef}
        type="button"
        onClick={onSelect}
        onDoubleClick={onRename ? startEdit : undefined}
        // The row's only focusable element, so it is where a keyboard user is
        // standing when they ask for the menu; the event bubbles to the trigger.
        onKeyDown={actionable ? openMenuFromKeyboard : undefined}
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

  if (!actionable) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // The whole sidebar is a trigger too (for "New folder" on empty space).
        // Without this the one right-click opens both menus stacked.
        onContextMenu={(e) => e.stopPropagation()}
      >
        {row}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          preventFocusRestore(event);
          // Closing without renaming should leave the keyboard where it was,
          // and Radix's own restore aims at the trigger — a plain <div>, which
          // cannot take focus, so it would drop to the body instead.
          if (!editingRef.current) selectRef.current?.focus();
        }}
      >
        <ContextMenuLabel>{label}</ContextMenuLabel>
        <ContextMenuSeparator />
        {onRename && (
          <ContextMenuItem onSelect={startEdit}>
            <Pencil className="size-3.5" />
            {t("sidebar.menu.rename")}
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem
            variant="destructive"
            onSelect={() => {
              // Delete confirms with a blocking confirm() (useLibraryTree), and
              // blocking mid-close leaves the menu painted over the sheet.
              requestAnimationFrame(() => onDelete());
            }}
          >
            <Trash2 className="size-3.5" />
            {t("sidebar.menu.delete")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Inline name composer, opened on demand from a section header's ＋. */
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
        // See the rename input: the sidebar's menu would otherwise take the
        // place of the webview's cut/copy/paste menu.
        onContextMenu={(e) => e.stopPropagation()}
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
