import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Cpu, Globe, Loader2, LogIn, Mic, UserRoundCheck, UsersRound, Volume2 } from "lucide-react";
import { useStore } from "../lib/store";
import { isMac, isWindows } from "../lib/platform";
import { isTauri } from "../lib/tauriEvents";
import { CLOUD_ENABLED } from "../lib/flags";
import { isProviderListed } from "../lib/providerListing";
import { log } from "../lib/log";
import { PROVIDERS, PROVIDER_BY_ID, type ProviderInfo } from "../lib/ai/providers";
import {
  STT_PROVIDERS,
  STT_BY_ID,
  sttApiKey,
  sttLabel,
  usesCloudSession,
  usesLocalModel,
} from "../lib/transcription/providers";
import { accountGateBlock, transcriptionReady, type AccountGateBlock } from "../lib/onboarding/accountGate";
import { useLocalSttModels, type LocalSttModelsState } from "../lib/transcription/useLocalSttModels";
import { LocalSttModelPicker } from "./LocalSttModelPicker";
import { SttCredentialField } from "./SttCredentialField";
import type { TranslationKey } from "../i18n/messages";
import { beginMeeting } from "../lib/meeting/start";
import { loadSampleRecording } from "../lib/onboarding/sample";
import { openRecording } from "./home/GettingStarted";
import { TranscribingPulse, useTranscribingPulse } from "./onboarding/TranscribingPulse";
import { IntroHero, IntroStage } from "./onboarding/IntroStage";
import { ConfirmCard } from "./onboarding/ConfirmCard";
import { ChoiceCard, OrDivider, SelectCard } from "./onboarding/ChoiceCard";
import { checkModelKeys, type KeyProblems } from "../lib/onboarding/keyCheck";
import { OrgStep } from "./onboarding/OrgStep";
import { MicStep } from "./onboarding/MicStep";
import { ContextStep } from "./onboarding/ContextStep";
import { mergeTerms, type AddedTerm } from "../lib/onboarding/micCheck";
import { useI18n, LANGUAGE_OPTIONS } from "../i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LlmProvider, Settings, SttProviderId } from "../lib/types";
import * as ipc from "../lib/ipc/commands";

// systemAudio: unknown | granted | denied | unsupported (macOS < 14.2).
type Perms = ipc.Permissions;

type StepId = "intro" | "account" | "org" | "model" | "perms" | "mic" | "context" | "done";

// One job per step: say what Parley is, sign in, settle the organization, make
// transcription actually work, get the OS permissions, check the mic, tell the
// AI who the user is, then hand off to a first real run. Teaching the rest of
// the app lives in the Home checklist, not here.
//
// Not every step shows for everyone: the OSS build has no account (so no
// sign-in and no organizations), and the organization step needs a session.
// `onboardingStepId` persists the step by id, so a resumed wizard lands on the
// same step even when the visible list has changed.
//
// The perms step runs on both platforms: macOS walks the TCC prompts; Windows
// has no runtime prompt, but the step is still the only place that shows
// whether the mic is actually allowed (the backend reads the consent store) and
// sends the user to the exact pane that flips it (ms-settings:privacy-microphone).
const ALL_STEPS: StepId[] = ["intro", "account", "org", "model", "perms", "mic", "context", "done"];

/** Each step's title, shown in the header (the welcome screen has its own). */
function stepTitle(step: StepId): TranslationKey {
  switch (step) {
    case "intro":
      return "onboarding.title";
    case "account":
      return "onboarding.account.title";
    case "org":
      return "onboarding.org.title";
    case "model":
      return "onboarding.model.title";
    case "perms":
      return isMac() ? "onboarding.perms.title" : "onboarding.perms.title.windows";
    case "mic":
      return "onboarding.mic.title";
    case "context":
      return "onboarding.context.title";
    case "done":
      return "onboarding.done.title";
  }
}
const MODEL_STEP = ALL_STEPS.indexOf("model");
/** The steps of the four-step wizard that `onboardingStep` indexed. */
const LEGACY_STEPS: StepId[] = ["intro", "account", "perms", "done"];

function isStepId(v: string): v is StepId {
  return (ALL_STEPS as string[]).includes(v);
}

/** Where a saved wizard resumes: the saved id, else the legacy index's step. */
function savedStep(saved: Pick<Settings, "onboardingStep" | "onboardingStepId">): StepId {
  if (isStepId(saved.onboardingStepId)) return saved.onboardingStepId;
  return LEGACY_STEPS[saved.onboardingStep] ?? "intro";
}

