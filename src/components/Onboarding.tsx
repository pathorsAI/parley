import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronLeft, ChevronRight, Download, Keyboard, Loader2, Mic, Monitor, X } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { PROVIDERS, PROVIDER_BY_ID } from "../lib/ai/providers";
import { STT_PROVIDERS, STT_BY_ID } from "../lib/transcription/providers";
import { useI18n, LANGUAGE_OPTIONS } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppLanguage, LlmProvider, Settings, SttProviderId } from "../lib/types";

type Perms = { microphone: string; screenRecording: boolean };

const STEP_COUNT = 8;

export function Onboarding() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const [step, setStep] = useState(() => {
    const s = settings.onboardingStep ?? 0;
    return s >= 0 && s < STEP_COUNT ? s : 0;
  });
  const [perms, setPerms] = useState<Perms | null>(null);
  const [accessibilityOk, setAccessibilityOk] = useState(false);

  // Persist the step so granting a permission (which often needs an app restart)
  // resumes here instead of bouncing back to step 1.
  useEffect(() => {
    patch({ onboardingStep: step });
  }, [step, patch]);

  const llm = PROVIDER_BY_ID[settings.provider];
  const stt = STT_BY_ID[settings.transcriptionProvider];

  async function recheck() {
    if (!isTauri()) return;
    try {
      setPerms(await invoke<Perms>("check_permissions"));
      setAccessibilityOk(await invoke<boolean>("accessibility_status", { prompt: false }));
    } catch {
      /* non-macOS or unavailable */
    }
  }

  // Permissions step (4): re-check on entry AND whenever the app regains focus /
  // becomes visible, plus a slow fallback poll — so granting mic/screen access in
  // the system prompt or System Settings flips the row to ✓ on its own when the
  // user comes back, instead of staying stale until a manual re-check. (Webview
  // focus events aren't fully reliable across the app-switch to System Settings,
  // hence the 2 s poll; it stops when the user leaves the step.)
  useEffect(() => {
    if (step !== 4) return;
    void recheck();
    const recheckNow = () => void recheck();
    window.addEventListener("focus", recheckNow);
    document.addEventListener("visibilitychange", recheckNow);
    const id = window.setInterval(recheckNow, 2000);
    return () => {
      window.removeEventListener("focus", recheckNow);
      document.removeEventListener("visibilitychange", recheckNow);
      window.clearInterval(id);
    };
  }, [step]);

  function finish() {
    patch({ onboarded: true, onboardingStep: 0 });
  }

  const micOk = perms?.microphone === "authorized";
  const screenOk = perms?.screenRecording === true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-xl border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <span className="text-sm font-semibold">{t("onboarding.title")}</span>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground">
              {step + 1} / {STEP_COUNT}
            </span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title={t("onboarding.skip")}
              onClick={finish}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {step === 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{t("onboarding.lang.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.lang.body")}</p>
              <div className="mt-1 grid gap-2">
                {LANGUAGE_OPTIONS.map((lang) => (
                  <button
                    key={lang.value}
                    type="button"
                    onClick={() => patch({ language: lang.value as AppLanguage })}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                      settings.language === lang.value
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span>{lang.nativeLabel}</span>
                    {settings.language === lang.value && <Check className="size-4 text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{t("onboarding.welcome.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.welcome.body")}</p>
              <ul className="mt-1 flex flex-col gap-1.5 text-sm text-muted-foreground">
                <li>• {t("onboarding.welcome.point1")}</li>
                <li>• {t("onboarding.welcome.point2")}</li>
                <li>• {t("onboarding.welcome.point3")}</li>
              </ul>
            </div>
          )}

          {step === 2 && (
            <StepKey
              title={t("onboarding.llm.title")}
              body={t("onboarding.llm.body")}
              label={t("onboarding.llm.provider")}
            >
              <Select value={settings.provider} onValueChange={(v) => patch({ provider: v as LlmProvider })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* The hosted "parley" provider requires a signed-in cloud session,
                      which is set up from Settings → Account, not first-run onboarding.
                      Exclude it here so OSS/signed-out users can't pick an unusable
                      provider (Settings gates it on CLOUD_ENABLED && cloudAuth). */}
                  {PROVIDERS.filter((p) => p.id !== "parley").map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <img src={p.icon} alt="" className="size-4 rounded-sm" />
                        {p.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {llm.requiresKey === false ? (
                <p className="text-[11px] text-muted-foreground">{t("onboarding.llm.noKey")}</p>
              ) : (
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={llm.keyPlaceholder}
                  value={(settings[llm.apiKeyField] as string) ?? ""}
                  onChange={(e) => patch({ [llm.apiKeyField]: e.target.value } as Partial<Settings>)}
                />
              )}
            </StepKey>
          )}

          {step === 3 && (
            <StepKey
              title={t("onboarding.stt.title")}
              body={t("onboarding.stt.body")}
              label={t("onboarding.stt.provider")}
            >
              <Select
                value={settings.transcriptionProvider}
                onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STT_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <img src={p.icon} alt="" className="size-4 rounded-sm" />
                        {p.label}
                        {!p.diarization && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-300">
                            {t("settings.transcription.noDiarizationTag")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="password"
                autoComplete="off"
                placeholder={stt.keyPlaceholder}
                value={(settings[stt.apiKeyField] as string) ?? ""}
                onChange={(e) => patch({ [stt.apiKeyField]: e.target.value } as Partial<Settings>)}
              />
            </StepKey>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-tight">{t("onboarding.perms.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.perms.body")}</p>

              <PermRow
                icon={<Mic className="size-4" />}
                label={t("onboarding.perms.mic")}
                ok={micOk}
                actionLabel={t("onboarding.perms.grant")}
                onAction={async () => {
                  await invoke("start_mic_test", { inputDevice: settings.inputDevice }).catch(() => {});
                  await invoke("stop_mic_test").catch(() => {});
                  await invoke("open_privacy_settings", { pane: "microphone" }).catch(() => {});
                  void recheck();
                }}
              />
              <PermRow
                icon={<Monitor className="size-4" />}
                label={t("onboarding.perms.screen")}
                ok={screenOk}
                actionLabel={t("onboarding.perms.grant")}
                onAction={async () => {
                  await invoke("request_screen_recording").catch(() => {});
                  await invoke("open_privacy_settings", { pane: "screen" }).catch(() => {});
                  void recheck();
                }}
              />
              <PermRow
                icon={<Keyboard className="size-4" />}
                label={t("onboarding.perms.accessibility")}
                ok={accessibilityOk}
                actionLabel={t("onboarding.perms.grant")}
                onAction={async () => {
                  // Single native prompt (it offers its own "Open System Settings").
                  await invoke("accessibility_status", { prompt: true }).catch(() => {});
                  await invoke("ensure_fn_listener").catch(() => {});
                  void recheck();
                }}
              />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void recheck()}>
                  {t("onboarding.perms.recheck")}
                </Button>
                <span className="text-[11px] text-muted-foreground">{t("onboarding.perms.hint")}</span>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-tight">{t("onboarding.profile.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.profile.body")}</p>
              <Input
                placeholder={t("settings.basic.namePlaceholder")}
                value={settings.userName}
                onChange={(e) => patch({ userName: e.target.value })}
              />
              <Input
                placeholder={t("settings.basic.rolePlaceholder")}
                value={settings.userRole}
                onChange={(e) => patch({ userRole: e.target.value })}
              />
              <Input
                placeholder={t("settings.basic.companyPlaceholder")}
                value={settings.userCompany}
                onChange={(e) => patch({ userCompany: e.target.value })}
              />
            </div>
          )}

          {step === 6 && <DiarizeModelStep />}

          {step === 7 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <Check className="size-6" />
              </div>
              <h2 className="text-lg font-semibold tracking-tight">{t("onboarding.done.title")}</h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("onboarding.done.body")}</p>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between border-t px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ChevronLeft className="size-3.5" />
            {t("onboarding.back")}
          </Button>
          {step < STEP_COUNT - 1 ? (
            <Button size="sm" className="h-8 text-xs" onClick={() => setStep((s) => s + 1)}>
              {t("onboarding.next")}
              <ChevronRight className="size-3.5" />
            </Button>
          ) : (
            <Button size="sm" className="h-8 text-xs" onClick={finish}>
              {t("onboarding.start")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepKey({
  title,
  body,
  label,
  children,
}: {
  title: string;
  body: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      <label className="mt-1 text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function PermRow({
  icon,
  label,
  ok,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-sm">{label}</span>
      {ok ? (
        <span className="flex items-center gap-1 text-xs text-emerald-400">
          <Check className="size-3.5" />
        </span>
      ) : (
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Optional step: pre-fetch the ~27 MB speaker-diarization model so the first real
 * diarization is instant and works offline. Fully skippable — Next advances
 * regardless, and the model still downloads on demand on first use if skipped.
 * Reuses the Rust `diarize://progress` events for the progress bar.
 */
function DiarizeModelStep() {
  const { t } = useI18n();
  const [status, setStatus] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<{ stage: string; received: number; total: number }>("diarize://progress", (e) => {
      if (alive && e.payload.stage === "downloading-model") {
        setProgress({ received: e.payload.received, total: e.payload.total });
      }
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;

  async function download() {
    if (status === "downloading") return;
    setStatus("downloading");
    setError(null);
    setProgress(null);
    try {
      const { prefetchDiarizeModel } = await import("../lib/speakers/diarize");
      await prefetchDiarizeModel();
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{t("onboarding.diarize.title")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.diarize.body")}</p>
      {status === "done" ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-500">
          <Check className="size-4" />
          {t("onboarding.diarize.ready")}
        </div>
      ) : (
        <>
          <Button
            size="sm"
            className="h-8 gap-1.5 self-start"
            disabled={status === "downloading"}
            onClick={() => void download()}
          >
            {status === "downloading" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {status === "downloading"
              ? t("onboarding.diarize.downloading", { percent: pct })
              : t("onboarding.diarize.download")}
          </Button>
          {status === "downloading" && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {error && (
            <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
              {t("onboarding.diarize.failed", { error })}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">{t("onboarding.diarize.skipHint")}</p>
        </>
      )}
    </div>
  );
}
