import { useStore } from "./store";
import { toTraditional } from "./zhConvert";
import type { Source } from "./types";

/**
 * M0 development stand-in for the real Soniox pipeline. It fakes a back-and-forth
 * conversation, emitting partial segments that grow word-by-word and then settle
 * to final — exercising the same `upsertSegment` path the Rust transcript events
 * will use in M1. Replace/disable once the realtime websocket is wired up.
 */

const SCRIPT: { source: Source; speaker: number; text: string }[] = [
  { source: "me", speaker: 0, text: "Thanks for taking the time today. Could you walk me through how your team handles delivery timelines?" },
  { source: "them", speaker: 1, text: "Absolutely. We always ship on time, every single project, no exceptions — we're known for it." },
  { source: "me", speaker: 0, text: "That's great to hear. Can you share a recent example with specific dates?" },
  { source: "them", speaker: 2, text: "Well, dates vary, but trust me, our clients are always happy. Let's talk about pricing instead." },
  { source: "me", speaker: 0, text: "Sure, but I'd still like to understand the timeline guarantees in the contract." },
  { source: "them", speaker: 1, text: "The standard terms require full payment upfront and a twelve-month lock-in, that's non-negotiable." },
];

let timer: ReturnType<typeof setTimeout> | null = null;

export function startMockStream() {
  stopMockStream();
  const { meetingStartedAt } = useStore.getState();
  const base = meetingStartedAt ?? Date.now();
  let line = 0;

  function emitLine() {
    if (useStore.getState().meetingStatus !== "recording") return;
    if (line >= SCRIPT.length) return;

    const { source, speaker, text } = SCRIPT[line];
    const id = `mock-${line}`;
    const words = text.split(" ");
    const startMs = Date.now() - base;
    let wordIdx = 0;

    function emitWord() {
      if (useStore.getState().meetingStatus !== "recording") return;
      wordIdx++;
      const partial = words.slice(0, wordIdx).join(" ");
      const isFinal = wordIdx >= words.length;
      void toTraditional(partial).then((text) => {
        useStore.getState().upsertSegment({
          id,
          source,
          speaker,
          text,
          isFinal,
          startMs,
          endMs: Date.now() - base,
        });
      });
      if (!isFinal) {
        timer = setTimeout(emitWord, 90 + Math.random() * 120);
      } else {
        line++;
        timer = setTimeout(emitLine, 1200);
      }
    }
    emitWord();
  }

  timer = setTimeout(emitLine, 600);
}

export function stopMockStream() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
