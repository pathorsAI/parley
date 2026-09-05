import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AudioLines, Folder, FolderClosed, House, Mic, Search, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { buildOwnershipIndex, countByNode, nodeKey, type LibraryNode } from "../../lib/library/scope";
import {
  searchTargets,
  targetKey,
  targetLabel,
  type QuickSwitchLabels,
  type QuickTarget,
} from "../../lib/library/quickSwitch";
import { loadHistoryEntry } from "../../lib/history/history";
import { isMeetingActive, useStore } from "../../lib/store";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import type { LibraryTree } from "./useLibraryTree";

/**
 * ⌘K — name it and go (issue #332).
 *
 * The one tree beside this is aim-and-click: to reach 和運租車 you first have to
 * find the row, which means knowing where it sits. That is the right default
 * for browsing and the wrong one for the case that actually dominates — you
 * already know the name, you just want to be there. This is that path: type
 * four characters, hit ↵, land.
 *
 * It is deliberately a JUMP-TO switcher, not a command runner. Every row is a
 * PLACE (a folder, an org, a recording, home), never an action, so pressing ↵
 * on a highlighted row can only ever navigate — it can't rename, delete, share
 * or start a meeting. A palette that mixes destinations and verbs makes ↵ a
 * gamble, and the one place you must never gamble is over a list your finger is
 * already scrolling through. Actions stay where they are: on the row, on the
 * card, under the pointer.
 *
 * It never opens over a RUNNING meeting, for the same reason the shell hides
 * the tree there — the live coach owns that window.
 */
