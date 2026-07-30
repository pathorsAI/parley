import { lazy, Suspense } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { LiveScreen } from "../live/LiveScreen";
import { StudyScreen } from "../study/StudyScreen";
import { AppSidebar } from "./AppSidebar";
import { useLibraryTree } from "./useLibraryTree";
import { useStore, isMeetingActive, type AppMode } from "../../lib/store";

const AccountsScreen = lazy(() =>
  import("../accounts/AccountsScreen").then((m) => ({ default: m.AccountsScreen }))
);
const PreflightScreen = lazy(() =>
  import("../preflight/PreflightScreen").then((m) => ({ default: m.PreflightScreen }))
);
const LibraryScreen = lazy(() =>
  import("../library/LibraryScreen").then((m) => ({ default: m.LibraryScreen }))
);
const SettingsApp = lazy(() =>
  import("../../settings/SettingsApp").then((m) => ({ default: m.SettingsApp }))
);

/**
 * The app shell (issue #195): one persistent left tree, and the route beside it.
 *
 * The tree is hidden in exactly two states, and for the same reason both times —
 * the screen belongs to something else:
 *   - a RUNNING meeting (the live coach owns the window; the account dossier is
 *     still reachable mid-call through the titlebar sheet), and
 *   - pre-flight, which is a focused three-column commitment to one call.
 * Everything else — live idle, a loaded recording, a company, the library,
 * settings — keeps the tree on screen, so nothing is a mode you have to exit.
 */
export function AppShell() {
  const appMode = useStore((s) => s.appMode);
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));
  const tree = useLibraryTree();

  const focused = appMode === "preflight" || meetingActive;

  const saved = useDefaultLayout({
    id: "parley:shell",
    panelIds: ["tree", "route"],
    storage: window.localStorage,
  });

  if (focused) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <RouteContent mode={appMode} tree={tree} />
      </div>
    );
  }

  return (
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
  );
}

function RouteContent({
  mode,
  tree,
}: Readonly<{ mode: AppMode; tree: ReturnType<typeof useLibraryTree> }>) {
  if (mode === "replay") return <StudyScreen />;
  if (mode === "accounts") {
    return (
      <Suspense fallback={null}>
        <AccountsScreen />
      </Suspense>
    );
  }
  if (mode === "preflight") {
    return (
      <Suspense fallback={null}>
        <PreflightScreen />
      </Suspense>
    );
  }
  if (mode === "library") {
    return (
      <Suspense fallback={null}>
        <LibraryScreen tree={tree} />
      </Suspense>
    );
  }
  if (mode === "settings") {
    return (
      <Suspense fallback={null}>
        <SettingsApp embedded />
      </Suspense>
    );
  }
  return <LiveScreen />;
}
