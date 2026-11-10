import { toast } from "sonner";
import * as ipc from "../ipc/commands";
import { useStore } from "../store";
import { translate } from "../../i18n";
import { isTauri } from "../platform";
import { log } from "../log";
import { sendChordToRichText } from "./richText";
import {
  editChangeVars,
  redoTranscriptEdit,
  undoTranscriptEdit,
  type TranscriptEditChange,
} from "../replay/transcriptEdit";

/**
 * ⌘Z / ⌘⇧Z (Edit › Undo / Redo). Typing in a field, they are the field's own
 * text undo; anywhere else they step Parley's own edits — today the replay
 * transcript's find & replace.
 *
 * On macOS the Edit menu claims both chords before the webview sees them, so
 * every press arrives here and a field's undo is handed back to the system
 * (`native_edit`). Elsewhere the webview binds them only outside fields, and
 * a field keeps its native undo untouched.
 */
function typingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The replay find bar's fields: right after a replace the cursor is still in
 *  one, and ⌘Z there means "undo that replace", so they try it first. */
function inFindBar(): boolean {
  return !!document.activeElement?.closest("[data-transcript-undo]");
}

/** Whether ⌘Z should go to Parley's own edits before the field's text. */
function appFirst(): boolean {
  return !typingInField() || inFindBar();
}

function nativeEdit(action: "undo" | "redo"): void {
  if (!isTauri()) return;
  ipc.nativeEdit({ action }).catch((error) => log.warn("edit: native undo failed", { action, error: String(error) }));
}

/** Say a transcript step happened: nothing on screen moves much when one
 *  word in a long transcript changes back, so the toast is the evidence. One
 *  toast, replaced by the next press rather than stacking. */
function announce(key: "replay.undone" | "replay.redone", change: TranscriptEditChange): void {
  const language = useStore.getState().settings.language;
  toast(translate(language, key, editChangeVars(language, change)), { id: "transcript-undo" });
}

export function editUndo(): void {
  const change = appFirst() ? undoTranscriptEdit() : null;
  if (change) return announce("replay.undone", change);
  // A rich-text editor keeps its own history; the system's undo would undo
  // DOM edits behind its back.
  if (sendChordToRichText({ key: "z" })) return;
  nativeEdit("undo");
}

export function editRedo(): void {
  const change = appFirst() ? redoTranscriptEdit() : null;
  if (change) return announce("replay.redone", change);
  if (sendChordToRichText({ key: "z", shift: true })) return;
  nativeEdit("redo");
}
