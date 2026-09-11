import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useCommandShortcut } from "../commands/bind";
import { useI18n } from "../../i18n";
import { navHistory } from "./navigate";

/**
 * Browser back/forward for the main window, plus the mouse's two side buttons.
 *
 * The chords are `nav.back` and `nav.forward` in lib/commands/registry.ts and
 * are not restated here — a second copy is how the cheat sheet starts lying.
 * This file owns the traversal, the registry owns the keys. The side buttons
 * are ours alone: they are not a chord, so the table has nothing to say about
 * them.
 *
 * Safe to keep live while a meeting is running: every replay goes through
 * navigateTo, which refuses to move the window out from under the live coach,
 * and a refusal leaves the stack untouched.
 */

/** The extra buttons a five-button mouse sends. `MouseEvent.button` numbers
 *  them 3 and 4; there is no named constant for either. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

export function useNavShortcuts(): void {
  const { t } = useI18n();

  const traverse = useCallback(
    (direction: "back" | "forward") => {
      const run = direction === "back" ? navHistory.back : navHistory.forward;
      void run().then((result) => {
        // The user asked for one step and got more than one, because what was
        // one step away has since been deleted. Say so, rather than let the
        // window appear to overshoot.
        if (result.skipped > 0) toast.info(t("nav.skippedMissing"));
      });
    },
    [t]
  );

  const goBack = useCallback(() => traverse("back"), [traverse]);
  const goForward = useCallback(() => traverse("forward"), [traverse]);

  useCommandShortcut("nav.back", goBack);
  useCommandShortcut("nav.forward", goForward);

  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== MOUSE_BACK && e.button !== MOUSE_FORWARD) return;
      e.preventDefault();
      if (e.button === MOUSE_BACK) goBack();
      else goForward();
    };
    // mouseup, not mousedown: the side buttons also fire `auxclick`, and acting
    // on the press would navigate before the button is released under it.
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [goBack, goForward]);
}
