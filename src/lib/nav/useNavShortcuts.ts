import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useShortcut } from "../shortcuts";
import { useI18n } from "../../i18n";
import { navHistory } from "./navigate";

/**
 * Browser back/forward for the main window: ⌘[ / ⌘← and ⌘] / ⌘→, plus the
 * mouse's two side buttons.
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

  useShortcut({ mod: true, key: "[" }, goBack);
  useShortcut({ mod: true, key: "ArrowLeft" }, goBack);
  useShortcut({ mod: true, key: "]" }, goForward);
  useShortcut({ mod: true, key: "ArrowRight" }, goForward);

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
