import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Languages, Mic, Speaker, Loader2, AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { TRANSLATE_LANGUAGES, TRANSLATE_USD_PER_MINUTE } from "../lib/translateLanguages";
import { useI18n } from "../i18n";
import { Flag } from "../components/ui/flag";
import { LevelMeter } from "../components/LevelMeter";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PasswordInput } from "@/components/ui/password-input";

/** Empty device value ("") ↔ this sentinel, since Radix Select forbids "". */
const DEFAULT_DEVICE = "__default__";

interface TranscriptPayload {
  input: string;
  output: string;
}
interface ErrorPayload {
  code: string;
  message: string;
}
interface VirtualMicStatus {
  deviceVisible: boolean;
  driverInstalled: boolean;
  pkgAvailable: boolean;
  deviceName: string;
}

/** Known backend error codes → i18n; anything else reads as a connect failure. */
type TranslateErrorCode = "key" | "quota" | "connect";

export function LiveTranslateApp() {
  const { t } = useI18n();

  const geminiApiKey = useStore((s) => s.settings.geminiApiKey);
  const inputDevice = useStore((s) => s.settings.translateInputDevice);
  const outputDevice = useStore((s) => s.settings.translateOutputDevice);
  const targetLanguage = useStore((s) => s.settings.translateTargetLanguage);
  const updateSettings = useStore((s) => s.updateSettings);

  const [inputDevices, setInputDevices] = useState<string[]>([]);
  const [outputDevices, setOutputDevices] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptPayload>({ input: "", output: "" });
  // Backend errors arrive as a code (translated at render, so a language
  // switch retranslates them); a failed start invoke keeps its raw message.
  const [errorCode, setErrorCode] = useState<TranslateErrorCode | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAt = useRef<number | null>(null);
  const [micStatus, setMicStatus] = useState<VirtualMicStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const hasKey = geminiApiKey.trim().length > 0;

  const refreshDevices = useCallback(() => {
    if (!isTauri()) return;
    invoke<string[]>("list_input_devices").then(setInputDevices).catch(() => {});
    invoke<string[]>("list_output_devices").then(setOutputDevices).catch(() => {});
    invoke<VirtualMicStatus>("virtual_mic_status").then(setMicStatus).catch(() => {});
  }, []);

  // Enumerate devices + sync running state on mount.
  useEffect(() => {
    if (!isTauri()) return;
    refreshDevices();
    invoke<boolean>("translate_active")
      .then((active) => {
        setRunning(active);
        if (active) startedAt.current = Date.now();
      })
      .catch(() => {});
  }, [refreshDevices]);

  // One-click driver install: native admin prompt → installer runs → coreaudiod
  // reloads. Poll status briefly afterwards (device registration isn't instant),
  // then auto-select the virtual mic as the output device.
  const installVirtualMic = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await invoke("install_virtual_mic");
      let visible = false;
      for (let i = 0; i < 10 && !visible; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const s = await invoke<VirtualMicStatus>("virtual_mic_status");
        setMicStatus(s);
        visible = s.deviceVisible;
        if (visible) updateSettings({ translateOutputDevice: s.deviceName });
      }
      refreshDevices();
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("cancelled")) {
        setInstallError(msg);
        log.error("virtual-mic: install failed", { error: msg });
      }
    } finally {
      setInstalling(false);
    }
  }, [installing, refreshDevices, updateSettings]);

  // Backend status / transcript / error events.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let active = true;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => (active ? unlisteners.push(fn) : fn())).catch(() => {});

    track(
      listen<string>("translate://status", (e) => {
        const isRunning = e.payload === "running";
        setRunning(isRunning);
        setStarting(false);
        if (isRunning) {
          startedAt.current = Date.now();
          setErrorCode(null);
          setRawError(null);
        } else {
          startedAt.current = null;
          setTranscript({ input: "", output: "" });
        }
      })
    );
    track(
      listen<TranscriptPayload>("translate://transcript", (e) => setTranscript(e.payload))
    );
    track(
      listen<ErrorPayload>("translate://error", (e) => {
        setRunning(false);
        setStarting(false);
        startedAt.current = null;
        const code = e.payload.code;
        setErrorCode(code === "key" ? "key" : code === "quota" ? "quota" : "connect");
        setRawError(null);
      })
    );
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Tick the elapsed timer while running (drives the cost estimate).
  useEffect(() => {
    if (!running) {
      setElapsedSec(0);
      return;
    }
    const id = setInterval(() => {
      if (startedAt.current) {
        setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const start = useCallback(() => {
    if (!hasKey || starting || running) return;
    setErrorCode(null);
    setRawError(null);
    setStarting(true);
    invoke("start_translate", {
      apiKey: geminiApiKey,
      targetLanguage,
      echoTargetLanguage: true,
      inputDevice: inputDevice || undefined,
      outputDevice: outputDevice || undefined,
    }).catch((e) => {
      setStarting(false);
      setRawError(String(e));
      log.error("translate: start failed", { error: String(e) });
    });
  }, [hasKey, starting, running, geminiApiKey, targetLanguage, inputDevice, outputDevice]);

  const stop = useCallback(() => {
    invoke("stop_translate").catch((e) => log.warn("translate: stop failed", { error: String(e) }));
    setRunning(false);
    setStarting(false);
  }, []);

  const estCost = ((elapsedSec / 60) * TRANSLATE_USD_PER_MINUTE).toFixed(3);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  const errorText = errorCode
    ? t(
        errorCode === "key"
          ? "liveTranslate.errKey"
          : errorCode === "quota"
            ? "liveTranslate.errQuota"
            : "liveTranslate.errConnect"
      )
    : rawError;

  const deviceValue = (d: string) => d || DEFAULT_DEVICE;
  const setDevice = (key: "translateInputDevice" | "translateOutputDevice", v: string) =>
    updateSettings({ [key]: v === DEFAULT_DEVICE ? "" : v });

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-background p-5 text-foreground">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Languages className="size-5" /> {t("liveTranslate.title")}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("liveTranslate.subtitle")}</p>
      </header>

      {/* Gemini API key — a direct entry point to the shared geminiApiKey
          setting, so the feature is usable without hunting through Settings. */}
      <div className="mb-4 flex flex-col gap-1.5">
        <label className="text-sm font-medium">{t("settings.translate.apiKey")}</label>
        <PasswordInput
          value={geminiApiKey}
          onChange={(e) => updateSettings({ geminiApiKey: e.target.value })}
          placeholder="AIza…"
          disabled={running}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("liveTranslate.apiKeyHint")}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* Source microphone */}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Mic className="size-3.5" /> {t("liveTranslate.sourceMic")}
          </label>
          <Select
            value={deviceValue(inputDevice)}
            onValueChange={(v) => setDevice("translateInputDevice", v)}
            disabled={running}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_DEVICE}>
                {t("settings.transcription.systemDefault")}
              </SelectItem>
              {inputDevices.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Target language */}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Languages className="size-3.5" /> {t("meeting.translate.language")}
          </label>
          <Select
            value={targetLanguage}
            onValueChange={(v) => updateSettings({ translateTargetLanguage: v })}
            disabled={running}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSLATE_LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  <Flag code={l.flag} />
                  {l.nativeLabel}
                  <span className="ml-2 text-muted-foreground">{l.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Output device */}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Speaker className="size-3.5" /> {t("meeting.translate.output")}
          </label>
          <Select
            value={deviceValue(outputDevice)}
            onValueChange={(v) => setDevice("translateOutputDevice", v)}
            disabled={running}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_DEVICE}>
                {t("settings.transcription.systemDefault")}
              </SelectItem>
              {outputDevices.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("liveTranslate.outputHint")}
          </p>
        </div>

        {/* Parley virtual microphone: install card / installed state */}
        {micStatus && !micStatus.deviceVisible && (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <span className="text-sm font-medium">{t("liveTranslate.vmicTitle")}</span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("liveTranslate.vmicNotInstalled")}
            </p>
            {micStatus.pkgAvailable ? (
              <Button size="sm" onClick={installVirtualMic} disabled={installing}>
                {installing ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> {t("liveTranslate.vmicInstalling")}
                  </>
                ) : (
                  <>
                    <Download className="size-3.5" /> {t("liveTranslate.vmicInstall")}
                  </>
                )}
              </Button>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("liveTranslate.vmicNoPkg")}
              </p>
            )}
            {installError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {t("liveTranslate.vmicFailed", { error: installError })}
              </p>
            )}
          </div>
        )}
        {micStatus?.deviceVisible && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="font-medium">{t("liveTranslate.vmicTitle")}</span>
            <span className="text-muted-foreground">{t("liveTranslate.vmicInstalled")}</span>
            {outputDevice === micStatus.deviceName ? (
              <span className="ml-auto text-right text-muted-foreground">
                {t("liveTranslate.vmicInUse")}
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7"
                disabled={running}
                onClick={() => updateSettings({ translateOutputDevice: micStatus.deviceName })}
              >
                {t("liveTranslate.vmicUse")}
              </Button>
            )}
          </div>
        )}

        {errorText && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{errorText}</span>
          </div>
        )}

        {/* Start / Stop */}
        {running ? (
          <Button variant="destructive" onClick={stop} className="w-full">
            {t("liveTranslate.stop")}
          </Button>
        ) : (
          <Button onClick={start} disabled={!hasKey || starting} className="w-full">
            {starting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> {t("liveTranslate.starting")}
              </>
            ) : (
              t("liveTranslate.start")
            )}
          </Button>
        )}

        {!hasKey && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t("liveTranslate.noKey")}
          </p>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {t("liveTranslate.costHint", { rate: TRANSLATE_USD_PER_MINUTE.toFixed(4) })}
        </p>

        {/* Live panel */}
        {running && (
          <div className="mt-1 flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                <span className="size-2 animate-pulse rounded-full bg-emerald-500" />{" "}
                {t("liveTranslate.running")}
              </span>
              <span className="text-muted-foreground">
                {t("liveTranslate.elapsed")} {mm}:{ss} · {t("liveTranslate.estCost")} ≈ US$
                {estCost}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                {t("liveTranslate.yourVoice")}
              </span>
              <LevelMeter source="translate-in" className="flex-1" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                {t("liveTranslate.translated")}
              </span>
              <LevelMeter source="translate-out" className="flex-1" />
            </div>

            <div className="flex flex-col gap-1 border-t pt-2 text-sm">
              <div>
                <span className="mr-1 text-xs text-muted-foreground">
                  {t("liveTranslate.heard")}:
                </span>
                <span>{transcript.input || "…"}</span>
              </div>
              <div>
                <span className="mr-1 text-xs text-muted-foreground">
                  {t("liveTranslate.speaking")}:
                </span>
                <span className="font-medium">{transcript.output || "…"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
