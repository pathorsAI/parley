import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronLeft, ChevronRight, Download, Keyboard, Loader2, LogIn, Mic, Volume2, X } from "lucide-react";
import { useStore } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { broadcastSettings } from "../lib/settingsSync";
import { CLOUD_ENABLED } from "../lib/flags";
import { log } from "../lib/log";
import { shortcutCaps } from "../settings/VoiceTypingSettings";
import { PROVIDERS, PROVIDER_BY_ID } from "../lib/ai/providers";
import { STT_PROVIDERS, STT_BY_ID } from "../lib/transcription/providers";
import { useI18n, LANGUAGE_OPTIONS } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppLanguage, LlmProvider, Settings, SttProviderId } from "../lib/types";

// systemAudio: unknown | granted | denied | unsupported (macOS < 14.2).
type Perms = { microphone: string; systemAudio: string };

type StepId =
  | "lang"
  | "welcome"
  | "login"
  | "llm"
  | "stt"
  | "perms"
  | "profile"
  | "diarize"
  | "voiceTyping"
  | "done";

// Ordered onboarding steps. The Parley sign-in step only exists in the official
// (cloud) build — it offers the free hosted STT + LLM. CLOUD_ENABLED is a
// compile-time constant, so the OSS build never ships the step at all.
const STEPS: StepId[] = [
  "lang",
  "welcome",
  ...(CLOUD_ENABLED ? (["login"] as StepId[]) : []),
  "llm",
  "stt",
  "perms",
  "profile",
  "diarize",
  "voiceTyping",
  "done",
];
const STEP_COUNT = STEPS.length;

