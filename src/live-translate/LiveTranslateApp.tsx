import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Languages, Mic, Speaker, Loader2, AlertTriangle } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { TRANSLATE_LANGUAGES } from "../lib/translateLanguages";
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

/** Combined audio-token price for gemini-3.5-live-translate-preview: input
 *  $0.0053/min + output $0.0315/min. Output audio dominates. Used for the live
 *  estimate only — real billing is metered server-side. */
const USD_PER_MINUTE = 0.0053 + 0.0315;

type Lang = "zh-TW" | "en";

const STRINGS = {
  "zh-TW": {
    title: "即時語音翻譯",
    subtitle: "麥克風 → Gemini 翻譯 → 輸出裝置",
    sourceMic: "來源麥克風（你的聲音）",
    targetLang: "翻譯成",
    outputDevice: "輸出裝置",
    systemDefault: "系統預設",
    start: "開始翻譯",
    stop: "停止",
    starting: "啟動中…",
    running: "翻譯中",
    yourVoice: "你的聲音",
    translated: "翻譯輸出",
    heard: "聽到（原文）",
    speaking: "說出（譯文）",
    noKey: "尚未設定 Gemini API key，請先到 Parley 設定頁填入。",
    apiKey: "Gemini API key",
    apiKeyHint: "此功能用 Gemini 翻譯，需要有 gemini-3.5-live-translate-preview 權限的金鑰（可到 Google AI Studio 取得）。填在這裡即可，會和設定頁共用。",
    outputHint:
      "翻譯後的語音會從所選輸出裝置播出。要讓 Google Meet 聽到，Phase 2 會提供「Parley 虛擬麥克風」；現在可先選耳機自行驗證。",
    costHint: "約 US${rate}/分鐘（輸出音訊佔大宗）",
    estCost: "本次估計花費",
    elapsed: "已進行",
    errKey: "Gemini API key 無效或被拒絕。",
    errQuota: "已達額度上限或請求過於頻繁。",
    errConnect: "連線失敗，請檢查網路後重試。",
  },
  en: {
    title: "Live Translation",
    subtitle: "Microphone → Gemini translate → output device",
    sourceMic: "Source microphone (your voice)",
    targetLang: "Translate to",
    outputDevice: "Output device",
    systemDefault: "System default",
    start: "Start translating",
    stop: "Stop",
    starting: "Starting…",
    running: "Translating",
    yourVoice: "Your voice",
    translated: "Translated out",
    heard: "Heard (source)",
    speaking: "Spoken (translation)",
    noKey: "No Gemini API key set — add one in Parley settings first.",
    apiKey: "Gemini API key",
    apiKeyHint: "This uses Gemini to translate — needs a key with access to gemini-3.5-live-translate-preview (from Google AI Studio). Enter it here; it's shared with Settings.",
    outputHint:
      "The translated voice plays out the chosen output device. To have Google Meet hear it, Phase 2 adds a “Parley virtual microphone”; for now pick your headphones to validate.",
    costHint: "≈ US${rate}/min (output audio dominates)",
    estCost: "Estimated cost this session",
    elapsed: "Elapsed",
    errKey: "The Gemini API key is invalid or was rejected.",
    errQuota: "Quota reached or too many requests.",
    errConnect: "Connection failed — check your network and retry.",
  },
} as const;

interface TranscriptPayload {
  input: string;
  output: string;
}
interface ErrorPayload {
  code: string;
  message: string;
}

