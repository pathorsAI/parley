// UI state of the two ingest doors: the guided upload wizard and the
// transcript-import dialog.

import type { SliceCreator } from "./types";

export type IngestWizardStep =
  | "count"
  | "transcribing"
  | "trim"
  | "diarizing"
  | "review"
  | "template"
  | "analyzing"
  | "error";

export interface IngestSlice {
  // ── Upload ingest wizard (count → transcribe → trim → diarize → review → analyze) ──
  /** Whether the guided upload pipeline dialog is open. */
  ingestWizardOpen: boolean;
  ingestWizardStep: IngestWizardStep;
  ingestWizardError: string | null;
  /** Absolute path of the picked recording, set when the wizard opens. */
  ingestAudioPath: string | null;
  openIngestWizard: (audioPath: string) => void;
  setIngestWizardStep: (step: IngestWizardStep, error?: string | null) => void;
  closeIngestWizard: () => void;

  // ── Transcript import (issue #130 text-ingest: .txt → history entry) ────────
  /** Absolute paths queued in the transcript-import dialog; null = closed. */
  transcriptImportPaths: string[] | null;
  /** Folder pre-pick carried by an import door opened from a folder (R7): the
   *  dialog stamps it onto every saved entry. */
  transcriptImportFolderId: string | null;
  openTranscriptImport: (paths: string[], folderId?: string | null) => void;
  closeTranscriptImport: () => void;
}

export const createIngestSlice: SliceCreator<IngestSlice> = (set) => ({
  ingestWizardOpen: false,
  ingestWizardStep: "count",
  ingestWizardError: null,
  ingestAudioPath: null,
  transcriptImportPaths: null,
  transcriptImportFolderId: null,

  // Ingest wizard. While it is OPEN the study pipeline defers auto-analysis
  // (the wizard runs the first pass itself at Confirm) — the pipeline reads
  // `ingestWizardOpen` directly, so there is no separate gate to leak.
  openIngestWizard: (audioPath) =>
    set({
      ingestWizardOpen: true,
      ingestWizardStep: "count",
      ingestWizardError: null,
      ingestAudioPath: audioPath,
    }),
  setIngestWizardStep: (step, error = null) =>
    set({ ingestWizardStep: step, ingestWizardError: error }),
  closeIngestWizard: () => set({ ingestWizardOpen: false, ingestAudioPath: null }),

  openTranscriptImport: (paths, folderId = null) =>
    set({ transcriptImportPaths: paths, transcriptImportFolderId: folderId }),
  closeTranscriptImport: () =>
    set({ transcriptImportPaths: null, transcriptImportFolderId: null }),
});
