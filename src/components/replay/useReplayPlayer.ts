import { useCallback, useEffect, useRef, useState } from "react";
import { useReplayPlayheadMs, useSetReplayPlayhead } from "./spine";

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
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
}

/**
 * Keeps an <audio> element and the store playhead in sync, both directions:
 * audio playback advances the store (throttled), and seeks/scrubs drive the
 * audio. The store `replayPlayheadMs` is the single source of truth the rest of
 * the app (eval engine, Ask) reads through `visibleSegments`.
 */
export function useReplayPlayer(durationMs: number): ReplayPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playheadMs = useReplayPlayheadMs();
  const setPlayhead = useSetReplayPlayhead();

  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);
  const lastPushRef = useRef(0);

  const clamp = useCallback(
    (ms: number) => Math.max(0, Math.min(ms, durationMs || ms)),
    [durationMs]
  );

  const seek = useCallback(
    (ms: number) => {
      const next = clamp(ms);
      const a = audioRef.current;
      if (a) a.currentTime = next / 1000;
      setPlayhead(next);
    },
    [clamp, setPlayhead]
  );

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
    setScrubbing(true);
  }, []);

  const endScrub = useCallback(() => {
    scrubbingRef.current = false;
    setScrubbing(false);
  }, []);

  const onTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (!a || scrubbingRef.current) return;
    const now = performance.now();
    if (now - lastPushRef.current < PLAYHEAD_THROTTLE_MS) return;
    lastPushRef.current = now;
    setPlayhead(clamp(a.currentTime * 1000));
  }, [clamp, setPlayhead]);

  const onPlay = useCallback(() => setPlaying(true), []);
  const onPause = useCallback(() => setPlaying(false), []);
  const onEnded = useCallback(() => setPlaying(false), []);

  // If the playhead is moved externally (e.g. a jump from elsewhere) while
  // paused, keep the audio element aligned so pressing play resumes correctly.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || scrubbingRef.current || playing) return;
    const audioMs = a.currentTime * 1000;
    if (Math.abs(audioMs - playheadMs) > 300) {
      a.currentTime = playheadMs / 1000;
    }
  }, [playheadMs, playing]);

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
    onPlay,
    onPause,
    onEnded,
  };
}
