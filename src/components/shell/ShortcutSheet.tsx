import { Fragment } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Keyboard } from "lucide-react";
import { useActiveScopes } from "../../lib/commands/bind";
import { formatChord } from "../../lib/commands/format";
import { closeShortcutSheet, useShortcutSheetOpen } from "../../lib/commands/sheet";
import {
  COMMAND_GROUPS,
  commandsInGroup,
  type CommandDef,
  type CommandGroup,
} from "../../lib/commands/registry";
import { shortcutCaps } from "../../lib/voiceTyping/caps";
import { isMac } from "../../lib/platform";
import { useStore } from "../../lib/store";
import { useI18n, type TranslationKey } from "../../i18n";

/**
 * ⇧? — every key you can press, right here, right now.
 *
 * Read-only, which is why it is a centered Dialog rather than a Sheet: a side
 * sheet exists to keep the thing you are editing visible beside it, and there
 * is nothing to edit here. It is also why every row is generated from
 * lib/commands/registry.ts and not one line of it is hand-written — a
 * hand-listed cheat sheet is a second copy of the keymap, and the copy starts
 * lying the first day a chord moves. If a key is not in the table, it does not
 * appear here; if it moves, this moves with it.
 *
 * "Right now" is the other half. The sheet filters by {@link useActiveScopes},
 * so Settings shows only the global rows, the main window adds Navigation and
 * Meeting, and Replay's bare ← appears exactly while the workbench that binds
 * it is mounted. Listing a key that would do nothing if pressed is the same
 * failure as listing a key that does not exist.
 *
 * Radix's Dialog is used directly, as CommandPalette does — the project has no
 * ui/dialog.tsx wrapper, and this needs none of what one would add.
 */

const GROUP_LABEL_KEYS: Record<CommandGroup, TranslationKey> = {
  global: "shortcuts.group.global",
  nav: "shortcuts.group.nav",
  meeting: "shortcuts.group.meeting",
  replay: "shortcuts.group.replay",
  voice: "shortcuts.group.voice",
};

const OWNED_BY_LABEL_KEYS: Record<NonNullable<CommandDef["ownedBy"]>, TranslationKey> = {
  os: "shortcuts.ownedBy.os",
  "native-hotkey": "shortcuts.ownedBy.native-hotkey",
};

/** One row's key caps: an entry per chord, each entry the caps of that chord.
 *  Two entries means two ways to press the same command (nav.back is ⌘[ and
 *  ⌘←), which the row prints separated by a muted "/". */
type RowCaps = readonly (readonly string[])[];

/**
 * What to print for one command.
 *
 * Deliberately `def.keys`, NOT `bindableChords(def.id)`. That helper answers a
 * different question — which chords THIS WEBVIEW should install a listener for
 * — and so it drops two kinds of key that a user very much can still press:
 * the ones the macOS menu bar claims (⌘1 works, AppKit just gets there first)
 * and every `ownedBy` row (⌘W is Tauri's, push-to-talk is the Rust global
 * hotkey). Printing from the binder's list would hide ⌘, ⌘1 and ⌘W from the
 * sheet on macOS — the exact keys people look one up to find.
 */
function capsOf(def: CommandDef, mac: boolean, voiceCaps: string): RowCaps {
  // The push-to-talk chord is a user setting, so the table carries the row with
  // empty `keys` and the value is resolved here. It stays ONE cap rather than
  // being split on spaces: the modifier labels are translated strings that
  // contain a space themselves ("右 ⌥"), and chopping them would print nonsense.
  if (def.dynamicKeys === "voiceTyping") return [[voiceCaps]];
  // Alias chords are dropped: they are the same key spelled a second way (see
  // Chord.alias), so printing both would ask the reader to spot a difference
  // that isn't there. Two entries survive only where the keys really differ —
  // nav.back's ⌘[ and ⌘←.
  return def.keys.filter((chord) => !chord.alias).map((chord) => formatChord(chord, mac));
}

export function ShortcutSheet() {
  const { t } = useI18n();
  const open = useShortcutSheetOpen();
  const scopes = useActiveScopes();
  const voiceShortcut = useStore((s) => s.settings.voiceTypingShortcut);
  const voiceEnabled = useStore((s) => s.settings.voiceTypingEnabled);

  // Nothing rendered while closed — the Settings and Field Log windows mount
  // this too, and a cheat sheet nobody asked for should cost them no DOM.
  if (!open) return null;

  const mac = isMac();
  const voiceCaps = shortcutCaps(voiceShortcut, t);

  const groups = COMMAND_GROUPS.map((group) => ({
    group,
    rows: commandsInGroup(group)
      // A scope that is not mounted has no live keys, so it has no rows.
      .filter((def) => scopes.includes(def.scope))
      // Push-to-talk is off: the row would document a key that does nothing.
      .filter((def) => def.dynamicKeys !== "voiceTyping" || voiceEnabled)
      .map((def) => ({ def, caps: capsOf(def, mac, voiceCaps) })),
    // An empty group prints no heading rather than an empty heading.
  })).filter((g) => g.rows.length > 0);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) closeShortcutSheet();
      }}
    >
      <DialogPrimitive.Portal>
        {/* Above the palette (z-94/95) and the confirm dialogs (92/93): ⇧? is
            the one surface that has to be reachable over whatever is up. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-[96] bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-slot="shortcut-sheet"
          className="fixed left-1/2 top-1/2 z-[97] flex max-h-[80vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex shrink-0 items-start gap-2.5 border-b px-4 py-3">
            <Keyboard className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold">
                {t("shortcuts.title")}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">
                {t("shortcuts.hint.close")}
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {groups.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("shortcuts.empty")}
              </p>
            ) : (
              // CSS columns rather than a grid: a group must not be split down
              // the middle, and `break-inside-avoid` says exactly that while
              // still letting the browser balance whatever groups are present.
              <div className="columns-1 gap-x-8 sm:columns-2">
                {groups.map(({ group, rows }) => (
                  <section key={group} className="mb-5 break-inside-avoid">
                    <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t(GROUP_LABEL_KEYS[group])}
                    </h3>
                    {rows.map(({ def, caps }) => (
                      <ShortcutRow
                        key={def.id}
                        label={t(def.labelKey)}
                        tag={def.ownedBy ? t(OWNED_BY_LABEL_KEYS[def.ownedBy]) : ""}
                        caps={caps}
                      />
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ShortcutRow({
  label,
  tag,
  caps,
}: Readonly<{ label: string; tag: string; caps: RowCaps }>) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0 truncate text-[13px] text-foreground">
        {label}
        {/* The owner tag says WHY the key still works somewhere Parley isn't
            listening — it is the point of those rows, not a footnote. */}
        {tag && <span className="ml-1.5 text-[10px] text-muted-foreground">{tag}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {caps.map((chord, i) => (
          <Fragment key={chord.join("+")}>
            {i > 0 && <span className="px-0.5 text-[10px] text-muted-foreground/60">/</span>}
            {chord.map((cap, j) => (
              <Kbd key={`${j}-${cap}`}>{cap}</Kbd>
            ))}
          </Fragment>
        ))}
      </span>
    </div>
  );
}

/** One keycap. Sized off the palette's hint keys so a ⌘ means the same shape
 *  wherever the app draws one. */
function Kbd({ children }: Readonly<{ children: string }>) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border bg-muted px-1.5 font-sans text-[11px] leading-none text-foreground">
      {children}
    </kbd>
  );
}
