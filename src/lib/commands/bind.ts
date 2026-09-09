import { useEffect, useRef, useSyncExternalStore } from "react";
import { bindShortcut, useShortcut, type ShortcutOptions } from "../shortcuts";
import { isMac } from "../platform";
import { log } from "../log";
import { openSettings } from "../nav/settings";
import { navigateTo } from "../nav/navigate";
import { isMeetingActive, useStore } from "../store";
import { toggleSidebar } from "../shell/sidebar";
import { zoomIn, zoomOut, zoomReset } from "../zoom";
import { toggleShortcutSheet } from "./sheet";
import {
  command,
  commandsInScope,
  findConflicts,
  type Chord,
  type CommandId,
  type CommandScope,
} from "./registry";

/**
 * Turning the command table into live keys.
 *
 * Two ways in, because commands split cleanly into two kinds:
 *
 *   • Ones whose behaviour is reachable from module scope — open Settings, go
 *     home, zoom. Those carry a handler in {@link HANDLERS} and are bound
 *     automatically for their scope.
 *   • Ones that need a component's own state — the palette's open flag, the
 *     titlebar's re-entrancy guard, the replay player's <audio> element. Those
 *     have no handler here; the owner binds them with
 *     {@link useCommandShortcut}, which still reads the KEYS from the table.
 *
 * The split is about who holds the state, never about where the chord is
 * written down. There is exactly one place for that, and it is registry.ts.
 */

/**
 * macOS matches an NSMenu key equivalent before the event reaches the webview,
 * so a chord the menu bar claims must not be bound here as well.
 */
function claimedByMenuBar(chord: Chord): boolean {
  return !!chord.native && isMac();
}

/** The chords this window should actually listen for. */
export function bindableChords(id: CommandId): Chord[] {
  const def = command(id);
  if (def.ownedBy) return [];
  return def.keys.filter((chord) => !claimedByMenuBar(chord));
}

const HANDLERS: Partial<Record<CommandId, () => void>> = {
  "settings.open": () => openSettings(),
  "shortcuts.show": () => toggleShortcutSheet(),
  "zoom.in": () => zoomIn(),
  "zoom.out": () => zoomOut(),
  "zoom.reset": () => zoomReset(),

  // Routed through navigateTo, not straight at the store, so ⌘1/⌘2 land in the
  // back stack (⌘1 then ⌘[ has to work) and inherit the one meeting guard
  // instead of re-deciding it here.
  "nav.home": () => {
    void navigateTo({ kind: "home" });
  },
  "nav.library": () => {
    const s = useStore.getState();
    void navigateTo({ kind: "library", selection: s.librarySelection });
  },
  // The odd one out: the recording is ALREADY loaded, so this is a tab switch,
  // not a trip. Going through navigateTo would re-read it off disk to arrive
  // where we already are, and the entry is in the stack from when it opened.
  "nav.study": () => {
    const s = useStore.getState();
    if (!s.replay || isMeetingActive(s.meetingStatus)) return;
    s.showReplay();
  },
  "view.toggleSidebar": () => toggleSidebar(),
};

/**
 * The handler a mounted component is currently offering for a command, for the
 * commands that have no entry in {@link HANDLERS} — ⌘K's palette, ⌘R's meeting,
 * ⌘[ / ⌘] and the back stack. Written by {@link useCommandShortcut}, read only
 * by {@link runCommand}.
 *
 * It exists so the macOS menu bar can invoke *the same function the key
 * invokes*. Without it, "Meeting → Start Meeting" would need its own path into
 * the titlebar's state, and Parley would have two answers to what ⌘R does.
 * Entries are cleared on unmount, which gives the right behaviour for free: a
 * menu item whose owner is not on screen is simply a no-op, exactly as the
 * chord is.
 */
const COMPONENT_HANDLERS = new Map<CommandId, (e: KeyboardEvent) => void>();

/**
 * Run a command by id, from somewhere that is not a keystroke — today the macOS
 * menu bar (see lib/commands/menuBridge.ts and src-tauri/src/menu.rs).
 *
 * Deliberately not a third dispatch table: it looks in the same two places
 * binding does, in the same order.
 */
export function runCommand(id: CommandId): void {
  const own = HANDLERS[id];
  if (own) {
    own();
    return;
  }
  const owned = COMPONENT_HANDLERS.get(id);
  if (!owned) {
    // Not an error: the component that owns this command isn't mounted (⌘R with
    // the main window's shell not up, say). The key would do nothing here too.
    log.debug("commands: nothing to run", { id });
    return;
  }
  // Component handlers are written against a KeyboardEvent because that is how
  // they are normally called; a menu click has none, so hand them a synthetic
  // one rather than making every owner accept `undefined`.
  owned(new KeyboardEvent("keydown"));
}

