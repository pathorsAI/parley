import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBumpReplaySeek, useReplayPlayheadMs, useSetReplayPlayhead } from "./spine";
import { log } from "../../lib/log";
import {
  createPlaybackRecovery,
  describeMediaError,
  type PlaybackError,
  type PlaybackRecovery,
  type PlaybackState,
} from "./playbackRecovery";

/** How often the audio's timeupdate is allowed to push into the store (~5/sec). */
const PLAYHEAD_THROTTLE_MS = 200;

export interface ReplayPlayer {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Current playhead in ms (mirrors the store, the source of truth). */
  playheadMs: number;
  playing: boolean;
  /** Whether the user is actively dragging the scrubber. */
  scrubbing: boolean;
  toggle: () => void;
  /**
   * Seek both the audio element and the store playhead to `ms`. Used by the
   * scrubber, transcript clicks, and the jump button.
   */
  seek: (ms: number) => void;
  /** Begin a scrub gesture (suppresses timeupdate fighting the drag). */
  beginScrub: () => void;
  /** End a scrub gesture. */
  endScrub: () => void;
  /** Wire onto the <audio>'s onTimeUpdate. */
  onTimeUpdate: () => void;
  /** Wire onto the <audio>'s onLoadedMetadata — aligns to the trim offset on load. */
  onLoadedMetadata: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
  /** Wire onto the <audio>'s onError. */
  onError: () => void;
  /** What to put in the <audio>'s src: the recording, or its decoded WAV
   *  fallback after the webview failed to play it. */
  src: string;
  /** Converting to the fallback right now. */
  repairing: boolean;
  /** Nothing playable, and why. Null while playback is fine. */
  error: PlaybackError | null;
}

/** The recording the player plays. Omitted by callers that render their own
 *  <audio> and don't need the fallback (the ingest wizard). */
export interface ReplayAudioSource {
  /** `convertFileSrc` URL of the file ("" when there is none on disk). */
  audioSrc: string;
  /** The file on disk, for the decode fallback ("" when there is none). */
  audioPath: string;
}

/**
 * Keeps an <audio> element and the store playhead in sync, both directions:
 * audio playback advances the store (throttled), and seeks/scrubs drive the
 * audio. The store `replayPlayheadMs` is the single source of truth for playback
 * position and which transcript line is highlighted (navigation only).
 *
 * `offsetMs` is where the 0-based playhead sits inside the underlying audio file.
 * It's 0 for an untrimmed recording; after an (instant, non-destructive) trim the
 * file is unchanged, so the offset shifts the kept window's start — the player
 * translates playhead ⇄ audio.currentTime by it and stops at the window's end.
 *
 * Playback failures are not silent: the element's errors go through a
 * PlaybackRecovery (playbackRecovery.ts), which retries ONCE with the recording
 * decoded to WAV in Rust and otherwise exposes the error for the player bar.
 * After the switch the store playhead (onLoadedMetadata) restores the position,
 * and playback resumes if the user had asked to play.
 */
