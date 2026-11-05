/**
 * Who "me" is on the speaker roster (live SpeakerBar and the replay speaker
 * tags): the analysis can only tell "my side" from "theirs" when the user's own
 * column carries their name.
 */
import { useStore } from "../store";
import type { Source } from "../types";

/** The primary mic voice — the only speaker Parley knows is the user. */
export function isOwnMicSpeaker(sp: { source: Source; speaker: number }): boolean {
  return sp.source === "me" && (sp.speaker || 1) <= 1;
}

/**
 * Save a name typed into the user's own mic column as `settings.userName` when
 * none is set yet, so every later prompt knows who "me" is. Never overwrites a
 * name the user already set in Settings.
 */
export function rememberOwnName(sp: { source: Source; speaker: number }, name: string): void {
  const trimmed = name.trim();
  if (!trimmed || !isOwnMicSpeaker(sp)) return;
  const { settings, updateSettings } = useStore.getState();
  if (settings.userName?.trim()) return;
  updateSettings({ userName: trimmed });
}
