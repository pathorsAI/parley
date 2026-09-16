import { isMac } from "../platform";
import { formatKey } from "../commands/format";
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
 * The two-platform spelling below came from #352, which is also why this is
 * worth having in one place: "⌃ ⇧ D" and "Ctrl + Shift + D" are the same
 * trigger, and the decision between them should be made once.
 *
 * Deliberately not lib/commands/format.ts, which formats a {@link Chord} from
 * the command table. This formats a stored SETTING — a string id like
 * "combo:super+shift+KeyD" or "right-option", written by the recorder in
 * W3C `KeyboardEvent.code` tokens, not by the table. Same output shape, two
 * unrelated inputs.
 *
 * What the two DO share is how a non-modifier key is spelled, and that part now
 * comes from format.ts ({@link formatKey}). It used to be copied here, and the
 * copy was the mac-only one: "Enter" printed as ↩ for everybody, so a Windows
 * user reading their own trigger was shown a key their keyboard does not have.
 * One table, two callers — the decoding of `code` tokens below is the only
 * thing that is genuinely ours.
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

/** Modifier caps, spelled the way each OS spells them. ⌘/⌥/⌃/⇧ are glyphs a
 *  Windows user has never seen on a keyboard, so a combo shown that way reads
 *  as a shortcut for some other machine. */
const MOD_SYMBOL_MAC: Record<string, string> = {
  super: "⌘",
  control: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const MOD_SYMBOL_WIN: Record<string, string> = {
  super: "Win",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/**
 * The character a punctuation `code` stands for. Only the codes whose name says
 * nothing about the key are here: "Semicolon" is the physical key, ";" is what
 * is printed on it. (US layout, like every `code` token — a token IS a position
 * on a US keyboard, so this mapping is the one the spec already implies.)
 */
const CODE_CHARS: Record<string, string> = {
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
};

/**
 * Human label for a W3C KeyboardEvent.code token.
 *
 * The named keys — Enter, Tab, the arrows, the navigation block — are handed to
 * {@link formatKey}, whose token names happen to coincide with the
 * `KeyboardEvent.key` names it was written for, and which is where the
 * mac-glyph-or-Windows-word decision now lives for the whole app. Anything it
 * doesn't know keeps its token ("F13", "IntlBackslash"), which is at least an
 * honest description of the key.
 *
 * `mac` is a parameter for the same reason {@link shortcutCaps}'s is: both
 * spellings have to be exercisable without stubbing the OS.
 */
export function keyLabel(code: string, mac: boolean = isMac()): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return CODE_CHARS[code] ?? formatKey(code, mac);
}

/**
 * Render the stored shortcut id as key caps in the host OS's own notation:
 * "⌃ ⇧ D" on macOS, "Ctrl + Shift + D" on Windows. Shown in Settings, in
 * onboarding, and in the voice-typing history's empty state, so it is the one
 * place that decides how a trigger is spelled to the user.
 *
 * `mac` is a parameter so both spellings stay exercisable without stubbing the
 * OS; every caller passes the real platform.
 */
export function shortcutCaps(
  shortcut: string,
  t: (k: TranslationKey) => string,
  mac: boolean = isMac(),
): string {
  const symbols = mac ? MOD_SYMBOL_MAC : MOD_SYMBOL_WIN;
  const sep = mac ? " " : " + ";
  if (shortcut === "alt-space") return mac ? "⌥ Space" : "Alt + Space";
  // The HID-tap modifier triggers only exist on macOS, so their labels are only
  // ever reachable there — a Windows store that still holds one (nothing can
  // set it now) falls through to the raw id rather than promising a glyph.
  if (isModifierId(shortcut)) return mac ? t(MODIFIER_LABEL_KEYS[shortcut]) : shortcut;
  if (shortcut.startsWith("combo:")) {
    return shortcut
      .slice("combo:".length)
      .split("+")
      .map((part) => symbols[part] ?? keyLabel(part, mac))
      .join(sep);
  }
  return shortcut;
}