export function useReplayPlayer(durationMs: number, offsetMs = 0, source?: ReplayAudioSource): ReplayPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playheadMs = useReplayPlayheadMs();
  const setPlayhead = useSetReplayPlayhead();
  const bumpSeek = useBumpReplaySeek();

  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);
  const lastPushRef = useRef(0);

  const audioSrc = source?.audioSrc ?? "";
  const audioPath = source?.audioPath ?? "";
  // One recovery per recording: a new recording starts over with its own src,
  // no error and a fresh fallback try. The fallback src and the playback state
  // are tagged with the recovery that produced them and only count while it is
  // still the current one, so a decode for A that lands after switching to B
  // can neither play A's audio on B nor show A's notice there.
  const [fallback, setFallback] = useState<{ owner: PlaybackRecovery; src: string } | null>(null);
  const [reported, setReported] = useState<{ owner: PlaybackRecovery; state: PlaybackState } | null>(null);
  const recovery = useMemo(() => {
    const r: PlaybackRecovery = createPlaybackRecovery({
      audioPath,
      audioSrc,
      onState: (state) => setReported({ owner: r, state }),
    });
    return r;
  }, [audioPath, audioSrc]);
  const src = fallback?.owner === recovery ? fallback.src : audioSrc;
  const playback: PlaybackState = reported?.owner === recovery ? reported.state : { kind: "ok" };
  // The user asked to play (and hasn't paused since): resume after a src swap.
  const wantsPlayRef = useRef(false);
  // Resume once the fallback loads — tagged like the fallback, so a press
  // meant for one recording never starts another.
  const resumeRef = useRef<PlaybackRecovery | null>(null);
  const repairingRef = useRef(false);
  useEffect(() => {
    repairingRef.current = playback.kind === "repairing";
  }, [playback]);
  // Moving to another recording: stop the previous one's recovery and forget
  // its play intent. Disposed here rather than in a cleanup, which StrictMode
  // runs on the live recovery too.
  const previousRecoveryRef = useRef(recovery);
  useEffect(() => {
    if (previousRecoveryRef.current === recovery) return;
    previousRecoveryRef.current.dispose();
    previousRecoveryRef.current = recovery;
    wantsPlayRef.current = false;
    resumeRef.current = null;
  }, [recovery]);

  const clamp = useCallback(
    (ms: number) => Math.max(0, Math.min(ms, durationMs || ms)),
    [durationMs]
  );

  const seek = useCallback(
    (ms: number) => {
      const next = clamp(ms);
      const a = audioRef.current;
      if (a) a.currentTime = (next + offsetMs) / 1000;
      setPlayhead(next);
      // Mark discrete jumps (timeline finding, transcript row, action item, jump
      // button) so the transcript scrolls to them. During a scrubber DRAG `seek`
      // fires on every pointer move — don't scroll on each; endScrub bumps once on
      // release instead.
      if (!scrubbingRef.current) bumpSeek();
    },
    [clamp, setPlayhead, offsetMs, bumpSeek]
  );

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    // The fallback is still decoding: remember the press, play when it lands.
    if (repairingRef.current) {
      resumeRef.current = resumeRef.current ? null : recovery;
      return;
    }
    if (a.paused) {
      // Parked at the window end → restart from the window start on play.
      if (durationMs > 0 && playheadMs >= durationMs - 50) {
        a.currentTime = offsetMs / 1000;
        setPlayhead(0);
      }
      wantsPlayRef.current = true;
      a.play().catch((error) =>
        log.error("replay: audio play failed", {
          error: String(error),
          mediaError: a.error?.code ?? null,
          audioSrc: a.currentSrc || a.src,
        }),
      );
    } else {
      wantsPlayRef.current = false;
      a.pause();
    }
  }, [durationMs, playheadMs, offsetMs, setPlayhead, recovery]);

  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
    setScrubbing(true);
  }, []);

  const endScrub = useCallback(() => {
    scrubbingRef.current = false;
    setScrubbing(false);
    // The drag/click is done — scroll the transcript to the released position once.
    bumpSeek();
  }, [bumpSeek]);

  const onTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (!a || scrubbingRef.current) return;
    const pos = a.currentTime * 1000 - offsetMs;
    // The file extends past the trim window — stop the playhead at the window end.
    if (durationMs > 0 && pos >= durationMs) {
      a.pause();
      a.currentTime = (durationMs + offsetMs) / 1000;
      setPlayhead(durationMs);
      return;
    }
    const now = performance.now();
    if (now - lastPushRef.current < PLAYHEAD_THROTTLE_MS) return;
    lastPushRef.current = now;
    setPlayhead(clamp(pos));
  }, [clamp, setPlayhead, offsetMs, durationMs]);

  const onPlay = useCallback(() => {
    wantsPlayRef.current = true;
    setPlaying(true);
  }, []);
  const onPause = useCallback(() => setPlaying(false), []);
  const onEnded = useCallback(() => {
    wantsPlayRef.current = false;
    setPlaying(false);
  }, []);

  const onError = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    // Captured now: by the time the fallback is ready the element has stopped.
    const resume = wantsPlayRef.current;
    recovery
      .handleError(describeMediaError(a.error))
      .then((next) => {
        // Null as well when the player moved on to another recording meanwhile.
        if (!next) return;
        if (resume) resumeRef.current = recovery;
        setFallback({ owner: recovery, src: next });
      })
      // handleError reports every failure itself and resolves null; this only
      // keeps a thrown surprise out of the unhandled-rejection channel.
      .catch((e: unknown) => log.error("replay: playback recovery threw", { error: String(e) }));
  }, [recovery]);

  // Align the audio element to the trim offset once metadata is available (a
  // freshly loaded file starts at 0, which for a trimmed session is the cut-away
  // intro). Then mirror the 0-based playhead onto it — which is also what puts a
  // swapped-in fallback back where the original left off.
  const onLoadedMetadata = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = (playheadMs + offsetMs) / 1000;
    const resume = resumeRef.current === recovery;
    resumeRef.current = null;
    if (resume) {
      a.play().catch((error) => log.error("replay: resuming on the fallback failed", { error: String(error) }));
    }
  }, [playheadMs, offsetMs, recovery]);

  // If the playhead is moved externally (e.g. a jump from elsewhere, or a trim
  // shifting the offset) while paused, keep the audio element aligned so pressing
  // play resumes correctly.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || scrubbingRef.current || playing) return;
    const audioMs = a.currentTime * 1000 - offsetMs;
    if (Math.abs(audioMs - playheadMs) > 300) {
      a.currentTime = (playheadMs + offsetMs) / 1000;
    }
  }, [playheadMs, playing, offsetMs]);

  return {
    audioRef,
    playheadMs,
    playing,
    scrubbing,
    toggle,
    seek,
    beginScrub,
    endScrub,
    onTimeUpdate,
    onLoadedMetadata,
    onPlay,
    onPause,
    onEnded,
    onError,
    src,
    repairing: playback.kind === "repairing",
    error: playback.kind === "failed" ? playback.error : null,
  };
}
