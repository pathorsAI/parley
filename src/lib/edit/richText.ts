import { isMac } from "../platform";

/**
 * Chords a rich-text editor (the meeting notes, components/live/NotesEditor)
 * answers to itself.
 *
 * On macOS the menu bar matches its accelerators before the webview sees the
 * key: ⌘B is View › Toggle Sidebar, ⌘Z / ⇧⌘Z are Edit › Undo / Redo. With the
 * caret in the notes those presses arrive as menu commands instead of
 * keystrokes, so the editor would never see them — ⌘B would toggle the main
 * window's sidebar rather than bolding the selection. The command handlers
 * hand such a chord back to the editor as the keydown it was.
 */
export interface EditorChord {
  key: string;
  shift?: boolean;
}

/** The focused rich-text editor (a ProseMirror root), or null. */
function focusedRichText(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
  return el.closest<HTMLElement>(".ProseMirror");
}

/**
 * Send ⌘`chord` (Ctrl off a Mac) to the focused rich-text editor as a
 * keydown. True when there was one to send it to — the caller then does
 * nothing else with the command.
 */
export function sendChordToRichText(chord: EditorChord): boolean {
  const el = focusedRichText();
  if (!el) return false;
  const mac = isMac();
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      // Lower case even with Shift: ProseMirror's keymap looks up
      // "Shift-Mod-z", and a synthetic event carries no keyCode to fall back on.
      key: chord.key.toLowerCase(),
      metaKey: mac,
      ctrlKey: !mac,
      shiftKey: chord.shift === true,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
