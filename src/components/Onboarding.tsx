import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, LogIn, Mic, Volume2, X } from "lucide-react";
import { useStore } from "../lib/store";
import { isMac } from "../lib/platform";
import { isTauri } from "../lib/tauriEvents";
import { CLOUD_ENABLED } from "../lib/flags";
import { log } from "../lib/log";
import { PROVIDERS, PROVIDER_BY_ID, type ProviderInfo } from "../lib/ai/providers";
import { STT_PROVIDERS, STT_BY_ID, sttApiKey } from "../lib/transcription/providers";
import { beginMeeting } from "../lib/meeting/start";
import { loadSampleRecording } from "../lib/onboarding/sample";
import { loadHistoryEntry } from "../lib/history/history";
import { useI18n, LANGUAGE_OPTIONS } from "../i18n";
import { Flag } from "./ui/flag";
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
import type { LlmProvider, Settings, SttProviderId } from "../lib/types";

// systemAudio: unknown | granted | denied | unsupported (macOS < 14.2).
type Perms = { microphone: string; systemAudio: string };

type StepId = "intro" | "account" | "perms" | "done";

// Four steps, one job each: say what Parley is, make transcription actually
// work, get the OS permissions, then hand off to a first real run. Teaching the
// rest of the app lives in the Home checklist, not here. The perms step runs on
// both platforms: macOS walks the TCC prompts; Windows has no runtime prompt,
// but the step is still the only place that shows whether the mic is actually
// allowed (the backend reads the consent store) and sends the user to the exact
// pane that flips it (ms-settings:privacy-microphone).
const STEPS: StepId[] = ["intro", "account", "perms", "done"];
const STEP_COUNT = STEPS.length;
const ACCOUNT_STEP = STEPS.indexOf("account");

/**
 * The account gate: transcription must be able to run before the wizard lets
 * the user go. Either a Parley session (hosted STT) or a key for the selected
 * BYOK STT provider — the same check `beginMeeting` makes before it opens a
 * capture session.
 */
function transcriptionReady(settings: Settings, signedIn: boolean): boolean {
  return signedIn || !!sttApiKey(settings, settings.transcriptionProvider).trim();
}

