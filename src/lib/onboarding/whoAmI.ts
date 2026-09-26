/**
 * The "which one is you?" hint on the speaker roster (live SpeakerBar and the
 * replay speaker tags). The analysis can only tell "my side" from "theirs" when
 * the user's own column carries their name, so the first time speaker inputs
 * appear, one muted line asks for it. It retires on dismiss or on the first
 * rename — renaming is the point it was making.
 */
import { useCallback } from "react";
import { useStore } from "../store";
import type { Source } from "../types";
import { markHintSeen, useHint } from "./gettingStarted";

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

export function useWhoAmIHint(): {
  visible: boolean;
  dismiss: () => void;
  /** Call from the input's onChange: the first real rename retires the hint. */
  onRename: (name: string) => void;
} {
  const [visible, dismiss] = useHint("speakers.whoAmI");
  const onRename = useCallback((name: string) => {
    if (name.trim()) markHintSeen("speakers.whoAmI");
  }, []);
  return { visible, dismiss, onRename };
}
