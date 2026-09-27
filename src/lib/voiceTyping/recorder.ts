import type { TranslationKey } from "../../i18n/messages";
import { isModifierAvailable, type ModifierId } from "./caps";

/**
 * The push-to-talk recorder's reading of lone modifier keys (the Settings
 * voice-typing panel). Kept out of the component so the platform rules —
 * which lone key may be held on which OS — are testable without a DOM.
 */

/** Keys that never end a recording on their own — we wait for the main key. */
export const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

/** Right-side modifiers double as hold-to-talk keys: releasing one alone while
 *  recording selects the matching hold-a-modifier option instead of a combo
 *  (on Windows only right Ctrl / right Alt — there is no ⌘ to hold). */
const RIGHT_MODIFIER_BY_CODE: Record<string, ModifierId> = {
  MetaRight: "right-command",
  AltRight: "right-option",
  ControlRight: "right-control",
};

/** Lone left-side/Shift releases are deliberately NOT selectable — they fire
 *  during every ordinary shortcut (⌘C, ⇧-typing…), so holding one would
 *  constantly collide. The recorder shows a hint pointing at the right-side
 *  chips instead. (fn never reaches the DOM at all; its chip is the only way.) */
const LEFT_MODIFIER_CODES = new Set([
  "MetaLeft",
  "AltLeft",
  "ControlLeft",
  "ShiftLeft",
  "ShiftRight",
]);

/**
 * What releasing a lone modifier in the recorder means: select that key as a
 * hold-to-talk trigger, explain why it can't be one, or nothing (a key that
 * isn't a modifier at all). A tap only becomes distinguishable from "start of
 * a combo" at keyup, which is why this is decided there.
 *
 * A right-side key the platform can hold is selected directly (same as its
 * chip). On macOS a left-side key or Shift gets a hint pointing at the
 * right-side chips; on Windows every other modifier — left-side keys, Shift,
 * the Windows key — gets one hint naming the two keys that do work.
 */
export function loneModifierRelease(
  code: string,
  mac: boolean,
): { select: ModifierId } | { hint: TranslationKey } | null {
  const rightId = RIGHT_MODIFIER_BY_CODE[code];
  if (rightId && isModifierAvailable(rightId, mac)) return { select: rightId };
  if (!MODIFIER_CODES.has(code)) return null;
  if (!mac) return { hint: "settings.voiceTyping.recorder.modifierAloneWindows" };
  return LEFT_MODIFIER_CODES.has(code) ? { hint: "settings.voiceTyping.recorder.leftModifier" } : null;
}
