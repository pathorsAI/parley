import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Mic } from "lucide-react";
import { toast } from "sonner";
import { isMeetingActive, useStore } from "../lib/store";
import * as ipc from "../lib/ipc/commands";
import type { Permissions } from "../lib/ipc/commands";
import { AUDIO_LEVEL_EVENT, listenEvent, type AudioLevelPayload } from "../lib/ipc/events";
import { isTauri } from "../lib/tauriEvents";
import { openSettings } from "../lib/nav/settings";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** How long the quick test listens before calling the mic silent. */
const TEST_WINDOW_MS = 3000;
/** Raw peak that counts as "heard something" — above room hiss, well below
 *  normal speech (the meters map peaks through sqrt, so 0.01 ≈ a 10 % bar). */
const TEST_HEARD_LEVEL = 0.01;

/**
 * The newest `audio://level` for one source, decaying to 0 when events stop.
 * `source = null` subscribes to nothing: the chip only animates off a stream
 * something else already opened (the meeting's mic, or the quick test) — it
 * never opens the mic just to wiggle.
 */
function useSourceLevel(source: string | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!source || !isTauri()) {
      setLevel(0);
      return;
    }
    // Same late-unlisten pattern as LevelMeter: cleanup can beat listen().
    let alive = true;
    let unlisten: (() => void) | undefined;
    listenEvent<AudioLevelPayload>(AUDIO_LEVEL_EVENT, (e) => {
      if (e.payload.source === source) setLevel(e.payload.level);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    const decay = setInterval(() => setLevel((l) => (l > 0.001 ? l * 0.6 : 0)), 120);
    return () => {
      alive = false;
      unlisten?.();
      clearInterval(decay);
      setLevel(0);
    };
  }, [source]);
  return level;
}

/** Three tiny bars, 3–12px. Flat and grey when nothing is listening. */
function ChipMeter({ level }: Readonly<{ level: number }>) {
  const p = Math.min(1, Math.sqrt(level));
  const active = p > 0.03;
  return (
    <span aria-hidden className="inline-flex h-3 items-end gap-0.5">
      {[0.7, 1, 0.5].map((weight) => (
        <span
          key={weight}
          className={`w-[3px] rounded-[1px] transition-[height] duration-75 ${
            active ? "bg-primary" : "bg-muted-foreground/40"
          }`}
          style={{ height: `${3 + Math.round(9 * Math.min(1, p * weight * 1.6))}px` }}
        />
      ))}
    </span>
  );
}

/** System-audio capture, judged from the permission alone: outside a meeting
 *  nothing is being captured, so "receiving" would be a guess. */
