import { useEffect, useRef } from "react";
import { isMac } from "./platform";

/**
 * Where a window-wide keyboard shortcut is declared — one matcher, one listener.
 *
 * Before this, every shortcut brought its own `addEventListener("keydown")` and
 * its own idea of what "⌘" means, which is how you end up with a chord that
 * fires while the user is typing a folder name into a text field. The matching
 * rule and the typing guard live here so they can be stated once and tested.
 *
 * One existing shortcut deliberately stays where it is: ⌘+/⌘−/⌘0 (lib/zoom.ts)
 * is installed from main.tsx BEFORE React mounts and runs in every window,
 * including the ones that never render an AppShell — a React hook could not
 * cover it.
 */

export interface ShortcutSpec {
  /** ⌘ on macOS, Ctrl everywhere else. */
  mod?: boolean;
  /**
   * Exact by default, so ⌘K and ⇧⌘K stay two different chords. `"any"` opts a
   * single binding out of that rule, for the case where the SHIFT state is not
   * the user's choice: `?` is an unshifted key on some layouts and a shifted
   * one on others, so ⇧? cannot be stated as a fixed shift value.
   */
  shift?: boolean | "any";
  alt?: boolean;
  /** `KeyboardEvent.key`, compared case-insensitively: "k", "[", "ArrowLeft". */
  key: string;
}

/**
 * The parts of a KeyboardEvent a match depends on. Structural on purpose: a
 * plain object satisfies it, so {@link matchShortcut} is testable without a DOM
 * (the unit suite runs in plain Node — see vitest.config.ts).
 */
export interface KeyStroke {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Does this keystroke BE the shortcut? Every modifier is exact: a spec that
 * doesn't ask for shift is not matched by a stroke that holds it, so ⌘K and
 * ⇧⌘K can mean two different things.
 *
 * `mac` is a parameter (defaulting to the real platform) so the split can be
 * exercised both ways in a test without stubbing the OS.
 */
export function matchShortcut(e: KeyStroke, spec: ShortcutSpec, mac: boolean = isMac()): boolean {
  const meta = !!e.metaKey;
  const ctrl = !!e.ctrlKey;
  // Exclusive, matching zoom.ts: on a Mac, Ctrl+⌘+K is a DIFFERENT chord from
  // ⌘K and must fall through to whoever wants it, not fire this shortcut.
  const mod = mac ? meta && !ctrl : ctrl && !meta;
  if (spec.mod) {
    if (!mod) return false;
  } else if (meta || ctrl) {
    // No `mod` asked for means none held — otherwise ⌘S would trigger a bare "s".
    return false;
  }
  if (spec.shift !== "any" && !!e.shiftKey !== !!spec.shift) return false;
  if (!!e.altKey !== !!spec.alt) return false;
  return e.key.toLowerCase() === spec.key.toLowerCase();
}

/** The parts of an event target the focus guards read (see {@link KeyStroke}). */
export interface FocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
  /** An `<input>`'s type. Absent on every other element, and on an input that
   *  never declared one — which the HTML default makes "text". */
  type?: string;
}

/**
 * `<input>` types that hold no text. Everything absent from this set — text,
 * search, email, number, password, the date family, and a missing attribute —
 * IS a text field and keeps the keyboard.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function tagOf(target: unknown): string {
  if (!target || typeof target !== "object") return "";
  const el = target as FocusTarget;
  return typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
}

function inputType(target: unknown): string {
  const el = target as FocusTarget;
  return typeof el?.type === "string" ? el.type.toLowerCase() : "";
}

/**
 * Is focus somewhere that owns the keyboard because the user is TYPING there?
 *
 * This is the property the whole registry stands on. A global ⌘[ that fires
 * while the caret sits in the rename field navigates the window out from under
 * a half-typed name. `isContentEditable` is computed and inherited, so a node
 * nested inside an editable region answers true as well.
 *
 * An `<input>` only counts when it actually takes text. A checkbox or a range
 * slider is an `<input>` and is not typing — treating one as though it were is
 * how Space stopped playing the recording the moment you clicked the scrubber.
 * The keys those controls DO own are a separate question, asked separately by
 * {@link activatesFocusedControl}, because `whileTyping: true` may opt out of
 * this guard and must never opt out of that one.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as FocusTarget;
  if (el.isContentEditable) return true;
  const tag = tagOf(target);
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NON_TEXT_INPUT_TYPES.has(inputType(target));
}

/**
 * Keys the browser hands to a focused control as "activate me", and the elements
 * that take them. Only bare strokes count — ⌘↩ on a focused button activates
 * nothing, so it is still ours to claim.
 *
 * SHIFT is deliberately not excluded: ⇧Space activates a focused button just as
 * plainly as Space does.
 */
const ACTIVATION_KEYS = new Set([" ", "spacebar", "enter"]);
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A", "SUMMARY", "OPTION"]);
/** Input types a bare Space or Enter toggles or submits. */
const ACTIVATABLE_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "reset",
  "submit",
]);
/**
 * The keys a focused range slider steps with — its own, natively and in
 * Scrubber's handler. Shift is NOT excluded: ⇧← is the slider's ten-second
 * nudge, exactly as ← is its five.
 */
