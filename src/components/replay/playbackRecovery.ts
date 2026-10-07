import { log } from "../../lib/log";

/**
 * What happens when the replay `<audio>` element cannot play the recording.
 *
 * Replay hands the webview `audio.ogg` through the asset protocol and lets it
 * decode the Ogg/Opus itself. When that fails — an older WebKit without
 * Ogg/Opus, a container the webview doesn't know, a damaged file — the element
 * raises a media error that nothing listened to, so the play button just did
 * nothing. Now the FIRST decode/format error asks Rust for the same recording
 * decoded to a plain PCM WAV (`prepare_playback_fallback`, which every webview
 * plays) and the player swaps to it; if that fails too, or the error is of
 * another kind, the player says the audio can't be played and why.
 *
 * Kept free of React so the flow is testable without a DOM: the hook
 * (useReplayPlayer) owns one recovery per audio source and feeds it the
 * element's errors.
 */

/** A media failure as the player bar shows it. */
export interface PlaybackError {
  /** `MediaError.code` (1 aborted, 2 network, 3 decode, 4 source not supported), null when unknown. */
  code: number | null;
  message: string;
}

export type PlaybackState =
  | { kind: "ok" }
  /** Decoding the fallback WAV in Rust. */
  | { kind: "repairing" }
  /** Nothing playable: the error the user sees. */
  | { kind: "failed"; error: PlaybackError };

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/** Decode (3) and unsupported-source (4) errors are what a decoded WAV fixes;
 *  an aborted load or a network error is not about the format. */
export function isDecodeFailure(code: number | null): boolean {
  return code === 3 || code === 4;
}

/** A `MediaError` (or anything shaped like one) as a {@link PlaybackError}. */
export function describeMediaError(err: { code?: number | null; message?: string } | null): PlaybackError {
  const code = typeof err?.code === "number" ? err.code : null;
  const name = code === null ? "unknown media error" : MEDIA_ERROR_NAMES[code] ?? `media error ${code}`;
  const detail = err?.message?.trim();
  return { code, message: detail ? `${name}: ${detail}` : name };
}

/** Ask Rust for the recording decoded to WAV; resolves with the URL to play. */
export async function prepareFallbackSrc(audioPath: string): Promise<string> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const wavPath = await invoke<string>("prepare_playback_fallback", { audioPath });
  return convertFileSrc(wavPath);
}

export interface PlaybackRecovery {
  /**
   * Handle an `<audio>` error. Resolves with the src to switch to (the decoded
   * fallback) or null when there is nothing left to try — the state then says
   * why. Only the first decode/format error triggers the fallback: an error
   * from the fallback itself is final.
   */
  handleError(error: PlaybackError): Promise<string | null>;
}

export function createPlaybackRecovery(opts: {
  /** The recording on disk (empty: none — nothing to decode). */
  audioPath: string;
  /** What the element was given, for the log. */
  audioSrc: string;
  onState: (state: PlaybackState) => void;
  /** Injected in tests; defaults to the Tauri command. */
  prepare?: (audioPath: string) => Promise<string>;
}): PlaybackRecovery {
  const { audioPath, audioSrc, onState, prepare = prepareFallbackSrc } = opts;
  let tried = false;

  return {
    async handleError(error) {
      log.error("replay: audio element error", {
        code: error.code,
        error: error.message,
        audioSrc,
        fallback: tried,
      });
      if (tried || !audioPath || !isDecodeFailure(error.code)) {
        onState({ kind: "failed", error });
        return null;
      }
      tried = true;
      onState({ kind: "repairing" });
      try {
        const src = await prepare(audioPath);
        log.info("replay: switched to the decoded WAV fallback", { audioPath });
        onState({ kind: "ok" });
        return src;
      } catch (e) {
        log.error("replay: playback fallback failed", { audioPath, error: String(e) });
        onState({ kind: "failed", error: { code: error.code, message: `${error.message} — ${String(e)}` } });
        return null;
      }
    },
  };
}