export function LiveTranslateApp() {
  const lang = useStore((s) => s.settings.language) as Lang;
  const t = STRINGS[lang] ?? STRINGS["zh-TW"];

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
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAt = useRef<number | null>(null);

  const hasKey = geminiApiKey.trim().length > 0;

  // Enumerate devices + sync running state on mount.
  useEffect(() => {
    if (!isTauri()) return;
    invoke<string[]>("list_input_devices").then(setInputDevices).catch(() => {});
    invoke<string[]>("list_output_devices").then(setOutputDevices).catch(() => {});
    invoke<boolean>("translate_active")
      .then((active) => {
        setRunning(active);
        if (active) startedAt.current = Date.now();
      })
      .catch(() => {});
  }, []);

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
          setError(null);
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
        setError(code === "key" ? t.errKey : code === "quota" ? t.errQuota : t.errConnect);
      })
    );
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [t]);

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
    setError(null);
    setStarting(true);
    invoke("start_translate", {
      apiKey: geminiApiKey,
      targetLanguage,
      echoTargetLanguage: true,
      inputDevice: inputDevice || undefined,
      outputDevice: outputDevice || undefined,
    }).catch((e) => {
      setStarting(false);
      setError(String(e));
      log.error("translate: start failed", { error: String(e) });
    });
  }, [hasKey, starting, running, geminiApiKey, targetLanguage, inputDevice, outputDevice]);

  const stop = useCallback(() => {
    invoke("stop_translate").catch((e) => log.warn("translate: stop failed", { error: String(e) }));
    setRunning(false);
    setStarting(false);
  }, []);

  const estCost = ((elapsedSec / 60) * USD_PER_MINUTE).toFixed(3);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  const deviceValue = (d: string) => d || DEFAULT_DEVICE;
  const setDevice = (key: "translateInputDevice" | "translateOutputDevice", v: string) =>
    updateSettings({ [key]: v === DEFAULT_DEVICE ? "" : v });

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-background p-5 text-foreground">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Languages className="size-5" /> {t.title}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t.subtitle}</p>
      </header>

      {/* Gemini API key — a direct entry point to the shared geminiApiKey
          setting, so the feature is usable without hunting through Settings. */}
      <div className="mb-4 flex flex-col gap-1.5">
        <label className="text-sm font-medium">{t.apiKey}</label>
        <PasswordInput
          value={geminiApiKey}
          onChange={(e) => updateSettings({ geminiApiKey: e.target.value })}
          placeholder="AIza…"
          disabled={running}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">{t.apiKeyHint}</p>
      </div>

      <div className="flex flex-col gap-4">
        {/* Source microphone */}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Mic className="size-3.5" /> {t.sourceMic}
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
              <SelectItem value={DEFAULT_DEVICE}>{t.systemDefault}</SelectItem>
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
            <Languages className="size-3.5" /> {t.targetLang}
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
            <Speaker className="size-3.5" /> {t.outputDevice}
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
              <SelectItem value={DEFAULT_DEVICE}>{t.systemDefault}</SelectItem>
              {outputDevices.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">{t.outputHint}</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Start / Stop */}
        {running ? (
          <Button variant="destructive" onClick={stop} className="w-full">
            {t.stop}
          </Button>
        ) : (
          <Button onClick={start} disabled={!hasKey || starting} className="w-full">
            {starting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> {t.starting}
              </>
            ) : (
              t.start
            )}
          </Button>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {t.costHint.replace("{rate}", USD_PER_MINUTE.toFixed(4))}
        </p>

        {/* Live panel */}
        {running && (
          <div className="mt-1 flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                <span className="size-2 animate-pulse rounded-full bg-emerald-500" /> {t.running}
              </span>
              <span className="text-muted-foreground">
                {t.elapsed} {mm}:{ss} · {t.estCost} ≈ US${estCost}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{t.yourVoice}</span>
              <LevelMeter source="translate-in" className="flex-1" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{t.translated}</span>
              <LevelMeter source="translate-out" className="flex-1" />
            </div>

            <div className="flex flex-col gap-1 border-t pt-2 text-sm">
              <div>
                <span className="mr-1 text-xs text-muted-foreground">{t.heard}:</span>
                <span>{transcript.input || "…"}</span>
              </div>
              <div>
                <span className="mr-1 text-xs text-muted-foreground">{t.speaking}:</span>
                <span className="font-medium">{transcript.output || "…"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