export function CommandPalette({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t } = useI18n();
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // ⌘K / Ctrl+K toggles. The guard reads the store directly rather than the
  // subscribed value so the listener never has to be re-registered.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isMeetingActive(useStore.getState().meetingStatus)) return;
        setOpen((o) => !o);
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, []);

  // A meeting starting while the palette is up takes the window back.
  useEffect(() => {
    if (meetingActive) setOpen(false);
  }, [meetingActive]);

  // Every open is a fresh start: last search left up is a search you have to
  // clear before you can use the thing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  // Warm the org folder caches so a SECOND open can already offer them. The
  // palette never blocks on a fetch — what isn't cached simply isn't listed.
  const { signedIn, orgs, ensureOrgFolders } = tree;
  useEffect(() => {
    if (!open || !signedIn) return;
    for (const org of orgs) ensureOrgFolders(org.id);
  }, [open, signedIn, orgs, ensureOrgFolders]);

  const labels: QuickSwitchLabels = {
    home: t("home.title"),
    unassigned: t("library.unassigned"),
    voice: t("history.sidebar.voiceTyping"),
  };

  // The same index and the same rule the sidebar counts with (lib/library/scope),
  // so "和運租車 · 8" reads the same here as it does in the tree.
  const index = buildOwnershipIndex(tree.personalFolders);
  const counts = countByNode(tree.summaries, index);
  const countAt = (node: LibraryNode) => counts.get(nodeKey(node)) ?? 0;
  const folderNames = new Map(tree.personalFolders.map((f) => [f.id, f.name]));

  const targets: QuickTarget[] = [{ kind: "home" }];
  for (const f of tree.personalFolders) {
    targets.push({
      kind: "folder",
      id: f.id,
      name: f.name,
      count: countAt({ kind: "folder", folderId: f.id }),
    });
  }
  targets.push({ kind: "unassigned", count: countAt({ kind: "unassigned" }) });
  targets.push({ kind: "voice" });
  if (tree.signedIn) {
    for (const org of tree.orgs) {
      targets.push({ kind: "org", orgId: org.id, orgName: org.name });
      for (const f of tree.orgFolders[org.id] ?? []) {
        targets.push({
          kind: "orgFolder",
          orgId: org.id,
          orgName: org.name,
          id: f.id,
          name: f.name,
        });
      }
    }
  }
  for (const s of tree.summaries) {
    targets.push({
      kind: "recording",
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      folderId: s.folderId ?? null,
    });
  }

  // Cheap enough to redo per render, and always in step with the tree.
  const results = open ? searchTargets(targets, query, labels) : [];
  const count = results.length;

  // A shorter list must not leave the highlight pointing past the end.
  useEffect(() => {
    setActive((i) => (count === 0 ? 0 : Math.min(i, count - 1)));
  }, [count]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, count]);

  async function activate(target: QuickTarget) {
    const { openHome, openLibrary } = useStore.getState();
    // Close first: the palette must never sit over the route it just opened.
    setOpen(false);
    switch (target.kind) {
      case "home":
        openHome();
        return;
      case "folder":
        openLibrary({ kind: "personal", node: { kind: "folder", folderId: target.id } });
        return;
      case "unassigned":
        openLibrary({ kind: "personal", node: { kind: "unassigned" } });
        return;
      case "voice":
        openLibrary({ kind: "voice" });
        return;
      case "org":
        tree.ensureOrgFolders(target.orgId);
        openLibrary({ kind: "org", id: target.orgId, name: target.orgName, folderId: null });
        return;
      case "orgFolder":
        openLibrary({ kind: "org", id: target.orgId, name: target.orgName, folderId: target.id });
        return;
      case "recording":
        try {
          // Switches the app to the study route itself.
          await loadHistoryEntry(target.id);
        } catch (e) {
          log.error("palette: open failed", { id: target.id, error: String(e) });
          toast.error(
            t("shell.palette.openFailed", {
              error: e instanceof Error ? e.message : String(e),
            })
          );
        }
    }
  }

  function step(delta: 1 | -1) {
    if (count === 0) return;
    setActive((i) => (i + delta + count) % count);
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[active];
      if (target) void activate(target);
    }
    // Escape is the Dialog's — it already closes and restores focus.
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[94] bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-slot="command-palette"
          className="fixed left-1/2 top-[15vh] z-[95] flex w-[calc(100%-2rem)] max-w-[34rem] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("shell.palette.title")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t("shell.palette.placeholder")}
          </DialogPrimitive.Description>

          <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              placeholder={t("shell.palette.placeholder")}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="h-px shrink-0 bg-border" />

          <div className="max-h-[22rem] overflow-y-auto p-1">
            {count === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">{t("shell.palette.empty")}</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  {t("shell.palette.emptyHint")}
                </p>
              </div>
            ) : (
              results.map((target, i) => (
                <PaletteRow
                  key={targetKey(target)}
                  rowRef={i === active ? activeRef : undefined}
                  icon={iconFor(target)}
                  label={targetLabel(target, labels)}
                  meta={metaFor(target, folderNames, t)}
                  active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onSelect={() => void activate(target)}
                />
              ))
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground/70">
            <Hint keys="↑↓" label={t("shell.palette.hint.move")} />
            <Hint keys="↵" label={t("shell.palette.hint.open")} />
            <Hint keys="esc" label={t("shell.palette.hint.close")} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The icons match the sidebar's, so a row means the same thing in both. */
function iconFor(target: QuickTarget): ReactNode {
  switch (target.kind) {
    case "home":
      return <House className="size-3.5" />;
    case "folder":
    case "orgFolder":
      return <Folder className="size-3.5" />;
    case "unassigned":
      return <FolderClosed className="size-3.5" />;
    case "voice":
      return <Mic className="size-3.5" />;
    case "org":
      return <UsersRound className="size-3.5 text-sky-500" />;
    case "recording":
      return <AudioLines className="size-3.5" />;
  }
}

/** The muted right-hand line: WHERE the row lives, so two same-named things
 *  are still tellable apart without opening either. */
function metaFor(
  target: QuickTarget,
  folderNames: ReadonlyMap<string, string>,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
): string {
  switch (target.kind) {
    case "recording": {
      const folder = (target.folderId && folderNames.get(target.folderId)) || t("library.unassigned");
      return t("shell.palette.recordingIn", { folder });
    }
    case "orgFolder":
      return target.orgName;
    case "folder":
      return target.count > 0 ? String(target.count) : "";
    default:
      return "";
  }
}

function PaletteRow({
  icon,
  label,
  meta,
  active,
  onSelect,
  onMouseEnter,
  rowRef,
}: Readonly<{
  icon: ReactNode;
  label: string;
  meta: string;
  active: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
  rowRef?: Ref<HTMLButtonElement>;
}>) {
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta && (
        <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground/70">
          {meta}
        </span>
      )}
    </button>
  );
}

function Hint({ keys, label }: Readonly<{ keys: string; label: string }>) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border bg-muted px-1 py-px font-sans text-[10px] leading-none">
        {keys}
      </kbd>
      {label}
    </span>
  );
}
