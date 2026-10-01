import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import { isMac, isWindows } from "../lib/platform";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";

interface Perms {
  microphone: string;
  // The Rust struct serializes camelCase (#[serde(rename_all = "camelCase")]).
  // unknown | granted | denied | unsupported (macOS < 14.2). Windows reports
  // granted when there is a default output device to loop back, else unknown.
  systemAudio: string;
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
  if (status === "granted") return "text-success-foreground";
  if (status === "denied") return "text-danger-foreground";
  return "text-warning-foreground";
}

/**
 * The meeting-critical permissions, with live grant status.
 *
 * Both platforms show two rows: the microphone and system audio (the other
 * party). On Windows the microphone's consent is a real setting the backend
 * reads out of the registry and can deep-link to
 * (ms-settings:privacy-microphone); system audio is WASAPI loopback, which
 * needs no consent — its row is granted whenever there is a default output
 * device to capture, and otherwise links to Sound settings.
 *
 * Feature-scoped permissions are NOT listed here — Input Monitoring is
 * requested by the voice-typing key picker and Accessibility by enabling voice
 * typing (auto-paste), each at the moment the feature needs it, and neither
 * exists on Windows. Each row's button triggers the native prompt on first
 * click and opens the right settings pane afterwards. System Audio has no
 * passive status API, so its state is last-observed and "Grant" runs a real
 * one-off capture probe.
 */
export function PermissionsPanel() {
  const { t } = useI18n();
  const [microphone, setMicrophone] = useState<Status>("pending");
  const [systemAudio, setSystemAudio] = useState<Status>("pending");
  const [systemAudioSupported, setSystemAudioSupported] = useState(true);

  function applySystemAudio(raw: string) {
    setSystemAudioSupported(raw !== "unsupported");
    if (raw === "granted") {
      setSystemAudio("granted");
    } else if (raw === "denied") {
      setSystemAudio("denied");
    } else {
      setSystemAudio("pending");
    }
  }

  async function refresh() {
    if (!isTauri()) return;
    try {
      const p = await invoke<Perms>("check_permissions");
      setMicrophone(micStatus(p.microphone));
      applySystemAudio(p.systemAudio);
    } catch (error) {
      log.warn("permissions: status check failed", { error: String(error) });
    }
  }
  useEffect(() => {
    refresh().catch((error) => log.warn("permissions: refresh failed", { error: String(error) }));
  }, []);

  // The native request prompts only show once per app launch. So the first click
  // triggers the prompt (which itself offers an "Open System Settings" button);
  // every click after that opens the relevant Privacy pane directly — otherwise
  // repeat clicks would do nothing.
  //
  // Windows has no runtime prompt to try: request_microphone() is an empty stub
  // there, so the two-step would spend the user's first click on a command that
  // changes nothing on screen. Go straight to ms-settings:privacy-microphone,
  // which is the only place the setting can actually be flipped.
  const requested = useRef<Set<string>>(new Set());
  async function grant(key: string, pane: string, request: () => Promise<void>) {
    if (!isMac() || requested.current.has(key)) {
      await invoke("open_privacy_settings", { pane }).catch((error) =>
        log.warn("permissions: open privacy settings failed", { error: String(error), pane }),
      );
    } else {
      requested.current.add(key);
      await request().catch((error) => log.warn("permissions: request failed", { error: String(error), key }));
    }
    await refresh();
  }

  if (!isTauri()) return null;

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {t(isMac() ? "settings.permissions.subtitle" : "settings.permissions.subtitle.windows")}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => {
            refresh().catch((error) =>
              log.warn("permissions: refresh failed", { error: String(error) }),
            );
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
        // "Grant" promises a prompt that macOS delivers and Windows does not:
        // there the one and only step is the Settings pane, so the button says
        // where it goes.
        actionLabel={t(isMac() ? "settings.voiceTyping.grant" : "settings.permissions.openSettings")}
        onGrant={() => grant("mic", "microphone", () => invoke("request_microphone"))}
      />
      {isWindows() && (
        <Row
          label={t("settings.permissions.systemAudio.windows")}
          desc={t("settings.permissions.systemAudioDesc.windows")}
          status={systemAudio}
          // Nothing to grant: the only thing that can be missing is an output
          // device, and that is chosen in Sound settings.
          actionLabel={t("settings.permissions.openSettings")}
          onGrant={() => grant("system-audio", "system-audio", async () => {})}
          help={systemAudio === "granted" ? undefined : t("settings.permissions.systemAudioHelp.windows")}
        />
      )}
      {isMac() && systemAudioSupported && (
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
    </div>
  );
}

function Row({
  label,
  desc,
  help,
  status,
  actionLabel,
  onGrant,
}: Readonly<{
  label: string;
  desc: string;
  help?: string;
  status: Status;
  /** Defaults to "Grant" — pass one when the click does something else. */
  actionLabel?: string;
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
        {help && <span className="mt-1 text-[11px] leading-relaxed text-warning-foreground">{help}</span>}
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
              {actionLabel ?? t("settings.voiceTyping.grant")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
