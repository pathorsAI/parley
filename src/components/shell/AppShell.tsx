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
import { useLibraryTree } from "./useLibraryTree";
import { useStore, isMeetingActive, type AppMode } from "../../lib/store";

const LibraryScreen = lazy(() =>
  import("../library/LibraryScreen").then((m) => ({ default: m.LibraryScreen }))
);
/**
 * The app shell (issue #195): one persistent left tree, and the route beside it.
 *
 * The tree is hidden in exactly one state, because there the screen belongs to
 * something else: a RUNNING meeting, where the live coach owns the window.
 * Everything else — live idle, a loaded recording, the library — keeps the tree
 * on screen, so nothing is a mode you have to exit. (Settings is not a route
 * here: it opens as its own OS window, see lib/nav.ts.)
 */
export function AppShell() {
  const appMode = useStore((s) => s.appMode);
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));
  const tree = useLibraryTree();

  const focused = meetingActive;

  const saved = useDefaultLayout({
    id: "parley:shell",
    panelIds: ["tree", "route"],
    storage: globalThis.localStorage,
  });

  if (focused) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <RouteContent mode={appMode} tree={tree} />
      </div>
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
          <div className="flex h-full min-h-0 flex-col">
            <RouteContent mode={appMode} tree={tree} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* ⌘K (#332): the other way to reach a node — by name instead of by aim.
          Deliberately absent from the focused branch above, where a running
          meeting owns the window. */}
      <CommandPalette tree={tree} />
    </>
  );
}

function RouteContent({
  mode,
  tree,
}: Readonly<{ mode: AppMode; tree: ReturnType<typeof useLibraryTree> }>) {
  if (mode === "study") return <StudyScreen />;
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