/** Bind every command in `scope` that carries a module-level handler. Returns
 *  the remover for all of them. */
function bindScope(scope: CommandScope): () => void {
  const removers: (() => void)[] = [];
  for (const def of commandsInScope(scope)) {
    const run = HANDLERS[def.id];
    if (!run) continue;
    for (const chord of bindableChords(def.id)) {
      removers.push(bindShortcut(chord, run, { whileTyping: def.whileTyping }));
    }
  }
  return () => {
    for (const remove of removers) remove();
  };
}

/**
 * Install the window-wide commands. Called from main.tsx before React mounts,
 * once per window — including Settings and the Field Log, which render no shell
 * and would otherwise be deaf to every shortcut the app has.
 */
export function installGlobalCommands(): void {
  reportConflicts();
  activeScopes.set("global", 1);
  refreshScopes();
  bindScope("global");
}

/**
 * Which scopes are mounted right now.
 *
 * This is what lets the cheat sheet answer "what can I press HERE" without
 * being told: a scope is live exactly while something is holding it open, which
 * is the same fact {@link useCommandScope} already establishes by mounting. The
 * sheet reads it instead of keeping its own idea of the current screen — one
 * more copy of the truth avoided.
 */
const activeScopes = new Map<CommandScope, number>();
const scopeListeners = new Set<() => void>();
/** Rebuilt on change, never mutated: useSyncExternalStore compares snapshots by
 *  identity and would never re-render off a mutated Set. */
let scopeSnapshot: readonly CommandScope[] = ["global"];

function refreshScopes(): void {
  scopeSnapshot = [...activeScopes.keys()];
  for (const l of scopeListeners) l();
}

function enterScope(scope: CommandScope): () => void {
  activeScopes.set(scope, (activeScopes.get(scope) ?? 0) + 1);
  refreshScopes();
  return () => {
    const next = (activeScopes.get(scope) ?? 1) - 1;
    if (next > 0) activeScopes.set(scope, next);
    else activeScopes.delete(scope);
    refreshScopes();
  };
}

export function useActiveScopes(): readonly CommandScope[] {
  return useSyncExternalStore(
    (listener) => {
      scopeListeners.add(listener);
      return () => scopeListeners.delete(listener);
    },
    () => scopeSnapshot,
    () => scopeSnapshot
  );
}

/** Bind a scope for as long as the component is mounted — this is what makes
 *  `scope` real: replay's bare ← is live only while the workbench is up. */
export function useCommandScope(scope: CommandScope): void {
  useEffect(() => {
    const unbind = bindScope(scope);
    const leave = enterScope(scope);
    return () => {
      leave();
      unbind();
    };
  }, [scope]);
}

/**
 * Bind one command to a handler the calling component owns.
 *
 * The handler is read through a ref so a component that re-renders on every
 * keystroke doesn't re-register (and momentarily un-register) its shortcut —
 * the same reason `useShortcut` does it.
 */
export function useCommandShortcut(
  id: CommandId,
  handler: (e: KeyboardEvent) => void,
  opts: Pick<ShortcutOptions, "enabled"> = {}
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  const def = command(id);
  const chords = bindableChords(id);
  const { enabled = true } = opts;

  useEffect(() => {
    if (!enabled) return;
    const run = (e: KeyboardEvent) => handlerRef.current(e);
    const removers = chords.map((chord) =>
      bindShortcut(chord, run, { whileTyping: def.whileTyping })
    );
    // Published even when `chords` is empty — on macOS that is the normal case
    // for a menu-claimed chord like ⌘K, and it is precisely then that the menu
    // bar is the only way in.
    COMPONENT_HANDLERS.set(id, run);
    return () => {
      for (const remove of removers) remove();
      // Only retract our own entry. If something else has since claimed the id,
      // deleting unconditionally would leave the live owner unreachable from
      // the menu bar while its key still worked.
      if (COMPONENT_HANDLERS.get(id) === run) COMPONENT_HANDLERS.delete(id);
    };
    // `chords` is rebuilt every render from a frozen table, so it is a new array
    // with identical contents each time — depend on the id, which is what
    // actually decides the bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);
}

/**
 * Shout about a chord claimed twice. Cheap, and it is the thing a single table
 * buys that a hand-maintained cheat sheet never could: the collision surfaces
 * the moment the app boots in dev, not the day a user reports that ⌘B does two
 * things.
 */
function reportConflicts(): void {
  if (!import.meta.env.DEV) return;
  for (const conflict of findConflicts()) {
    log.error("shortcuts: chord claimed twice", {
      chord: conflict.chord,
      commands: conflict.ids.join(", "),
    });
  }
}

/** Re-exported so a component can bind a chord the table owns without also
 *  importing the low-level registry. */
export { useShortcut };