export function Onboarding() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [step, setStep] = useState(() => {
    const s = settings.onboardingStep ?? 0;
    return s >= 0 && s < STEP_COUNT ? s : 0;
  });
  const current = STEPS[step];
  const [perms, setPerms] = useState<Perms | null>(null);

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
      // Side-effect free: check_permissions never triggers an OS prompt, so
      // polling it below is safe.
      setPerms(await invoke<Perms>("check_permissions"));
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
    if (STEPS[step] !== "perms") return;
    recheck().catch((error) => log.warn("onboarding: permission recheck failed", { error: String(error) }));
    const recheckNow = () => {
      recheck().catch((error) => log.warn("onboarding: permission recheck failed", { error: String(error) }));
    };
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
  const systemAudioOk = perms?.systemAudio === "granted";

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
          {current === "lang" && (
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

          {current === "welcome" && (
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

          {current === "login" && <LoginStep />}

          {current === "llm" && (
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
                  {/* The hosted "parley" provider needs a signed-in cloud session:
                      offer it only in the official build once the user signed in at
                      the login step (mirrors the Settings gate). */}
                  {PROVIDERS.filter((p) => p.id !== "parley" || (CLOUD_ENABLED && !!cloudAuth)).map((p) => (
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
                <p className="text-[11px] text-muted-foreground">
                  {llm.id === "parley" ? t("onboarding.login.signedIn") : t("onboarding.llm.noKey")}
                </p>
              ) : (
                <PasswordInput
                  autoComplete="off"
                  placeholder={llm.keyPlaceholder}
                  value={(settings[llm.apiKeyField] as string) ?? ""}
                  onChange={(e) => patch({ [llm.apiKeyField]: e.target.value } as Partial<Settings>)}
                />
              )}
            </StepKey>
          )}

          {current === "stt" && (
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
                  {/* Hosted "parley" STT (relayed to Soniox) shows only in the
                      official build once signed in — mirrors the LLM step. */}
                  {STT_PROVIDERS.filter((p) => p.id !== "parley" || (CLOUD_ENABLED && !!cloudAuth)).map((p) => (
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
              {/* The hosted provider authenticates with the signed-in session, not
                  an API key — so no key field for it. */}
              {stt.id === "parley" ? (
                <p className="text-[11px] text-muted-foreground">{t("onboarding.login.signedIn")}</p>
              ) : (
                <PasswordInput
                  autoComplete="off"
                  placeholder={stt.keyPlaceholder}
                  value={(settings[stt.apiKeyField] as string) ?? ""}
                  onChange={(e) => patch({ [stt.apiKeyField]: e.target.value } as Partial<Settings>)}
                />
              )}
            </StepKey>
          )}

          {current === "perms" && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-tight">{t("onboarding.perms.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.perms.body")}</p>

              <PermRow
                icon={<Mic className="size-4" />}
                label={t("onboarding.perms.mic")}
                ok={micOk}
                actionLabel={t("onboarding.perms.grant")}
                onAction={async () => {
                  // Not yet determined → the native prompt is enough; only jump
                  // to System Settings when it was explicitly denied (the OS
                  // won't re-prompt in that case).
                  if (perms?.microphone === "denied") {
                    await invoke("open_privacy_settings", { pane: "microphone" }).catch((error) =>
                      log.warn("permissions: open microphone settings failed", { error: String(error) }),
                    );
                  } else {
                    await invoke("request_microphone").catch((error) =>
                      log.warn("permissions: microphone request failed", { error: String(error) }),
                    );
                  }
                  await recheck();
                }}
              />
              {perms?.systemAudio !== "unsupported" && (
                <PermRow
                  icon={<Volume2 className="size-4" />}
                  label={t("onboarding.perms.systemAudio")}
                  ok={systemAudioOk}
                  actionLabel={t("onboarding.perms.grant")}
                  onAction={async () => {
                    // Probes a real Core Audio process tap; the first probe makes
                    // macOS show the "record system audio" consent prompt.
                    const s = await invoke<string>("probe_system_audio").catch(() => null);
                    if (s === "denied") {
                      await invoke("open_privacy_settings", { pane: "system-audio" }).catch((error) =>
                        log.warn("permissions: open system-audio settings failed", { error: String(error) }),
                      );
                    }
                    await recheck();
                  }}
                />
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    recheck().catch((error) => log.warn("onboarding: permission recheck failed", { error: String(error) }))
                  }
                >
                  {t("onboarding.perms.recheck")}
                </Button>
                <span className="text-[11px] text-muted-foreground">{t("onboarding.perms.hint")}</span>
              </div>
            </div>
          )}

          {current === "profile" && (
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

          {current === "diarize" && <DiarizeModelStep />}

          {current === "voiceTyping" && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-tight">{t("onboarding.voiceTyping.title")}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.voiceTyping.body")}</p>
              <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
                <span className="text-muted-foreground">
                  <Keyboard className="size-4" />
                </span>
                <span className="flex-1 text-sm">
                  {t("onboarding.voiceTyping.holdPrefix")}{" "}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {shortcutCaps(settings.voiceTypingShortcut, t)}
                  </kbd>{" "}
                  {t("onboarding.voiceTyping.holdSuffix")}
                </span>
                <Button
                  variant={settings.voiceTypingEnabled ? "outline" : "default"}
                  size="sm"
                  className="h-7 shrink-0 text-[11px]"
                  onClick={() => {
                    const enabled = !settings.voiceTypingEnabled;
                    patch({ voiceTypingEnabled: enabled });
                    broadcastSettings({ ...useStore.getState().settings }).catch((error) =>
                      log.warn("settings: broadcast failed", { error: String(error) }),
                    );
                    // Auto-paste needs Accessibility — enabling is the moment to
                    // ask (same as the Settings toggle).
                    if (enabled) {
                      invoke("accessibility_status", { prompt: true }).catch((error) =>
                        log.warn("permissions: accessibility prompt failed", { error: String(error) }),
                      );
                    }
                  }}
                >
                  {settings.voiceTypingEnabled
                    ? t("settings.voiceTyping.disable")
                    : t("settings.voiceTyping.enable")}
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">{t("onboarding.voiceTyping.hint")}</span>
            </div>
          )}

          {current === "done" && (
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

/**
 * Official-build-only sign-in step. Signing in unlocks Parley's free hosted STT
 * + LLM; on success we default both providers to "parley" so the next two steps
 * come pre-configured (and now list "parley" as an option). Fully skippable —
 * Next advances regardless, and BYOK keys still work.
 */
function LoginStep() {
  const { t } = useI18n();
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { signInWithGoogle } = await import("../lib/cloud/client");
      await signInWithGoogle();
      // Signed in → default to Parley's free hosted STT + LLM so onboarding is
      // done in one tap; the LLM/STT pickers now surface "parley" too.
      patch({ provider: "parley", transcriptionProvider: "parley" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{t("onboarding.login.title")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.login.body")}</p>
      <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <Check className="size-3.5 shrink-0 text-emerald-500" />
          {t("onboarding.login.benefit1")}
        </li>
        <li className="flex items-center gap-2">
          <Check className="size-3.5 shrink-0 text-emerald-500" />
          {t("onboarding.login.benefit2")}
        </li>
      </ul>
      {cloudAuth ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-500">
          <Check className="size-4 shrink-0" />
          {t("onboarding.login.signedIn")}
        </div>
      ) : (
        <>
          <Button
            size="sm"
            className="h-9 w-fit gap-2 text-xs"
            disabled={signingIn || !isTauri()}
            onClick={() => doSignIn().catch((error) => log.error("onboarding: sign-in failed", { error: String(error) }))}
          >
            {signingIn ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            {signingIn ? t("settings.account.signingIn") : t("settings.account.signInGoogle")}
          </Button>
          {error && (
            <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
              {t("onboarding.login.failed", { error })}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">{t("onboarding.login.skipHint")}</p>
        </>
      )}
    </div>
  );
}

function StepKey({
  title,
  body,
  label,
  children,
}: Readonly<{
  title: string;
  body: string;
  label: string;
  children: React.ReactNode;
}>) {
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
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  actionLabel: string;
  onAction: () => void;
}>) {
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
            onClick={() => download().catch((error) => log.error("onboarding: diarize download failed", { error: String(error) }))}
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
