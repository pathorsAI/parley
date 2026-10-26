import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { log } from "../../lib/log";
import * as ipc from "../../lib/ipc/commands";
import { LevelMeter } from "../LevelMeter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const DEFAULT_DEVICE = "__default__";

/**
 * Pick the input device and see it move: the same level-only preview as
 * Settings › Transcription (start_mic_test), no transcription behind it. The
 * test stops when the user leaves the step.
 */
export function MicStep() {
  const { t } = useI18n();
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const patch = useStore((s) => s.updateSettings);
  const [devices, setDevices] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  // What the user last asked for, set before the IPC call so a cleanup that
  // races a pending start still knows the mic is (about to be) open.
  const wantTest = useRef(false);
  const mounted = useRef(true);
  const desktop = isTauri();

  useEffect(() => {
    if (!desktop) return;
    ipc
      .listInputDevices()
      .then(setDevices)
      .catch((e) => log.warn("onboarding: list input devices failed", { error: String(e) }));
  }, [desktop]);

  // Never leave the mic open behind a closed step.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (wantTest.current) {
        wantTest.current = false;
        ipc.stopMicTest().catch((e) => log.warn("onboarding: stop mic test failed", { error: String(e) }));
      }
    };
  }, []);

  async function start(device: string) {
    wantTest.current = true;
    setTesting(true);
    await ipc.startMicTest({ inputDevice: device || null });
    // Stopped (or the step closed) while the start was in flight: the stop
    // may have reached the backend first, so close what this start opened.
    if (!wantTest.current || !mounted.current) await ipc.stopMicTest();
  }

  async function stop() {
    wantTest.current = false;
    if (mounted.current) setTesting(false);
    await ipc.stopMicTest();
  }

  async function pickDevice(value: string) {
    const dev = value === DEFAULT_DEVICE ? "" : value;
    patch({ inputDevice: dev });
    if (wantTest.current) {
      await stop();
      if (mounted.current) await start(dev);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{t("onboarding.mic.title")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.mic.body")}</p>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t("onboarding.mic.device")}</span>
        <Select
          value={inputDevice || DEFAULT_DEVICE}
          disabled={!desktop}
          onValueChange={(v) => {
            pickDevice(v).catch((e) => log.warn("onboarding: switch input device failed", { error: String(e) }));
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("settings.transcription.systemDefault")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_DEVICE}>{t("settings.transcription.systemDefault")}</SelectItem>
            {devices.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2.5">
        <Button
          variant={testing ? "destructive" : "outline"}
          size="sm"
          className="h-8 gap-1.5"
          disabled={!desktop}
          onClick={() => {
            (testing ? stop() : start(inputDevice)).catch((e) => {
              wantTest.current = false;
              if (mounted.current) setTesting(false);
              log.warn("onboarding: mic test toggle failed", { error: String(e) });
            });
          }}
        >
          <Mic className="size-3.5" />
          {testing ? t("settings.transcription.stopTest") : t("settings.transcription.testMic")}
        </Button>
        <LevelMeter source="test" className="h-2 flex-1" />
      </div>
      {!desktop && <p className="text-[11px] text-muted-foreground">{t("onboarding.mic.desktopOnly")}</p>}
    </div>
  );
}
