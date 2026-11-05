import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "../../i18n";
import { hasSpokenSegment, useStore } from "../../lib/store";
import { retranscribeBlock, retranscribeLoadedRecording } from "../../lib/replay/retranscribe";
import type { IngestStage } from "../../lib/replay/ingest";

/** One re-transcription for the screen: whether it can run, and its progress. */
export interface Retranscribe {
  /** False when the loaded recording can't be re-transcribed (org copy, no audio…). */
  available: boolean;
  /** The current stage while running, null when idle. */
  stage: IngestStage | null;
  /** Start it — asks first when a transcript would be replaced. */
  request: () => void;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  run: () => Promise<void>;
}

/**
 * The replay screen's re-transcribe state, shared by the transcript-header button
 * and the empty-transcript call to action so both show the same progress.
 */
export function useRetranscribe(): Retranscribe {
  const { t } = useI18n();
  const available = useStore((s) => retranscribeBlock(s) === null);
  const hasTranscript = useStore((s) => hasSpokenSegment(s.segments));
  const [stage, setStage] = useState<IngestStage | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function run() {
    setConfirmOpen(false);
    setStage("decoding");
    try {
      await retranscribeLoadedRecording({ onProgress: (p) => setStage(p.stage) });
      toast.success(t("replay.retranscribe.done"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t("replay.retranscribe.failed", { error: message }), {
        duration: Infinity,
        action: { label: t("toast.retry"), onClick: () => void run() },
      });
    } finally {
      setStage(null);
    }
  }

  return {
    available,
    stage,
    request: () => (hasTranscript ? setConfirmOpen(true) : void run()),
    confirmOpen,
    setConfirmOpen,
    run,
  };
}

const STAGE_KEY = {
  decoding: "replay.retranscribe.stage.decoding",
  uploading: "replay.retranscribe.stage.uploading",
  transcribing: "replay.retranscribe.stage.transcribing",
} as const;

/**
 * The re-transcribe control. `compact` sits in the transcript header next to the
 * copy menu; the full size is the call to action on an empty transcript, where
 * rescuing the recording is the one thing the user came to do.
 */
export function RetranscribeButton({ state, compact = false }: Readonly<{ state: Retranscribe; compact?: boolean }>) {
  const { t } = useI18n();
  if (!state.available) return null;
  const running = state.stage !== null;
  const label = running ? t(STAGE_KEY[state.stage!]) : t("replay.retranscribe.action");
  return (
    <Button
      variant={compact ? "ghost" : "default"}
      size={compact ? "xs" : "sm"}
      disabled={running}
      onClick={state.request}
      title={compact ? t("replay.retranscribe.hint") : undefined}
      aria-busy={running}
    >
      {running ? <Loader2 className="animate-spin" /> : <RotateCcw />}
      {label}
    </Button>
  );
}

/** "This replaces the current transcript" — only shown when there is one. */
export function RetranscribeConfirm({ state }: Readonly<{ state: Retranscribe }>) {
  const { t } = useI18n();
  return (
    <AlertDialog open={state.confirmOpen} onOpenChange={state.setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogTitle>{t("replay.retranscribe.confirmTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{t("replay.retranscribe.confirmBody")}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void state.run()}>{t("replay.retranscribe.action")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