export function Onboarding() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [step, setStep] = useState(() => {
    const s = settings.onboardingStep ?? 0;
    const resumed = s >= 0 && s < STEP_COUNT ? s : 0;
    // A step persisted past the account gate (an older, longer wizard, or a
    // session that has since signed out) must not resume beyond it.
    const { settings: current, cloudAuth: auth } = useStore.getState();
    return resumed > ACCOUNT_STEP && !transcriptionReady(current, !!auth) ? ACCOUNT_STEP : resumed;
  });
  const current = STEPS[step];
  const [perms, setPerms] = useState<Perms | null>(null);

  // Persist the step so granting a permission (which often needs an app restart)
  // resumes here instead of bouncing back to step 1.
  useEffect(() => {
    patch({ onboardingStep: step });
  }, [step, patch]);

  const ready = transcriptionReady(settings, !!cloudAuth);
  // Neither Next on the account step nor the header X may get past the gate:
  // skipping used to land users in a mock recorder that played a fake
  // transcript and saved nothing, so the first meeting silently failed.
  const nextBlocked = current === "account" && !ready;
  const skipBlocked = !ready;

  async function recheck() {
    if (!isTauri()) return;
    try {
      // Side-effect free: check_permissions never triggers an OS prompt, so
      // polling it below is safe.
      setPerms(await invoke<Perms>("check_permissions"));
    } catch {
      /* command unavailable (plain-browser dev, or an unsupported OS) */
    }
  }

  // Permissions step: re-check on entry AND whenever the app regains focus /
  // becomes visible, plus a slow fallback poll — so granting mic/system-audio
  // access in the system prompt or System Settings flips the row to ✓ on its
  // own when the user comes back, instead of staying stale until a manual
  // re-check. (Webview focus events aren't fully reliable across the app-switch
  // to System Settings, hence the 2 s poll; it stops when the user leaves the
  // step.)
  useEffect(() => {
    if (STEPS[step] !== "perms") return;
    recheck().catch((error) => log.warn("onboarding: permission recheck failed", { error: String(error) }));
    const recheckNow = () => {
      recheck().catch((error) => log.warn("onboarding: permission recheck failed", { error: String(error) }));
    };
    window.addEventListener("focus", recheckNow);
    document.addEventListener("visibilitychange", recheckNow);
    const id = globalThis.setInterval(recheckNow, 2000);
    return () => {
      window.removeEventListener("focus", recheckNow);
      document.removeEventListener("visibilitychange", recheckNow);
      globalThis.clearInterval(id);
    };
  }, [step]);

  function finish() {
    patch({ onboarded: true, onboardingStep: 0 });
  }

  async function walkThroughSample() {
    finish();
    const id = await loadSampleRecording();
    if (id) {
      await loadHistoryEntry(id);
    } else {
      log.warn("onboarding: sample recording unavailable");
    }
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
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {step + 1} / {STEP_COUNT}
            </span>
            {/* The tooltip sits on a wrapper: a disabled button swallows the
                hover that would show its own title. */}
            <span title={skipBlocked ? t("onboarding.account.gate") : t("onboarding.skip")}>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label={t("onboarding.skip")}
                disabled={skipBlocked}
                onClick={finish}
              >
                <X className="size-4" />
              </button>
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {current === "intro" && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2">
                {LANGUAGE_OPTIONS.map((lang) => (
                  <button
                    key={lang.value}
                    type="button"
                    onClick={() => patch({ language: lang.value })}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      settings.language === lang.value
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Flag code={lang.flag} className="size-5" />
                      {lang.nativeLabel}
                    </span>
                    {settings.language === lang.value && <Check className="size-4 text-primary" />}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold tracking-tight">{t("onboarding.intro.title")}</h2>
                {/* "Both sides of the conversation" is a macOS promise: the
                    system-audio tap has no Windows counterpart yet, and the first
                    thing a Windows user reads should not be a capability the app
                    doesn't have. */}
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t(isMac() ? "onboarding.intro.body" : "onboarding.intro.body.windows")}
                </p>
                <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                  <li>• {t("onboarding.intro.point1")}</li>
                  <li>• {t("onboarding.intro.point2")}</li>
                  <li>• {t("onboarding.intro.point3")}</li>
                </ul>
              </div>
            </div>
          )}

          {current === "account" && <AccountStep />}

          {current === "perms" && (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-tight">
                {t(isMac() ? "onboarding.perms.title" : "onboarding.perms.title.windows")}
              </h2>
              {/* Windows names one permission, not two, and points at its own
                  Settings app — the macOS copy would send the user hunting for
                  a "System Audio Recording" grant that doesn't exist there. */}
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(isMac() ? "onboarding.perms.body" : "onboarding.perms.body.windows")}
              </p>

              <PermRow
                icon={<Mic className="size-4" />}
                label={t("onboarding.perms.mic")}
                ok={micOk}
                actionLabel={t(isMac() ? "onboarding.perms.grant" : "settings.permissions.openSettings")}
                onAction={async () => {
                  // Not yet determined → the native prompt is enough; only jump
                  // to System Settings when it was explicitly denied (the OS
                  // won't re-prompt in that case). Windows never prompts at all
                  // — request_microphone() is a stub there — so its only useful
                  // click is the deep link into the privacy pane.
                  if (!isMac() || perms?.microphone === "denied") {
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
              {/* macOS only, and only where the tap exists (< 14.2 reports
                  unsupported). Windows always reports unsupported, but `perms`
                  is null until the first check answers — without the platform
                  test the row would flash into a Windows user's first run. */}
              {isMac() && perms?.systemAudio !== "unsupported" && (
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
                <span className="text-[11px] text-muted-foreground">
                  {t(isMac() ? "onboarding.perms.hint" : "onboarding.perms.hint.windows")}
                </span>
              </div>
            </div>
          )}

          {current === "done" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-success text-success-foreground">
                <Check className="size-6" />
              </div>
              <h2 className="text-lg font-semibold tracking-tight">{t("onboarding.done.title")}</h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("onboarding.done.body")}</p>
              <div className="mt-2 flex flex-col items-center gap-2">
                <Button
                  size="sm"
                  className="h-9 text-xs"
                  onClick={() =>
                    walkThroughSample().catch((error) =>
                      log.error("onboarding: sample walkthrough failed", { error: String(error) }),
                    )
                  }
                >
                  {t("onboarding.done.sample")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    finish();
                    beginMeeting().catch((error) =>
                      log.error("onboarding: start meeting failed", { error: String(error) }),
                    );
                  }}
                >
                  {t("onboarding.done.startMeeting")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-start justify-between border-t px-5 py-3">
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
          {/* The last step ends through its own two buttons above. */}
          {step < STEP_COUNT - 1 && (
            <div className="flex flex-col items-end gap-1">
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={nextBlocked}
                onClick={() => setStep((s) => Math.min(STEP_COUNT - 1, s + 1))}
              >
                {t("onboarding.next")}
                <ChevronRight className="size-3.5" />
              </Button>
              {nextBlocked && (
                <span className="text-[11px] text-muted-foreground">{t("onboarding.account.gate")}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Step 2: make transcription work. Signing in (official build only) is the
 * primary path — it unlocks Parley's hosted STT + LLM, and on success both
 * providers default to "parley". Bringing your own keys is the secondary path,
 * collapsed behind a disclosure in the official build and always open in the
 * OSS build, where it is the only path. The STT key is required; the LLM key
 * is optional (recording works without it, analysis doesn't).
 */
function AccountStep() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start expanded when a BYOK STT key is already there (re-running onboarding)
  // so the user sees what satisfies the gate.
  const [byokOpen, setByokOpen] = useState(
    () =>
      !CLOUD_ENABLED ||
      (settings.transcriptionProvider !== "parley" && !!sttApiKey(settings, settings.transcriptionProvider)),
  );

  const llm = PROVIDER_BY_ID[settings.llmProviders.deep];
  const stt = STT_BY_ID[settings.transcriptionProvider];

  async function doSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { signInWithGoogle } = await import("../lib/cloud/client");
      await signInWithGoogle();
      // Signed in → default to Parley's free hosted STT + LLM so the step is
      // done in one tap; the pickers below now surface "parley" too.
      patch({ llmProviders: { realtime: "parley", deep: "parley" }, transcriptionProvider: "parley" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{t("onboarding.account.title")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.account.body")}</p>

      {CLOUD_ENABLED &&
        (cloudAuth ? (
          <div className="flex items-center gap-2 rounded-lg border border-success-border bg-success px-3 py-2.5 text-sm text-success-foreground">
            <Check className="size-4 shrink-0" />
            {t("onboarding.login.signedIn")}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              className="h-9 w-fit gap-2 text-xs"
              disabled={signingIn || !isTauri()}
              onClick={() => doSignIn().catch((error) => log.error("onboarding: sign-in failed", { error: String(error) }))}
            >
              {signingIn ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              {signingIn ? t("settings.account.signingIn") : t("settings.account.signInGoogle")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("onboarding.account.freeNote")}</p>
            {error && (
              <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">
                {t("onboarding.login.failed", { error })}
              </p>
            )}
          </div>
        ))}

      {CLOUD_ENABLED && (
        <button
          type="button"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          aria-expanded={byokOpen}
          onClick={() => setByokOpen((o) => !o)}
        >
          {byokOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t("onboarding.account.byok")}
        </button>
      )}

      {byokOpen && (
        <div className="flex flex-col gap-4 rounded-lg border bg-muted/10 px-3 py-3">
          {/* Transcription — required: it is what the gate checks. */}
          <div className="flex flex-col gap-2">
            <FieldLabel label={t("onboarding.stt.provider")} tag={t("onboarding.account.required")} />
            <Select
              value={settings.transcriptionProvider}
              onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Hosted "parley" STT (relayed to Soniox) shows only in the
                    official build once signed in. */}
                {STT_PROVIDERS.filter((p) => p.id !== "parley" || (CLOUD_ENABLED && !!cloudAuth)).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <img src={p.icon} alt="" className="size-4 rounded-sm" />
                      {p.label}
                      {!p.diarization && (
                        <span className="rounded bg-warning px-1.5 py-px text-[10px] text-warning-foreground">
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
          </div>

          {/* AI model — optional: recording works without it. */}
          <div className="flex flex-col gap-2">
            <FieldLabel label={t("onboarding.llm.provider")} tag={t("onboarding.account.optional")} />
            <Select
              value={settings.llmProviders.deep}
              onValueChange={(v) =>
                // Onboarding keeps it simple: one pick drives both lanes; the
                // per-workload split lives in Settings.
                patch({ llmProviders: { realtime: v as LlmProvider, deep: v as LlmProvider } })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* The hosted "parley" provider needs a signed-in cloud session:
                    offer it only in the official build once signed in (mirrors
                    the Settings gate). */}
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
            {/* A self-hosted endpoint needs its URL and a model id, and its key
                is optional — so the keyless copy ("Ollama needs no key") would
                be actively misleading here. Ask for the two things that are
                actually required instead. */}
            {llm.userSuppliedBaseUrl ? (
              <div className="flex flex-col gap-2">
                <Input
                  value={settings.customBaseUrl}
                  onChange={(e) => patch({ customBaseUrl: e.target.value })}
                  placeholder="http://localhost:8000/v1"
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Input
                  value={settings.models[llm.id].deep}
                  onChange={(e) =>
                    patch({
                      models: {
                        ...settings.models,
                        [llm.id]: { realtime: e.target.value, deep: e.target.value },
                      },
                    })
                  }
                  placeholder={t("settings.provider.serverModelPlaceholder")}
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <PasswordInput
                  autoComplete="off"
                  placeholder={t("settings.provider.apiKeyOptional")}
                  value={settings.customApiKey}
                  onChange={(e) => patch({ customApiKey: e.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("onboarding.llm.customHint")} {t("settings.provider.baseUrlHint")}
                </p>
              </div>
            ) : (
              <LlmKeyField llm={llm} settings={settings} patch={patch} />
            )}
            <p className="text-[11px] text-muted-foreground">{t("onboarding.account.llmLater")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ label, tag }: Readonly<{ label: string; tag: string }>) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      <span className="rounded bg-muted px-1.5 py-px text-[10px] font-normal">{tag}</span>
    </span>
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
        <span className="flex items-center gap-1 text-xs text-success-foreground">
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
 * The credential half of the LLM step for a provider with a fixed endpoint:
 * the "no key needed" note for keyless providers, otherwise the key field.
 * (The self-hosted provider has its own block — it needs a URL and a model,
 * and its key is optional.)
 */
function LlmKeyField({
  llm,
  settings,
  patch,
}: Readonly<{
  llm: ProviderInfo;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}>) {
  const { t } = useI18n();
  if (llm.requiresKey === false) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {llm.id === "parley" ? t("onboarding.login.signedIn") : t("onboarding.llm.noKey")}
      </p>
    );
  }
  return (
    <PasswordInput
      autoComplete="off"
      placeholder={llm.keyPlaceholder}
      value={settings[llm.apiKeyField]}
      onChange={(e) => patch({ [llm.apiKeyField]: e.target.value } as Partial<Settings>)}
    />
  );
}
