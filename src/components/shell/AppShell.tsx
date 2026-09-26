import { lazy, Suspense } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { LiveScreen } from "../live/LiveScreen";
import { StudyScreen } from "../study/StudyScreen";
import { HomeScreen } from "../home/HomeScreen";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialog } from "./ConfirmDialog";
import { useLibraryTree } from "./useLibraryTree";
import { useI18n } from "../../i18n";
import { useNavShortcuts } from "../../lib/nav/useNavShortcuts";
import { useCommandScope } from "../../lib/commands/bind";
import { useSidebarCollapsed } from "../../lib/shell/sidebar";
import { useStore, isMeetingActive, type AppMode } from "../../lib/store";

const LibraryScreen = lazy(() =>
  import("../library/LibraryScreen").then((m) => ({ default: m.LibraryScreen }))
);
/**
 * The app shell (issue #195): one persistent left tree, and the route beside it.
 *
 * The tree goes away for two unrelated reasons. A RUNNING meeting takes it,
 * because there the screen belongs to something else — the live coach owns the
 * window. ⌘B takes it because the user asked for the room back. Everything else
 * — live idle, a loaded recording, the library — keeps the tree on screen, so
 * nothing is a mode you have to exit. (Settings is not a route here: it opens as
 * its own OS window, see lib/nav/settings.ts.)
 */
export function AppShell() {
  const appMode = useStore((s) => s.appMode);
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));
  const collapsed = useSidebarCollapsed();
  const tree = useLibraryTree();

  // Above the focused branch on purpose, both of them: the main window's keys
  // must not die and revive with the tree. Pressing back/forward during a
  // running meeting is harmless — navigateTo refuses to move while the coach
  // owns the window, and a refusal leaves the stack alone — and the same holds
  // for the rest of the `main` scope, which is guarded where it acts rather than
  // by being unbound here.
  useCommandScope("main");
  useNavShortcuts();

  const focused = meetingActive;

  const saved = useDefaultLayout({
    id: "parley:shell",
    panelIds: ["tree", "route"],
    storage: globalThis.localStorage,
  });

  // No tree means no panel group at all, rather than a panel squeezed to
  // nothing: a collapsed-to-32px tree is a target you have to aim at to dismiss,
  // and leaving the group unmounted leaves the saved split (`parley:shell`)
  // exactly as the user dragged it, so re-expanding returns the width they had.
  if (focused || collapsed) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          <RouteContent mode={appMode} tree={tree} />
        </div>
        {/* ⌘K outlives a collapsed tree, and matters more there: with no rows
            left to aim at, naming the place is the only way to reach it. It
            stays absent while a meeting is focused — see below. */}
        {!focused && <CommandPalette tree={tree} />}
        {/* Not gated on `focused`, unlike ⌘K: a question already asked has to
            stay answerable, or the caller awaiting it never hears back. */}
        <FolderDeleteConfirm tree={tree} />
      </>
    );
  }

  return (
    <>
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={saved.defaultLayout}
        onLayoutChanged={saved.onLayoutChanged}
      >
        {/* Sizes carry explicit units: a bare number is read as a PIXEL size by
            this version, which pinned the tree to a 32px sliver on first run. */}
        <ResizablePanel id="tree" defaultSize="19%" minSize="180px" maxSize="30%">
          <AppSidebar tree={tree} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="route" defaultSize="81%" minSize="480px">
          <div className="flex h-full min-h-0 flex-col bg-background">
            <RouteContent mode={appMode} tree={tree} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* ⌘K (#332): the other way to reach a node — by name instead of by aim.
          Deliberately absent from a FOCUSED meeting above, where the live coach
          owns the window; a merely collapsed tree still gets it. */}
      <CommandPalette tree={tree} />
      <FolderDeleteConfirm tree={tree} />
    </>
  );
}

/**
 * The folder delete the tree is waiting on an answer to. Its own component so
 * that both shell branches spend one line on it, and so the strings are read
 * where they are used — ConfirmDialog itself knows no i18n keys.
 */
function FolderDeleteConfirm({
  tree,
}: Readonly<{ tree: ReturnType<typeof useLibraryTree> }>) {
  const { t } = useI18n();
  const pending = tree.pendingFolderDelete;
  if (!pending) return null;
  return (
    <ConfirmDialog
      // The trash button's own label doubles as the title: one name for the
      // action, whether it is read off a tooltip or off the dialog it opens.
      title={t("history.folder.delete")}
      // deleteConfirm already reads as a body: it names the folder and says
      // that the recordings inside move back to the root rather than go.
      body={t("history.folder.deleteConfirm", { name: pending.folder.name })}
      confirmLabel={t("common.delete")}
      cancelLabel={t("common.cancel")}
      onConfirm={tree.confirmFolderDelete}
      onCancel={tree.cancelFolderDelete}
    />
  );
}

function RouteContent({
  mode,
  tree,
}: Readonly<{ mode: AppMode; tree: ReturnType<typeof useLibraryTree> }>) {
  if (mode === "study") return <StudyScreen libraryCount={tree.summaries.length} />;
  if (mode === "library") {
    return (
      <Suspense fallback={null}>
        <LibraryScreen tree={tree} />
      </Suspense>
    );
  }
  // The cockpit exists only while a meeting owns the screen (R8c); idle lands
  // on Home. "live" with no active meeting can still occur transiently between
  // stop and save — the cockpit stays up so the finalizing state has a floor.
  if (mode === "live") return <LiveScreen />;
  return <HomeScreen tree={tree} />;
}
