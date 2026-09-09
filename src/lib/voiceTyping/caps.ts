import type { TranslationKey } from "../../i18n/messages";

/**
 * Spelling the push-to-talk trigger as key caps.
 *
 * Lifted out of settings/VoiceTypingSettings.tsx because three places now need
 * to SHOW the trigger — the recorder button, onboarding, and the ⇧? cheat sheet
 * — and only one of them is the settings screen. Importing it from there would
 * pull that whole panel (Tauri `invoke`, the permission flows, the recorder
 * hook) into every window that renders a sheet.
 *
 * Deliberately not lib/commands/format.ts, which formats a {@link Chord} from
 * the command table. This formats a stored SETTING — a string id like
 * "combo:super+shift+KeyD" or "right-option", written by the recorder in
 * W3C `KeyboardEvent.code` tokens, not by the table. Same output shape, two
 * unrelated inputs.
 */

/** The hold-friendly single modifier keys watched by the HID tap (need Input
 *  Monitoring). Everything else is an OS global shortcut (no permission). */
export const MODIFIER_IDS = ["fn", "right-option", "right-command", "right-control"] as const;
export type ModifierId = (typeof MODIFIER_IDS)[number];

export const MODIFIER_LABEL_KEYS: Record<ModifierId, TranslationKey> = {
  fn: "settings.voiceTyping.shortcut.fn",
  "right-option": "settings.voiceTyping.shortcut.right-option",
  "right-command": "settings.voiceTyping.shortcut.right-command",
  "right-control": "settings.voiceTyping.shortcut.right-control",
};

export const isModifierId = (s: string): s is ModifierId =>
  (MODIFIER_IDS as readonly string[]).includes(s);

const MOD_SYMBOL: Record<string, string> = {
  super: "⌘",
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
};

/** Human label for a W3C KeyboardEvent.code token. */
function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const MAP: Record<string, string> = {
    Space: "Space",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "↩",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Home: "↖",
    End: "↘",
    PageUp: "⇞",
    PageDown: "⇟",
  };
  return MAP[code] ?? code;
}

/** Render the stored shortcut id as mac-style key caps, e.g. "⌃ ⇧ D". */
export function shortcutCaps(shortcut: string, t: (k: TranslationKey) => string): string {
  if (shortcut === "alt-space") return "⌥ Space";
  if (isModifierId(shortcut)) return t(MODIFIER_LABEL_KEYS[shortcut]);
  if (shortcut.startsWith("combo:")) {
    return shortcut
      .slice("combo:".length)
      .split("+")
      .map((part) => MOD_SYMBOL[part] ?? keyLabel(part))
      .join(" ");
  }
  return shortcut;
}
