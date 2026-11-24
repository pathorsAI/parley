import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";
import { STT_BY_ID } from "../../lib/transcription/providers";
import { decideImport, wizardGate, type ImportDecision, type SplitPlan } from "../../lib/replay/split";
import * as ipc from "../../lib/ipc/commands";
import { log } from "../../lib/log";

/**
 * What the picked file's metadata says the import wizard should do, probed
 * BEFORE any heavy work: its duration decides whether hosted transcription
 * needs it split, and an uncompressible file over the upload limit is refused
 * here instead of after the upload starts. Also holds the split upload's
 * progress, which resets with each newly picked file.
 */
export function useImportDecision(open: boolean, path: string | null) {
  // null while probing.
  const [decision, setDecision] = useState<ImportDecision | null>(null);
  const [splitConfirmed, setSplitConfirmed] = useState(false);
  const [splitProgress, setSplitProgress] = useState<{ k: number; n: number } | null>(null);
  const [splitFailed, setSplitFailed] = useState(false);

  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    setDecision(null);
    setSplitConfirmed(false);
    setSplitProgress(null);
    setSplitFailed(false);
    const { settings } = useStore.getState();
    const hosted = STT_BY_ID[settings.transcriptionProvider]?.credential === "cloudSession";
    ipc
      .probeUploadAudio({ path })
      .catch((e: unknown) => {
        log.warn("ingest: probe failed", { error: String(e) });
        return null;
      })
      .then((probe) => {
        if (!alive) return;
        const next = decideImport(probe, hosted);
        log.info("ingest: probed", { durationMs: probe?.durationMs ?? null, decision: next.kind });
        setDecision(next);
      });
    return () => {
      alive = false;
    };
  }, [open, path]);

  const plan: SplitPlan | null = decision?.kind === "split" && splitConfirmed ? decision.plan : null;
  const gate = wizardGate(decision, splitConfirmed);
  return {
    decision,
    gate,
    /** The first step shows a refusal or the split notice instead of the speaker-count picker. */
    showNotice: gate === "refuse" || gate === "splitNotice",
    /** The first step shows the usual speaker-count picker (disabled while probing). */
    showCount: gate === "ready" || gate === "probing",
    /** The split notice is up, waiting for the user to agree to the split. */
    splitAwaitingConfirm: gate === "splitNotice" && decision?.kind === "split" ? decision.plan : null,
    plan,
    confirmSplit: () => setSplitConfirmed(true),
    splitProgress,
    setSplitProgress,
    splitFailed,
    setSplitFailed,
  };
}
