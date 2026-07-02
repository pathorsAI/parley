import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import { isTauri } from "../lib/tauriEvents";
import { Button } from "@/components/ui/button";

interface Perms {
  microphone: string;
  // The Rust struct serializes camelCase (#[serde(rename_all = "camelCase")]).
  // unknown | granted | denied | unsupported (macOS < 14.2).
  systemAudio: string;
}

interface AppIdentity {
  bundleIdentifier: string;
  executablePath: string;
  runningFromAppBundle: boolean;
  likelyDevBinary: boolean;
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
 * Overview of every macOS permission Parley uses, with live grant status. This
 * panel (plus onboarding) is the ONLY place that fires permission requests —
 * the rest of the app just checks status. Each row's button triggers the native
 * prompt on first click and opens the right System Settings pane afterwards.
 *
 * Required: microphone (meetings + voice typing) and System Audio Recording
 * (the meeting's "other party" capture — a Core Audio process tap with its own
 * TCC service; there is no passive status API, so its state is last-observed
 * and "Test & grant" runs a real probe). Optional: Input Monitoring (only the
 * fn / right-modifier push-to-talk keys) and Accessibility (only auto-paste).
 */
export function PermissionsPanel() {
  const { t } = useI18n();
  const [microphone, setMicrophone] = useState<Status>("pending");
  const [systemAudio, setSystemAudio] = useState<Status>("pending");
  const [systemAudioSupported, setSystemAudioSupported] = useState(true);
  const [inputMonitoring, setInputMonitoring] = useState<Status>("pending");
  const [accessibility, setAccessibility] = useState<Status>("pending");
  const [identity, setIdentity] = useState<AppIdentity | null>(null);

  function applySystemAudio(raw: string) {
    setSystemAudioSupported(raw !== "unsupported");
    setSystemAudio(raw === "granted" ? "granted" : raw === "denied" ? "denied" : "pending");
  }

  async function refresh() {
    if (!isTauri()) return;
    try {
      const p = await invoke<Perms>("check_permissions");
      const id = await invoke<AppIdentity>("app_identity");
      setMicrophone(micStatus(p.microphone));
      applySystemAudio(p.systemAudio);
      setInputMonitoring((await invoke<boolean>("input_monitoring_status")) ? "granted" : "pending");
      setAccessibility((await invoke<boolean>("accessibility_status", { prompt: false })) ? "granted" : "pending");
      setIdentity(id);
    } catch {
      /* non-macOS */
    }
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  // The native request prompts only show once per app launch. So the first click
  // triggers the prompt (which itself offers an "Open System Settings" button);
  // every click after that opens the relevant Privacy pane directly — otherwise
  // repeat clicks would do nothing.
  const requested = useRef<Set<string>>(new Set());
  async function grant(key: string, pane: string, request: () => Promise<void>) {
    if (requested.current.has(key)) {
      await invoke("open_privacy_settings", { pane }).catch(() => {});
    } else {
      requested.current.add(key);
      await request().catch(() => {});
    }
    await refresh();
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
      {systemAudioSupported && (
        <Row
          label={t("settings.permissions.systemAudio")}
          desc={t("settings.permissions.systemAudioDesc")}
          status={systemAudio}
          onGrant={() =>
            grant("system-audio", "system-audio", async () => {
              // Real probe: creates (and tears down) a process tap. First run
              // shows the native "record system audio" consent prompt.
              applySystemAudio(await invoke<string>("probe_system_audio"));
            })
          }
          help={systemAudio === "pending" ? t("settings.permissions.systemAudioHelp") : undefined}
        />
      )}
      <Row
        label={t("settings.permissions.inputMonitoring")}
        desc={t("settings.permissions.inputMonitoringDesc")}
        status={inputMonitoring}
        onGrant={() =>
          grant("input-monitoring", "input-monitoring", async () => {
            await invoke("request_input_monitoring");
            await invoke("open_privacy_settings", { pane: "input-monitoring" });
            await invoke("ensure_fn_listener");
          })
        }
        help={
          identity?.likelyDevBinary
            ? `${t("settings.permissions.inputMonitoringDevHelp")} ${identity.executablePath}`
            : t("settings.permissions.inputMonitoringHelp")
        }
      />
      <Row
        label={t("settings.voiceTyping.accessibility")}
        desc={t("settings.permissions.accessibilityDesc")}
        status={accessibility}
        onGrant={() =>
          grant("accessibility", "accessibility", async () => {
            await invoke("accessibility_status", { prompt: true });
          })
        }
      />
    </div>
  );
}

function Row({
  label,
  desc,
  help,
  status,
  onGrant,
}: Readonly<{
  label: string;
  desc: string;
  help?: string;
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
        {help && <span className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">{help}</span>}
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
