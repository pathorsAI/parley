import { useEffect } from "react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { runFindingSolution } from "../../lib/analysis/solution";
import { FindingSolutionView } from "./FindingSolutionView";
import type { TimelineEvent } from "../../lib/types";

/**
 * Store-bound drilldown for one finding, used by the in-app overlay (browser
 * fallback). Lazily fires the solution engine on first open and renders the
 * cached result via the shared presentational view. Mode-agnostic: identical in
 * LIVE and REPLAY (the engine reads the full transcript). The standalone OS
 * window does NOT use this — it renders FindingSolutionView from synced state.
 */
export function FindingSolutionCard({ finding }: Readonly<{ finding: TimelineEvent }>) {
  const entry = useStore((s) => s.findingSolutions[finding.id]);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const status = entry?.status ?? "idle";

  // Generate on first open and whenever the open finding changes.
  useEffect(() => {
    if (keyMissing) return;
    if (!entry || entry.status === "idle") void runFindingSolution(finding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding.id]);

  return (
    <FindingSolutionView
      status={status}
      solution={entry?.solution ?? null}
      error={entry?.error ?? null}
      keyMissing={keyMissing}
      onRetry={() => void runFindingSolution(finding.id)}
    />
  );
}
