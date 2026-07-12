import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { MeetingContextField } from "./MeetingContextField";

/**
 * THE dialog for editing the per-meeting context, shared by every surface that
 * offers it (the live screen's context button, the analysis chip's
 * regenerate-all confirm). `children` renders above the field (a hint line,
 * the accounts link section); `footer` renders the action buttons.
 *
 * Rendered through a PORTAL: `position: fixed` resolves against the nearest
 * ancestor with a `backdrop-filter`/`transform` (the titlebar has
 * `backdrop-blur`), so an inline overlay opened from there would be trapped
 * inside a 52px strip instead of covering the viewport.
 */
export function MeetingContextDialog({
  onClose,
  closeLabel,
  children,
  footer,
}: Readonly<{
  onClose: () => void;
  /** Accessible label for the backdrop click-to-close target. */
  closeLabel: string;
  children?: ReactNode;
  footer: ReactNode;
}>) {
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <button
        type="button"
        aria-label={closeLabel}
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-xl border bg-background p-4 shadow-xl">
        {children}
        <MeetingContextField rows={4} autoFocus />
        <div className="mt-4 flex justify-end gap-2">{footer}</div>
      </div>
    </div>,
    document.body
  );
}