function SystemAudioStatus({ perms }: Readonly<{ perms: Permissions | null }>) {
  const { t } = useI18n();
  const pill = "shrink-0 rounded-full px-2 py-px text-[11px]";
  const label = <span className="flex-1 text-muted-foreground">{t("mic.systemAudio")}</span>;

  // Still asking the backend: show the row without a verdict.
  if (!perms) {
    return <div className="flex items-center gap-2 px-2 py-1.5 text-xs">{label}</div>;
  }
  if (perms.systemAudio === "granted") {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {label}
        <span
          className={`${pill} bg-[#d9f7e5] text-[#006a3b] dark:bg-success dark:text-success-foreground`}
        >
          {t("mic.systemAudio.granted")}
        </span>
      </div>
    );
  }
  if (perms.systemAudio === "unsupported") {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {label}
        <span className={`${pill} bg-muted text-muted-foreground`}>
          {t("mic.systemAudio.unsupported")}
        </span>
      </div>
    );
  }
  // Denied or never asked: the fix lives in Settings › Permissions.
  return (
    <DropdownMenuItem
      title={t("mic.systemAudio.openPermissions")}
      onSelect={() => openSettings("permissions")}
      className="text-xs"
    >
      {label}
      <span className={`${pill} bg-warning text-warning-foreground`}>
        {t("mic.systemAudio.denied")}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Title-bar mic chip: which input the next recording uses, a tiny level meter,
 * and a menu to switch the device, see whether the other side's audio can be
 * captured, and run a three-second "can it hear me" check.
 *
 * Device switching and the test are locked during a meeting — the mic belongs
 * to the live capture then (the same rule as Settings › 轉錄).
 */
export function MicChip() {
  const { t } = useI18n();
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const updateSettings = useStore((s) => s.updateSettings);
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));
  const paused = useStore((s) => s.meetingStatus === "paused");
  const [devices, setDevices] = useState<string[]>([]);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [testing, setTesting] = useState(false);
  const testingRef = useRef(false);

  const deviceName = inputDevice || t("settings.transcription.systemDefault");
  let levelSource: string | null = null;
  if (meetingActive && !paused) levelSource = "me";
  else if (testing) levelSource = "test";
  const level = useSourceLevel(levelSource);

  /** Enumerate on open, not on mount: listing inputs can trip the macOS
   *  microphone prompt, which must never fire just because the app launched. */
  function onOpenChange(open: boolean) {
    if (!open || !isTauri()) return;
    ipc
      .listInputDevices()
      .then(setDevices)
      .catch((error) => log.warn("mic chip: input device list failed", { error: String(error) }));
    ipc
      .checkPermissions()
      .then(setPerms)
      .catch((error) => log.warn("mic chip: permission check failed", { error: String(error) }));
  }

  function pick(device: string) {
    if (meetingActive || device === inputDevice) return;
    updateSettings({ inputDevice: device });
    toast(t("mic.menu.switched", { name: device || t("settings.transcription.systemDefault") }));
  }

  async function runTest() {
    if (testingRef.current || meetingActive || !isTauri()) return;
    testingRef.current = true;
    setTesting(true);
    let heard = false;
    let unlisten: (() => void) | undefined;
    try {
      // Listen before opening the mic so the first loud chunk isn't missed.
      unlisten = await listenEvent<AudioLevelPayload>(AUDIO_LEVEL_EVENT, (e) => {
        if (e.payload.source === "test" && e.payload.level >= TEST_HEARD_LEVEL) heard = true;
      });
      try {
        await ipc.startMicTest({ inputDevice });
      } catch (error) {
        log.warn("mic chip: start mic test failed", { inputDevice, error: String(error) });
        toast.error(t("settings.transcription.micTestFailed"));
        return;
      }
      const deadline = Date.now() + TEST_WINDOW_MS;
      while (!heard && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (heard) toast.success(t("mic.test.ok", { name: deviceName }));
      else toast.warning(t("mic.test.silent"));
    } finally {
      unlisten?.();
      await ipc
        .stopMicTest()
        .catch((error) => log.warn("mic chip: stop mic test failed", { error: String(error) }));
      testingRef.current = false;
      setTesting(false);
    }
  }

  // The saved device stays listed (and checked) even when it's unplugged, so
  // the menu never claims a different mic is in use than the one recording
  // will try to open.
  const options = ["", ...devices];
  if (inputDevice && !options.includes(inputDevice)) options.push(inputDevice);

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("mic.chip.label", { name: deviceName })}
          title={t("mic.chip.title", { name: deviceName })}
          className="inline-flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted aria-expanded:bg-muted"
        >
          <Mic className="size-3.5 shrink-0" />
          <span className="max-w-[150px] truncate">{deviceName}</span>
          <ChipMeter level={level} />
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        <div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold text-muted-foreground">
          {t("mic.menu.header")}
        </div>
        {options.map((device) => {
          const current = device === inputDevice;
          return (
            <DropdownMenuItem
              key={device || "__default"}
              role="menuitemradio"
              aria-checked={current}
              disabled={meetingActive && !current}
              title={meetingActive ? t("mic.menu.lockedWhileMeeting") : undefined}
              onSelect={() => pick(device)}
            >
              <span className="min-w-0 flex-1 truncate">
                {device || t("settings.transcription.systemDefault")}
              </span>
              <Check className={`size-3.5 text-primary ${current ? "" : "invisible"}`} />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <SystemAudioStatus perms={perms} />
        <DropdownMenuItem
          disabled={meetingActive || testing}
          title={meetingActive ? t("mic.menu.lockedWhileMeeting") : undefined}
          onSelect={() => void runTest()}
          className="mx-1 mt-0.5 mb-1 h-7 justify-center rounded-lg border text-xs font-medium"
        >
          {testing ? t("mic.test.listening") : t("mic.test")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