function visibleSteps(signedIn: boolean): StepId[] {
  return ALL_STEPS.filter((s) => {
    if (s === "account") return CLOUD_ENABLED;
    if (s === "org") return CLOUD_ENABLED && signedIn;
    return true;
  });
}

/** Helper text under the blocked Next button, per reason (see accountGate.ts). */
const GATE_HINT: Record<AccountGateBlock, TranslationKey> = {
  credential: "onboarding.model.gate",
  localDownload: "localStt.gate.download",
  localDownloading: "localStt.gate.downloading",
};

export function Onboarding() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const signedIn = !!cloudAuth;
  const steps = visibleSteps(signedIn);

  const [current, setCurrent] = useState<StepId>(() => {
    const { settings: saved, cloudAuth: auth } = useStore.getState();
    const shown = visibleSteps(!!auth);
    // The first visible step at or after the saved one (a step that's hidden
    // now, e.g. "org" after signing out, resumes at the one after it).
    let resumed = ALL_STEPS.slice(ALL_STEPS.indexOf(savedStep(saved))).find((s) => shown.includes(s)) ?? "intro";
    // A step past the model gate (a session that has since signed out) must
    // not resume beyond it. The local model catalog isn't loaded yet here, so
    // a "local" setup resumes at the model step (fail closed) and the user
    // confirms the downloaded model.
    if (
      ALL_STEPS.indexOf(resumed) > MODEL_STEP &&
      !transcriptionReady(saved, !!auth, { models: null, downloads: {} })
    ) {
      resumed = "model";
    }
    return resumed;
  });
  const index = Math.max(0, steps.indexOf(current));
  const [perms, setPerms] = useState<Perms | null>(null);
  // The organization step while it offers its two choices (each card has its
  // own button), when the footer steps aside.
  const [orgChoosing, setOrgChoosing] = useState(false);
  // The model step's Next checks the keys with their vendors first.
  const [checkingKeys, setCheckingKeys] = useState(false);
  const [keyProblems, setKeyProblems] = useState<KeyProblems>({});
  // The model step's choice, kept here so it survives Back/Next: signed in,
  // Parley's hosted models are the default unless the user picks their own.
  const [ownModels, setOwnModels] = useState(false);
  // The dictionary terms this wizard found (names from the self-introduction
  // and the AI memory, the user's name and company, ones typed on the context
  // step), listed there so they can be taken back out.
  const [addedTerms, setAddedTerms] = useState<AddedTerm[]>([]);
  // The providers in place before the model step switched them to Parley's,
  // so "Use my own models" puts them back.
  const beforeHosted = useRef<Pick<Settings, "transcriptionProvider" | "llmProviders"> | null>(null);

  // Persist the step so granting a permission (which often needs an app restart)
  // resumes here instead of bouncing back to step 1.
  useEffect(() => {
    patch({ onboardingStepId: current });
  }, [current, patch]);

  // Signing out mid-wizard hides the org step; don't strand the user on it.
  useEffect(() => {
    if (!visibleSteps(signedIn).includes(current)) setCurrent("model");
  }, [signedIn, current]);

  // On-device catalog + download state, live only while "local" is selected;
  // owned here (not in ModelStep) because it feeds the gate below.
  const local = useLocalSttModels(usesLocalModel(settings.transcriptionProvider));
  const gateBlock = accountGateBlock(settings, !!cloudAuth, local);
  const ready = gateBlock === null;
  // Neither Next on the model step nor the welcome screen's Skip may get past the gate:
  // skipping used to land users in a mock recorder that played a fake
  // transcript and saved nothing, so the first meeting silently failed.
  const nextBlocked = current === "model" && !ready;
  const skipBlocked = !ready;

  function goTo(step: StepId) {
    setCurrent(step);
  }

  function next() {
    goTo(steps[Math.min(steps.length - 1, index + 1)]);
  }

  // Leaving the model step: a key the vendor refuses keeps the user here, with
  // the reason under that field, instead of a first meeting that never
  // transcribes. Any edit to the providers or keys clears the old verdict.
  async function nextFromModel() {
    setCheckingKeys(true);
    try {
      const problems = await checkModelKeys(useStore.getState().settings);
      setKeyProblems(problems);
      if (!problems.stt && !problems.llm) next();
    } finally {
      setCheckingKeys(false);
    }
  }
  const keyInputs = [
    settings.transcriptionProvider,
    sttApiKey(settings, settings.transcriptionProvider),
    settings.llmProviders.deep,
    settings[PROVIDER_BY_ID[settings.llmProviders.deep].apiKeyField],
    settings.customBaseUrl,
  ].join("\u0000");
  useEffect(() => {
    setKeyProblems({});
  }, [keyInputs]);

  async function recheck() {
    if (!isTauri()) return;
    try {
      // Side-effect free: check_permissions never triggers an OS prompt, so
      // polling it below is safe.
      setPerms(await ipc.checkPermissions());
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
    if (current !== "perms") return;
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
  }, [current]);

  function finish() {
    patch({ onboarded: true, onboardingStep: 0, onboardingStepId: "" });
  }

  // The wizard stays up through the transcribing beat, so the button the user
  // pressed turns into the progress bar; it closes as the report opens.
  const samplePulse = useTranscribingPulse();
  async function walkThroughSample() {
    const id = await samplePulse.run(loadSampleRecording);
    finish();
    if (id) {
      await openRecording(id, "report");
    } else {
      log.warn("onboarding: sample recording unavailable");
    }
  }

  const micOk = perms?.microphone === "authorized";
  const systemAudioOk = perms?.systemAudio === "granted";
  const intro = current === "intro";
  // Signed out, the sign-in step is a choice between two cards, each with its
  // own button, and Back sits under them, so it has no footer; nor does the
  // organization step while it offers its two cards. Signed in, the sign-in
  // step confirms the account; from there the rest of setup is optional, so
  // its footer is the welcome screen's: Skip, or Start the rest.
  const account = current === "account";
  const showFooter = current !== "done" && !(account && !cloudAuth) && !(current === "org" && orgChoosing);
  const skipFooter = intro || (account && !!cloudAuth);
  const nextLabel = skipFooter ? t("onboarding.start") : t("onboarding.next");
  const skipTitle = skipBlocked && gateBlock ? t(GATE_HINT[gateBlock]) : t("onboarding.skip");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div
        className={cn(
          // One size for every step, so the dialog never jumps between them;
          // a short window gets all the height it has, and a long step scrolls.
          "relative flex h-[580px] max-h-[calc(100vh-3rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl shadow-2xl",
          intro ? "bg-(--ob-hero-bg) [--ob-hero-bg:#f5f5f5] dark:[--ob-hero-bg:var(--muted)]" : "bg-background",
        )}
      >
        {/* The welcome screen has no title bar: a hero, its title in the body,
            and only the language in the corner. Skip moves to the footer. */}
        {intro ? (
          <>
            <IntroHero />
            <div className="relative flex h-15 shrink-0 items-center justify-end px-5">
              <LanguageMenu onHero />
            </div>
          </>
        ) : (
          // Every later step: its own title, the language, and a progress bar
          // along the bottom edge — one segment per step after the welcome.
          <div className="relative flex h-15 shrink-0 items-center justify-between px-5">
            <h2 className="text-sm font-semibold text-primary">{t(stepTitle(current))}</h2>
            <LanguageMenu />
            <StepProgress reached={index} total={steps.length - 1} />
          </div>
        )}

        {/* Body */}
        <div
          className={cn(
            "relative min-h-0 flex-1 overflow-y-auto",
            intro ? "px-6 pt-[63px] pb-16" : "px-5 py-5",
            // The two sign-in cards fill whatever height there is; it only
            // scrolls if a minimum-size window can't hold their text.
            // Column, so a step's card can fill the dialog's height.
            "flex flex-col",
          )}
        >
          {intro && (
            <div className="flex flex-col gap-9">
              <h2 className="text-center text-2xl leading-[1.2] font-semibold">{t("onboarding.intro.welcome")}</h2>
              {/* The UI assembles itself: pill, transcript, folder, plug —
                  one caption per beat. "Both sides of the conversation" holds
                  on both desktop platforms (macOS process tap, Windows WASAPI
                  loopback), so the captions are the same everywhere. */}
              <IntroStage />
            </div>
          )}

          {current === "account" && (
            <AccountStep
              onBack={() => goTo(steps[index - 1])}
              onContinue={next}
            />
          )}

          {current === "org" && (
            <OrgStep onNext={next} onBack={() => goTo(steps[index - 1])} setChoosing={setOrgChoosing} />
          )}

          {current === "model" && (
            <ModelStep
              local={local}
              own={ownModels}
              setOwn={setOwnModels}
              beforeHosted={beforeHosted}
              keyProblems={keyProblems}
            />
          )}

          {current === "perms" && (
            <div className="flex flex-col gap-6">
              {/* Windows says something different: it asks consent for the
                  microphone alone, and its system-audio row is checked without
                  the user doing anything (loopback capture needs no grant). */}
              <p className="text-sm leading-relaxed text-[#333] dark:text-foreground">
                {t(isMac() ? "onboarding.perms.body" : "onboarding.perms.body.windows")}
              </p>

              {/* No re-check button: the step polls (focus, visibility, every
                  2 s), so a grant shows up on its own. */}
              <div className="flex flex-col gap-3">
                <PermRow
                  icon={<Mic className="size-4" />}
                  label={t("onboarding.perms.mic")}
                  art="top-[37px] left-[-52px] h-[116.52px] w-[774.18px]"
                  ok={micOk}
                  actionLabel={t(isMac() ? "onboarding.perms.grant" : "settings.permissions.openSettings")}
                  onAction={async () => {
                    // Not yet determined → the native prompt is enough; only jump
                    // to System Settings when it was explicitly denied (the OS
                    // won't re-prompt in that case). Windows never prompts at all
                    // — request_microphone() is a stub there — so its only useful
                    // click is the deep link into the privacy pane.
                    if (!isMac() || perms?.microphone === "denied") {
                      await ipc.openPrivacySettings({ pane: "microphone" }).catch((error) =>
                        log.warn("permissions: open microphone settings failed", { error: String(error) }),
                      );
                    } else {
                      await ipc.requestMicrophone().catch((error) =>
                        log.warn("permissions: microphone request failed", { error: String(error) }),
                      );
                    }
                    await recheck();
                  }}
                />
                {/* macOS shows the row only where the tap exists (< 14.2
                    reports unsupported). Windows always has it: loopback needs
                    no consent, so the row is a ✓ whenever there is an output
                    device to capture, and otherwise a link to Sound settings. */}
                {((isMac() && perms?.systemAudio !== "unsupported") || isWindows()) && (
                  <PermRow
                    icon={<Volume2 className="size-4" />}
                    art="top-[-47px] left-[-55px] h-[116.52px] w-[774.18px]"
                    label={t(isMac() ? "onboarding.perms.systemAudio" : "onboarding.perms.systemAudio.windows")}
                    ok={systemAudioOk}
                    actionLabel={t(isMac() ? "onboarding.perms.grant" : "settings.permissions.openSettings")}
                    onAction={async () => {
                      // macOS: probes a real Core Audio process tap; the first
                      // probe shows the "record system audio" consent prompt.
                      // Windows: only checks for a default output device, and
                      // when there is none the fix lives in Sound settings.
                      const s = await ipc.probeSystemAudio().catch(() => null);
                      if (s === "denied" || (!isMac() && s !== "granted")) {
                        await ipc.openPrivacySettings({ pane: "system-audio" }).catch((error) =>
                          log.warn("permissions: open system-audio settings failed", { error: String(error) }),
                        );
                      }
                      await recheck();
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {current === "mic" && <MicStep onTermsAdded={(terms) => setAddedTerms((prev) => mergeTerms(prev, terms))} />}

          {current === "context" && <ContextStep terms={addedTerms} setTerms={setAddedTerms} />}

          {current === "done" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-success text-success-foreground">
                <Check className="size-6" />
              </div>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("onboarding.done.body")}</p>
              <div className="mt-2 flex flex-col items-center gap-2">
                {samplePulse.active ? (
                  <TranscribingPulse className="h-9" />
                ) : (
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
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={samplePulse.active}
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

        {/* Footer nav — the last step ends through its own two buttons above. */}
        {showFooter && (
          <div className="relative flex items-start justify-between border-t px-5 py-4">
            {/* The welcome screen and the signed-in confirmation offer Skip
                where Back would be. */}
            {skipFooter && (
              <span title={skipTitle}>
                <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={skipBlocked} onClick={finish}>
                  {t("onboarding.skip")}
                </Button>
              </span>
            )}
            {!skipFooter && index > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => goTo(steps[index - 1])}
              >
                <ChevronLeft className="size-3.5" />
                {t("onboarding.back")}
              </Button>
            )}
            <div className="flex flex-col items-end gap-1">
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={nextBlocked || checkingKeys}
                onClick={() => {
                  if (current === "model") {
                    nextFromModel().catch((error) => log.error("onboarding: key check failed", { error: String(error) }));
                  } else {
                    next();
                  }
                }}
              >
                {checkingKeys && <Loader2 className="size-3.5 animate-spin" />}
                {nextLabel}
                <ChevronRight className="size-3.5" />
              </Button>
              {/* A missing key needs no line here: the field is marked
                  required right above. A local model still downloading
                  does — nothing above says Next waits for it. */}
              {nextBlocked && gateBlock && gateBlock !== "credential" && (
                <span className="text-[11px] text-muted-foreground">{t(GATE_HINT[gateBlock])}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The UI language, from any step: it also sets the report language. */
function LanguageMenu({ onHero = false }: Readonly<{ onHero?: boolean }>) {
  const { t } = useI18n();
  const language = useStore((s) => s.settings.language);
  const patch = useStore((s) => s.updateSettings);
  const option = LANGUAGE_OPTIONS.find((l) => l.value === language);
  const currentLabel = option?.nativeLabel ?? language;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Short label, no chrome; white over the welcome hero. */}
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 gap-1.5 px-2 text-xs", onHero && "text-white hover:bg-white/15 hover:text-white")}
          aria-label={`${t("onboarding.language.label")}: ${currentLabel}`}
        >
          <Globe className="size-3.5" />
          {option?.shortLabel ?? language}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {LANGUAGE_OPTIONS.map((lang) => (
          <DropdownMenuItem key={lang.value} onSelect={() => patch({ language: lang.value })}>
            <span className="flex-1">{lang.nativeLabel}</span>
            {language === lang.value && <Check className="size-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("onboarding.language.note")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Sign in (official build only). It unlocks Parley's hosted STT + LLM, and on
 * success both providers default to "parley" and the wizard moves on to the
 * organization step. Not signing in is the footer's Next, relabelled.
 */
function AccountStep({ onBack, onContinue }: Readonly<{ onBack: () => void; onContinue: () => void }>) {
  const { t } = useI18n();
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browser sign-in can finish long after the click, by which time the
  // user may have carried on without it and picked their own models.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function doSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { signInWithGoogle } = await import("../lib/cloud/client");
      await signInWithGoogle();
      // Still here → default to Parley's free hosted STT + LLM so the model
      // step is already done (it can still be switched there); the step then
      // shows the signed-in confirmation. Gone → the session counts, but
      // their choices and position stand.
      if (!mounted.current) return;
      patch({ llmProviders: { realtime: "parley", deep: "parley" }, transcriptionProvider: "parley" });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setSigningIn(false);
    }
  }

  if (cloudAuth) {
    return (
      <ConfirmCard
        pills={[{ key: "email", icon: <UserRoundCheck className="size-3.5" />, label: cloudAuth.user.email }]}
        title={t("onboarding.account.member.unlocked")}
        body={t("onboarding.account.member.allowance")}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <ChoiceCard
        primary
        fill
        icon={<UserRoundCheck className="size-3.5" />}
        label={t("onboarding.account.member.tag")}
        art={{ src: "/onboarding/signin-member-lines.svg", className: "top-0 left-[-444px] h-[200px] w-[967px]" }}
        action={
          <div className="flex flex-col items-end">
            <Button
              size="sm"
              className="h-8 gap-2 px-2.5 text-xs"
              disabled={signingIn || !isTauri()}
              onClick={() => doSignIn().catch((error) => log.error("onboarding: sign-in failed", { error: String(error) }))}
            >
              {signingIn ? t("settings.account.signingIn") : t("onboarding.account.member.cta")}
              {signingIn ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            </Button>
            {error && (
              // Plain red text in the card's bottom padding, so a failure never
              // changes the card's height.
              <p className="absolute top-full right-0 mt-1 w-max max-w-[480px] text-right text-[11px] text-danger-foreground">
                {t("onboarding.login.failed", { error })}
              </p>
            )}
          </div>
        }
      >
        <p className="text-sm leading-relaxed">{t("onboarding.account.body")}</p>
      </ChoiceCard>

      <OrDivider label={t("onboarding.account.or")} />

      <ChoiceCard
        fill
        icon={<UsersRound className="size-3.5" />}
        label={t("onboarding.account.guest.tag")}
        art={{ src: "/onboarding/signin-guest-lines.svg", className: "top-[38px] left-0 h-[116.52px] w-[774.18px]" }}
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-2 bg-background px-2.5 text-xs hover:bg-background/80"
            onClick={onContinue}
          >
            {t("onboarding.account.guest.cta")}
            <ChevronRight className="size-3.5" />
          </Button>
        }
      >
        <p className="text-sm leading-relaxed">{t("onboarding.account.guest.body")}</p>
      </ChoiceCard>

      <Button variant="ghost" size="sm" className="h-8 gap-1 self-start px-2.5 text-xs" onClick={onBack}>
        <ChevronLeft className="size-3.5" />
        {t("onboarding.back")}
      </Button>
    </div>
  );
}

/**
 * The steps after the welcome screen as segments along the header's bottom
 * edge, filled up to and including the current one.
 */
function StepProgress({ reached, total }: Readonly<{ reached: number; total: number }>) {
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={reached}
      aria-valuetext={`${reached} / ${total}`}
      className="absolute inset-x-0 bottom-0 flex gap-0.5"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={`segment-${i + 1}`}
          className={cn("h-px flex-1", i < reached ? "bg-primary" : "bg-[#e6e6e6] dark:bg-border")}
        />
      ))}
    </div>
  );
}

/**
 * Make transcription work. Signed in, it is a choice between Parley's hosted
 * models (already selected by sign-in) and the user's own; otherwise (not
 * signed in, or the OSS build) the provider pickers are the whole step. The STT
 * provider is required — it is what the gate checks; the LLM is optional
 * (recording works without it, analysis doesn't).
 */
function ModelStep({
  local,
  own,
  setOwn,
  beforeHosted,
  keyProblems,
}: Readonly<{
  local: LocalSttModelsState;
  /** The user picked "Bring your own models" in this wizard. */
  own: boolean;
  setOwn: (own: boolean) => void;
  beforeHosted: React.MutableRefObject<Pick<Settings, "transcriptionProvider" | "llmProviders"> | null>;
  /** What Next's key check found wrong, shown under the field it is about. */
  keyProblems: KeyProblems;
}>) {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const signedIn = CLOUD_ENABLED && !!cloudAuth;
  const listing = { cloudEnabled: CLOUD_ENABLED, signedIn: !!cloudAuth };
  const showProviders = !signedIn || own;

  const llm = PROVIDER_BY_ID[settings.llmProviders.deep];
  const stt = STT_BY_ID[settings.transcriptionProvider];

  function applyHosted() {
    const current = useStore.getState().settings;
    const onHosted =
      usesCloudSession(current.transcriptionProvider) &&
      current.llmProviders.realtime === "parley" &&
      current.llmProviders.deep === "parley";
    if (onHosted) return;
    beforeHosted.current ??= {
      transcriptionProvider: current.transcriptionProvider,
      llmProviders: current.llmProviders,
    };
    patch({ llmProviders: { realtime: "parley", deep: "parley" }, transcriptionProvider: "parley" });
  }

  // Signed in → Parley's hosted models are filled in, however the session came
  // about (signed in on the previous step, a session kept from before, or a
  // sign-in that finished after the user had moved on), unless the user has
  // picked their own models in this wizard.
  useEffect(() => {
    if (signedIn && !own) applyHosted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  function pickHosted() {
    setOwn(false);
    applyHosted();
  }

  function pickOwn() {
    setOwn(true);
    // Put back what was there before Parley's models were filled in; failing
    // that, leave the hosted STT for the first bring-your-own provider. The
    // hosted LLM may stay — it's a separate, optional choice below.
    const saved = beforeHosted.current;
    beforeHosted.current = null;
    if (saved && !usesCloudSession(saved.transcriptionProvider)) {
      patch(saved);
    } else if (usesCloudSession(useStore.getState().settings.transcriptionProvider)) {
      const first = STT_PROVIDERS.find((p) => !usesCloudSession(p.id) && isProviderListed(p, listing));
      if (first) patch({ transcriptionProvider: first.id });
    }
  }

  const problem = (p: KeyProblems[keyof KeyProblems]) =>
    p && <p className="text-[11px] text-danger-foreground">{t(p.key, p.vars)}</p>;

  return (
    // Signed in it is a choice between the two cards; otherwise only the
    // bring-your-own card shows, already open.
    <div
      role={signedIn ? "radiogroup" : undefined}
      aria-label={signedIn ? t("onboarding.model.title") : undefined}
      className="flex flex-col gap-6"
    >
      {signedIn && (
        <SelectCard
          primary
          selected={!own}
          onSelect={pickHosted}
          icon={<img src="/onboarding/parley-mark.svg" alt="" className="h-3.5 w-auto" />}
          label={t("onboarding.model.hosted")}
          note={t("onboarding.model.hostedNote")}
          art={{ src: "/onboarding/signin-member-lines.svg", className: "top-[-67px] left-[-444px] h-[200px] w-[967px]" }}
        />
      )}
      <SelectCard
        selected={showProviders}
        onSelect={signedIn ? pickOwn : undefined}
        icon={<Cpu className="size-3.5" />}
        label={t("onboarding.model.own")}
        note={t("onboarding.model.ownNote")}
        art={{ src: "/onboarding/org-solo-lines.svg", className: "top-[38px] left-0 h-[116.52px] w-[774.18px]" }}
      >
      {showProviders && (
        <>
          {/* Transcription — required: it is what the gate checks. */}
          <div className="flex flex-col gap-2 rounded-[10px] bg-white/50 p-3 dark:bg-white/5">
            <FieldLabel label={t("onboarding.stt.provider")} tag={t("onboarding.account.required")} />
            <Select
              value={settings.transcriptionProvider}
              onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* "Own models" means not Parley's hosted STT — that is the
                    other choice above. */}
                {STT_PROVIDERS.filter((p) => isProviderListed(p, listing) && !usesCloudSession(p.id)).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <img src={p.icon} alt="" className="size-4 rounded-sm" />
                      {sttLabel(t, p)}
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
            {/* On-device: no key — pick a model, then download it; the gate
                holds Next until the download has finished. (The "no
                diarization" tag on the Select item already flags that live
                meetings won't separate speakers.) */}
            <SttCredentialField
              info={stt}
              settings={settings}
              patch={patch}
              cloudSessionNote={<p className="text-[11px] text-muted-foreground">{t("onboarding.login.signedIn")}</p>}
              localModelPicker={
                <LocalSttModelPicker
                  value={settings.localSttModel}
                  onChange={(id) => patch({ localSttModel: id, localSttModelChosen: true })}
                  local={local}
                  chosen={settings.localSttModelChosen}
                  onAutoSelect={(id) => patch({ localSttModel: id })}
                />
              }
            />
            {problem(keyProblems.stt)}
          </div>

          {/* AI model — optional: recording works without it. */}
          <div className="flex flex-col gap-2 rounded-[10px] bg-white/50 p-3 dark:bg-white/5">
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
                {PROVIDERS.filter((p) => isProviderListed(p, listing)).map((p) => (
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
            {problem(keyProblems.llm)}
            <p className="text-[11px] text-muted-foreground">{t("onboarding.account.llmLater")}</p>
          </div>
        </>
      )}
      </SelectCard>
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

/** One permission as a card, from the Figma permissions frame; `art` places its line art. */
function PermRow({
  icon,
  label,
  ok,
  actionLabel,
  onAction,
  art,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  actionLabel: string;
  onAction: () => void;
  art: string;
}>) {
  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-[8px] border border-[#e3e6ec] bg-[#f5f7f9]/20 p-5 text-[#333] dark:border-border dark:bg-muted/20 dark:text-foreground">
      <div aria-hidden className={cn("pointer-events-none absolute", art)}>
        <img src="/onboarding/org-solo-lines.svg" alt="" className="size-full max-w-none" />
      </div>
      <span className="relative">{icon}</span>
      <span className="relative flex-1 text-sm">{label}</span>
      {ok ? (
        <span className="relative flex items-center gap-1 text-xs text-success-foreground">
          <Check className="size-3.5" />
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="relative h-auto rounded-[8px] border-[#e3e6ec] bg-background px-3 py-1.5 text-[11px] text-[#333] dark:border-border dark:text-foreground"
          onClick={onAction}
        >
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
        {llm.requiresAccount ? t("onboarding.login.signedIn") : t("onboarding.llm.noKey")}
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
