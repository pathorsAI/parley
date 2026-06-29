import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { Button } from "@/components/ui/button";

interface Perms {
  microphone: string;
  // The Rust struct serializes camelCase (#[serde(rename_all = "camelCase")]).
  screenRecording: boolean;
}

type Status = "granted" | "denied" | "pending";

/** Map the native microphone authorization string to our tri-state status. */
function micStatus(raw: string): Status {
  if (raw === "authorized") return "granted";
  if (raw === "denied") return "denied";
  return "pending";
}

/** Text colour for each status. */
function toneFor(status: Status): string {
  if (status === "granted") return "text-emerald-600 dark:text-emerald-400";
  if (status === "denied") return "text-red-600 dark:text-red-400";
  return "text-amber-600 dark:text-amber-400";
}

/**
 * Overview of every macOS permission Parley uses, with live grant status. Each
 * row's button triggers the native permission prompt (which itself offers an
 * "Open System Settings" button), so we never stack a prompt + a settings window.
 */
export function PermissionsPanel() {
  const { t } = useI18n();
  const shortcut = useStore((s) => s.settings.voiceTypingShortcut);
  const [microphone, setMicrophone] = useState<Status>("pending");
  const [inputMonitoring, setInputMonitoring] = useState<Status>("pending");
  const [accessibility, setAccessibility] = useState<Status>("pending");
  const [screen, setScreen] = useState<Status>("pending");

  async function refresh() {
    if (!isTauri()) return;
    try {
      const p = await invoke<Perms>("check_permissions");
      setMicrophone(micStatus(p.microphone));
      setScreen(p.screenRecording ? "granted" : "pending");
      setInputMonitoring((await invoke<boolean>("input_monitoring_status")) ? "granted" : "pending");
      setAccessibility((await invoke<boolean>("accessibility_status", { prompt: false })) ? "granted" : "pending");
    } catch {
      /* non-macOS */
    }
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const refreshNow = () => {
      refresh().catch(() => {});
    };
    globalThis.addEventListener("focus", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);
    const id = globalThis.setInterval(refreshNow, 2000);
    return () => {
      globalThis.removeEventListener("focus", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
      globalThis.clearInterval(id);
    };
  }, []);

  // The native request prompts (mic / accessibility / screen) only show once per
  // app launch. So the first click triggers the prompt (which itself offers an
  // "Open System Settings" button); every click after that opens the relevant
  // Privacy pane directly — otherwise repeat clicks would do nothing.
  const requested = useRef<Set<string>>(new Set());
  async function grant(key: string, pane: string, request: () => Promise<void>) {
    if (requested.current.has(key)) {
      await invoke("open_privacy_settings", { pane }).catch(() => {});
    } else {
      requested.current.add(key);
      await request().catch(() => {});
    }
    await refresh();
    for (const delay of [500, 1500, 3000, 6000]) {
      globalThis.setTimeout(() => {
        refresh().catch(() => {});
      }, delay);
    }
  }

  if (!isTauri()) return null;

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{t("settings.permissions.subtitle")}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => {
            refresh().catch(() => {});
          }}
        >
          <RefreshCw className="size-3" />
          {t("settings.permissions.refresh")}
        </Button>
      </div>

      <Row
        label={t("settings.permissions.microphone")}
        desc={t("settings.permissions.microphoneDesc")}
        status={microphone}
        onGrant={() => grant("mic", "microphone", () => invoke("request_microphone"))}
      />
      <Row
        label={t("settings.permissions.inputMonitoring")}
        desc={t("settings.permissions.inputMonitoringDesc")}
        status={inputMonitoring}
        onGrant={() =>
          grant("input-monitoring", "input-monitoring", async () => {
            await invoke("request_input_monitoring");
            await invoke("set_voice_typing_shortcut", { shortcut });
          })
        }
      />
      <Row
        label={t("settings.voiceTyping.accessibility")}
        desc={t("settings.permissions.accessibilityDesc")}
        status={accessibility}
        onGrant={() =>
          grant("accessibility", "accessibility", async () => {
            await invoke("accessibility_status", { prompt: true });
            await invoke("set_voice_typing_shortcut", { shortcut });
          })
        }
      />
      <Row
        label={t("settings.permissions.screen")}
        desc={t("settings.permissions.screenDesc")}
        status={screen}
        onGrant={() => grant("screen", "screen", () => invoke("request_screen_recording").then(() => {}))}
      />
    </div>
  );
}

function Row({
  label,
  desc,
  status,
  onGrant,
}: Readonly<{
  label: string;
  desc: string;
  status: Status;
  onGrant: () => void;
}>) {
  const { t } = useI18n();
  const granted = status === "granted";
  const tone = toneFor(status);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] leading-relaxed text-muted-foreground">{desc}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {granted ? (
          <span className={`text-[11px] font-medium ${tone}`}>{t("settings.voiceTyping.granted")}</span>
        ) : (
          <>
            {status === "denied" && (
              <span className={`text-[11px] font-medium ${tone}`}>{t("settings.permissions.denied")}</span>
            )}
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onGrant}>
              {t("settings.voiceTyping.grant")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
