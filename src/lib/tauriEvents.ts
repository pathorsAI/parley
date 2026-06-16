import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { toTraditional } from "./zhConvert";
import type { Source } from "./types";

/** Shape of the `transcript://segment` payload emitted by the Rust backend. */
interface TranscriptEventPayload {
  id: string;
  source: Source;
  speaker: number;
  text: string;
  is_final: boolean;
  start_ms: number;
  end_ms: number;
}

/**
 * Subscribe to backend transcript events and feed them into the store. Returns
 * an unlisten function; call it on teardown. Safe to call when not running under
 * Tauri (e.g. plain `vite` in a browser) — it just resolves to a no-op.
 */
export async function listenForTranscript(): Promise<UnlistenFn> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  return listen<TranscriptEventPayload>("transcript://segment", (event) => {
    const p = event.payload;
    void toTraditional(p.text).then((text) => {
      useStore.getState().upsertSegment({
        id: p.id,
        source: p.source,
        speaker: p.speaker,
        text,
        isFinal: p.is_final,
        startMs: p.start_ms,
        endMs: p.end_ms,
      });
    });
  });
}

/** True when running inside the Tauri shell (vs a plain browser dev session). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
