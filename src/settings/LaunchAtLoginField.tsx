import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "../i18n";
import { isMac, isTauri } from "../lib/platform";
import { log } from "../lib/log";
import { isTranslocatedError, launchAtLoginStatus, setLaunchAtLogin } from "../lib/launchAtLogin";
import { InfoTip } from "@/components/ui/info-tip";

/**
 * Settings › Basic › Launch at login: one checkbox over the OS login item.
 *
 * The checkbox shows what the OS says, never a remembered value (see
 * src/lib/launchAtLogin.ts), so it is re-read on mount and whenever this window
 * regains focus or becomes visible — the user may have just switched Parley off
 * in Task Manager › Startup apps or removed it in System Settings. While the
 * answer is unknown (still loading, or the query failed) the box is disabled
 * rather than guessing.
 *
 * Self-contained like CachesPanel: it talks to Rust directly and reports a
 * failed change with a toast, then re-reads so the box snaps back to the truth.
 */
export function LaunchAtLoginField() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Latest-wins for the re-reads: each takes a ticket and only the newest may
  // set the state. A finished change also takes one, so a focus re-read that
  // was in flight while the OS was being changed cannot land afterwards and
  // flip the box back to the old answer.
  const ticket = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++ticket.current;
    void launchAtLoginStatus().then((value) => {
      if (mine === ticket.current) setEnabled(value);
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // Drop any answer still in flight: this component is gone.
      ticket.current += 1;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const now = await setLaunchAtLogin(next);
      ticket.current += 1;
      setEnabled(now);
    } catch (error) {
      log.warn("autostart: toggle failed", { enabled: next, error: String(error) });
      toast.error(
        isTranslocatedError(error)
          ? t("settings.basic.launchAtLoginTranslocated")
          : t("settings.basic.launchAtLoginFailed", { error: String(error) }),
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!isTauri()) return null;

  // Title only; what it does lives behind the info tip, as for every other
  // setting.
  return (
    <label className="flex max-w-sm items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        checked={enabled === true}
        disabled={enabled === null || busy}
        onChange={(e) => void toggle(e.target.checked)}
      />
      {t("settings.basic.launchAtLogin")}
      <InfoTip label={t("settings.info")}>
        {t(isMac() ? "settings.basic.launchAtLoginHelp" : "settings.basic.launchAtLoginHelpWindows")}
      </InfoTip>
    </label>
  );
}
