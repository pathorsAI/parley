import { useCallback, useEffect, useRef, useState } from "react";
import { useBumpReplaySeek, useReplayPlayheadMs, useSetReplayPlayhead } from "./spine";
import { log } from "../../lib/log";

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
 */
export function useReplayPlayer(durationMs: number, offsetMs = 0): ReplayPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playheadMs = useReplayPlayheadMs();
  const setPlayhead = useSetReplayPlayhead();
  const bumpSeek = useBumpReplaySeek();

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
    if (a.paused) {
      // Parked at the window end → restart from the window start on play.
      if (durationMs > 0 && playheadMs >= durationMs - 50) {
        a.currentTime = offsetMs / 1000;
        setPlayhead(0);
      }
      a.play().catch((error) => log.warn("replay: audio play failed", { error: String(error) }));
    } else {
      a.pause();
    }
  }, [durationMs, playheadMs, offsetMs, setPlayhead]);

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

  const onPlay = useCallback(() => setPlaying(true), []);
  const onPause = useCallback(() => setPlaying(false), []);
  const onEnded = useCallback(() => setPlaying(false), []);

  // Align the audio element to the trim offset once metadata is available (a
  // freshly loaded file starts at 0, which for a trimmed session is the cut-away
  // intro). Then mirror the 0-based playhead onto it.
  const onLoadedMetadata = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = (playheadMs + offsetMs) / 1000;
  }, [playheadMs, offsetMs]);

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
  };
}
