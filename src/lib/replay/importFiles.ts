// File I/O + zh-conversion glue over the pure transcript parser — shared by
// the import dialog (TranscriptImportDialog) and the MCP `import_transcript`
// RPC (sessionCommands), so both entrances produce identical entries.

import { invoke } from "@tauri-apps/api/core";
import {
  dateFromFileName,
  parseTranscript,
  titleFromFileName,
  type ParsedTranscript,
} from "./importTranscript";
import { toTraditional } from "../zhConvert";
import { log } from "../log";

/** Shape returned by the Rust `read_transcript_file` command. */
interface TranscriptFile {
  text: string;
  modifiedMs: number | null;
}

export interface PreparedTranscriptFile {
  path: string;
  fileName: string;
  /** Default entry title (derived from the file name; the dialog lets the user edit it). */
  title: string;
  /** Default createdAt: a YYYY-MM-DD in the file name beats mtime (cloud-drive
   *  syncs rewrite mtime), which beats "now". */
  createdAt: number;
  parsed: ParsedTranscript | null;
  /** Why the file can't import ("empty" = parsed but no spoken content). */
  error: string | null;
}

/** Read + parse one transcript file into an importable row (never throws). */
export async function prepareTranscriptFile(path: string): Promise<PreparedTranscriptFile> {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const base = {
    path,
    fileName,
    title: titleFromFileName(path),
    createdAt: Date.now(),
    parsed: null,
    error: null,
  };
  try {
    const file = await invoke<TranscriptFile>("read_transcript_file", { path });
    const parsed = parseTranscript(file.text);
    if (!parsed) return { ...base, error: "empty" };
    // Match both ingest paths: transcripts often arrive Simplified (exports,
    // other tools) — convert so display + analysis stay zh-TW.
    const segments = await Promise.all(
      parsed.segments.map(async (s) => ({ ...s, text: await toTraditional(s.text) })),
    );
    const speakerNames: Record<string, string> = {};
    for (const [key, label] of Object.entries(parsed.speakerNames)) {
      speakerNames[key] = await toTraditional(label);
    }
    return {
      ...base,
      createdAt: dateFromFileName(path) ?? file.modifiedMs ?? Date.now(),
      parsed: { ...parsed, segments, speakerNames },
    };
  } catch (e) {
    log.warn("import: transcript read/parse failed", { path, error: String(e) });
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
