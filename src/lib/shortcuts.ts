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
 * Two existing shortcuts deliberately stay where they are:
 *   • ⌘+/⌘−/⌘0 (lib/zoom.ts) is installed from main.tsx BEFORE React mounts and
 *     runs in every window, including the ones that never render an AppShell —
 *     a React hook could not cover it.
 *   • ⌘F (components/replay/ReplayTranscript.tsx) is scoped to one mounted
 *     panel and has its own semantics (it focuses that panel's find field, and
 *     must keep working while the field itself has focus).
 */

export interface ShortcutSpec {
  /** ⌘ on macOS, Ctrl everywhere else. */
  mod?: boolean;
  shift?: boolean;
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
  if (!!e.shiftKey !== !!spec.shift) return false;
  if (!!e.altKey !== !!spec.alt) return false;
  return e.key.toLowerCase() === spec.key.toLowerCase();
}

/** The parts of an event target the typing guard reads (see {@link KeyStroke}). */
export interface FocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Is focus somewhere that owns the keyboard?
 *
 * This is the property the whole registry stands on. A global ⌘[ that fires
 * while the caret sits in the rename field navigates the window out from under
 * a half-typed name. `isContentEditable` is computed and inherited, so a node
 * nested inside an editable region answers true as well.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as FocusTarget;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The whole decision the listener makes for one binding: the right chord, and
 * not while the user is typing. Pure and exported so the guard can be proven in
 * a test instead of only in a running window.
 */
export function shortcutFires(
  e: KeyStroke & { target?: unknown },
  spec: ShortcutSpec,
  opts: Pick<ShortcutOptions, "whileTyping"> = {},
  mac: boolean = isMac()
): boolean {
  if (!opts.whileTyping && isTypingTarget(e.target)) return false;
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
  // Copy: a handler is allowed to mount or unmount another shortcut's owner.
  for (const b of [...bindings]) {
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