const SLIDER_KEYS = new Set([
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/**
 * Is this stroke already spoken for by whatever has focus?
 *
 * The case that forced this: you click the play button with the mouse, focus
 * stays on it, and the next Space is delivered to a focused <button> — which
 * activates it — AND matched by the Space shortcut. The recording toggles twice
 * in one frame and looks like it ignored you.
 *
 * This is NOT {@link isTypingTarget}'s job. That function answers "is the user
 * typing", and a focused button is not typing; folding this in would make it
 * lie, and `whileTyping: true` would then wrongly opt back out of it. The
 * question here is a different one — "does the focused control already mean
 * something by this key" — so it is asked separately and applies to every
 * binding, opt-out or not.
 *
 * Tag-based rather than role-based on purpose: the guard has to stay decidable
 * from the structural {@link FocusTarget} the unit suite can build (no DOM — see
 * vitest.config.ts). Nothing in the app puts keyboard focus on a role="button"
 * div; the day something does, this is where it gets added.
 */
export function activatesFocusedControl(e: KeyStroke & { target?: unknown }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (!e.target || typeof e.target !== "object") return false;
  const key = e.key.toLowerCase();
  const tag = tagOf(e.target);
  const type = tag === "INPUT" ? inputType(e.target) : "";

  // A slider answers to the arrows, so the arrows are not ours while one has
  // focus. Space is NOT among them — a range input does nothing with it, which
  // is why clicking the scrubber and pressing Space must still play.
  if (type === "range") return SLIDER_KEYS.has(key);

  if (!ACTIVATION_KEYS.has(key)) return false;
  return ACTIVATABLE_TAGS.has(tag) || ACTIVATABLE_INPUT_TYPES.has(type);
}

/**
 * The whole decision the listener makes for one binding: the right chord, not
 * while the user is typing, and not a key the focused control already answers
 * to. Pure and exported so the guards can be proven in a test instead of only in
 * a running window.
 */
export function shortcutFires(
  e: KeyStroke & { target?: unknown },
  spec: ShortcutSpec,
  opts: Pick<ShortcutOptions, "whileTyping"> = {},
  mac: boolean = isMac()
): boolean {
  if (!opts.whileTyping && isTypingTarget(e.target)) return false;
  if (activatesFocusedControl(e)) return false;
  return matchShortcut(e, spec, mac);
}

export interface ShortcutOptions {
  /** Unregister without unmounting — e.g. a route that suspends its bindings. */
  enabled?: boolean;
  /** Fire even when focus is in a field. Only for shortcuts that are ABOUT the
   *  field, and never for anything that navigates or destroys. */
  whileTyping?: boolean;
  /** Defaults to true: a shortcut we claim must not also reach the webview. */
  preventDefault?: boolean;
}

interface Binding {
  spec: ShortcutSpec;
  whileTyping: boolean;
  preventDefault: boolean;
  run: (e: KeyboardEvent) => void;
}

const bindings = new Set<Binding>();
let listening = false;

function onKeyDown(e: KeyboardEvent): void {
  const mac = isMac();
  // A snapshot, not a convenience: a handler may mount or unmount another
  // shortcut's owner, and iterating the live Set would then visit a binding
  // that registered during this very dispatch. `bindings.has` below covers the
  // other direction — one that unregistered after the snapshot was taken.
  const firing = [...bindings];
  for (const b of firing) {
    if (!bindings.has(b)) continue;
    if (!shortcutFires(e, b.spec, b, mac)) continue;
    if (b.preventDefault) e.preventDefault();
    b.run(e);
  }
}

/** Add a binding to the one shared listener. Returns its remover. */
function register(binding: Binding): () => void {
  bindings.add(binding);
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("keydown", onKeyDown);
    listening = true;
  }
  return () => {
    bindings.delete(binding);
    if (bindings.size === 0 && listening && typeof document !== "undefined") {
      document.removeEventListener("keydown", onKeyDown);
      listening = false;
    }
  };
}

/**
 * Bind a shortcut outside React, for the window-wide set that is installed from
 * main.tsx before anything mounts (see lib/commands/bind.ts). Same listener,
 * same guards as {@link useShortcut} — the only difference is who decides when
 * it goes away.
 */
export function bindShortcut(
  spec: ShortcutSpec,
  handler: (e: KeyboardEvent) => void,
  opts: Omit<ShortcutOptions, "enabled"> = {}
): () => void {
  const { whileTyping = false, preventDefault = true } = opts;
  return register({ spec, whileTyping, preventDefault, run: handler });
}

/** Test seam: drop every binding so one case can't leak into the next. */
export function resetShortcutsForTest(): void {
  bindings.clear();
  if (listening && typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeyDown);
  }
  listening = false;
}

/**
 * Bind a shortcut for as long as the component is mounted.
 *
 * The handler is read through a ref, so a component that re-renders every
 * keystroke doesn't re-register (and momentarily un-register) its shortcut.
 */
export function useShortcut(
  spec: ShortcutSpec,
  handler: (e: KeyboardEvent) => void,
  opts: ShortcutOptions = {}
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  const { enabled = true, whileTyping = false, preventDefault = true } = opts;
  const { mod, shift, alt, key } = spec;
  useEffect(() => {
    if (!enabled) return;
    // Rebuilt from primitives: an inline spec object is a new identity every
    // render and would re-register forever.
    return register({
      spec: { mod, shift, alt, key },
      whileTyping,
      preventDefault,
      run: (e) => handlerRef.current(e),
    });
  }, [enabled, mod, shift, alt, key, whileTyping, preventDefault]);
}
