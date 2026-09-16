import { useEffect, useRef } from "react";
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Are you sure?" for something destructive, asked INSIDE the app window.
 *
 * It exists to replace the native `confirm()`, which was not just ugly but
 * wrong: under WebView2 that dialog is a separate top-level window, so opening
 * and closing it makes the app window fire blur then focus — and anything that
 * reloads on focus (useLibraryTree does) then races the very mutation the user
 * just authorized. macOS hid the problem, because WKWebView draws the same
 * call as a window-modal sheet that never cycles focus, which is why "deleting
 * a folder does nothing" only ever reproduced on Windows.
 *
 * Every string arrives as a prop and no i18n key is named here, so this stays
 * usable for the next destructive question without growing a vocabulary.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Readonly<{
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Land on CANCEL, never on the destructive button. This dialog can appear
  // under a cursor that is already mid-click, or under a held Return, and an
  // accidental activation must not be able to mean "yes, delete it".
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape is bound on the document rather than on the scrim: focus starts on
  // the cancel button and the user can tab it around the panel, so a handler
  // hanging off any one element would answer for only part of the dialog.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    // z-[100]: raised from inside a Sheet (z-[91]) and from the import modals
    // (z-[70]) — the same ceiling MoveDialog has to clear.
    <div className="fixed inset-0 z-[100] grid place-items-center p-6">
      {/* The scrim is a SIBLING of the panel, not its parent: a real <button>
          cannot wrap the panel's own buttons, and this way a click on the panel
          never has to be stopped from reaching the scrim. */}
      <button
        type="button"
        aria-label={cancelLabel}
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-sm rounded-lg border bg-popover p-4 shadow-lg">
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          <TriangleAlert className="size-4 text-destructive" />
          {title}
        </div>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{body}</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel}>
            <X className="mr-1 size-3.5" />
            {cancelLabel}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
