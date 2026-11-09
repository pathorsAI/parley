// Find the user in a recording by their voice.
//
// voiceprint.rs keeps one embedding of the user's voice on this computer
// (enrolled from the onboarding mic check, refined by every 這是我 mark). On
// opening a recording whose transcript doesn't already say who the user is,
// each speaker's lines are compared against it; a speaker that is clearly
// closer than everyone else becomes the user (resolveSelf's "voice" origin).
// Too close a call makes no guess — the 評分 page then asks.

import { useEffect } from "react";
import * as ipc from "../ipc/commands";
import { isTauri } from "../platform";
import { log } from "../log";
import { useStore } from "../store";
import type { TranscriptSegment } from "../types";
import { speakerKey } from "./labels";

/** A speaker must be at least this similar to the voiceprint… */
export const MIN_SIMILARITY = 0.5;
/** …and this much more similar than the next speaker. */
export const MIN_LEAD = 0.12;
/** Less of a speaker's audio than this is too little to judge. */
const MIN_SPEECH_MS = 4000;

/** The speaker the similarities clearly point at, or null. Pure. */
export function pickVoiceSelf(matches: readonly ipc.VoiceprintMatch[]): string | null {
  const ranked = matches.filter((m) => m.speechMs >= MIN_SPEECH_MS).sort((a, b) => b.similarity - a.similarity);
  const [best, second] = ranked;
  if (!best || best.similarity < MIN_SIMILARITY) return null;
  if (second && best.similarity - second.similarity < MIN_LEAD) return null;
  return best.key;
}

/** Each speaker's spoken lines as spans on the audio file's clock. Pure. */
export function speakerSpans(
  segments: readonly TranscriptSegment[],
  offsetMs: number,
): { key: string; spans: ipc.AudioSpan[] }[] {
  const byKey = new Map<string, ipc.AudioSpan[]>();
  for (const s of segments) {
    if (!s.isFinal || !s.text.trim() || s.endMs <= s.startMs) continue;
    const key = speakerKey(s);
    const list = byKey.get(key) ?? [];
    list.push({ startMs: Math.round(s.startMs + offsetMs), endMs: Math.round(s.endMs + offsetMs) });
    byKey.set(key, list);
  }
  return [...byKey.entries()].map(([key, spans]) => ({ key, spans }));
}

// One match per recording + speaker set (the pass decodes the whole file).
const done = new Map<string, string | null>();

async function matchLoaded(): Promise<void> {
  const s = useStore.getState();
  const replay = s.replay;
  if (!isTauri() || !replay?.audioPath) return;
  // Already known without the voice: nothing to find.
  if (s.selfSpeaker || s.segments.some((seg) => seg.source === "me" && seg.isFinal && seg.text.trim())) return;
  const speakers = speakerSpans(s.segments, replay.audioOffsetMs ?? 0);
  if (speakers.length < 1) return;
  const cacheKey = `${replay.id}|${speakers.map((sp) => sp.key).sort().join(",")}`;
  if (done.has(cacheKey)) {
    s.setVoiceSelfKey(done.get(cacheKey) ?? null);
    return;
  }
  const status = await ipc.voiceprintStatus();
  if (!status) {
    log.info("voiceprint: none enrolled yet");
    return;
  }
  const matches = await ipc.voiceprintMatch({ audioPath: replay.audioPath, speakers });
  const key = pickVoiceSelf(matches);
  done.set(cacheKey, key);
  log.info("voiceprint: matched", {
    recording: replay.id,
    picked: key ?? "none",
    similarities: matches.map((m) => `${m.key}=${m.similarity.toFixed(3)}/${Math.round(m.speechMs / 1000)}s`).join(" "),
  });
  // The user may have opened another recording meanwhile.
  if (useStore.getState().replay?.id === replay.id) useStore.getState().setVoiceSelfKey(key);
}

/** Match the loaded recording's speakers against the voiceprint, once per
 *  recording and speaker set. Mount once on the study screen. */
export function useVoiceSelf(): void {
  const replayId = useStore((s) => s.replay?.id ?? null);
  const speakerSet = useStore((s) => {
    const keys = new Set<string>();
    for (const seg of s.segments) if (seg.isFinal && seg.text.trim()) keys.add(speakerKey(seg));
    return [...keys].sort().join(",");
  });
  useEffect(() => {
    if (!replayId || !speakerSet) return;
    matchLoaded().catch((e) => log.warn("voiceprint: match failed", { error: String(e) }));
  }, [replayId, speakerSet]);
}

/** Refine the voiceprint from the speaker the user just marked as themselves.
 *  Fire-and-forget; also drops cached matches, which the new print may change. */
export function refineVoiceprintFrom(key: string): void {
  const s = useStore.getState();
  const replay = s.replay;
  if (!isTauri() || !replay?.audioPath) return;
  const mine = speakerSpans(s.segments, replay.audioOffsetMs ?? 0).find((sp) => sp.key === key);
  if (!mine) return;
  done.clear();
  ipc
    .voiceprintEnroll({ audioPath: replay.audioPath, spans: mine.spans })
    .then((st) => log.info("voiceprint: refined", { speechMs: st.speechMs }))
    .catch((e) => log.warn("voiceprint: refine skipped", { error: String(e) }));
}
