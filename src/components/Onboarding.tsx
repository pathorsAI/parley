import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Cloud, Cpu, Globe, Laptop, Loader2, LogIn, Mic, UserRoundCheck, Volume2 } from "lucide-react";
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
import { footerFor, gateStep, isStranded, resumeStep, savedStep, visibleSteps, type StepId } from "../lib/onboarding/steps";
import { cloudRoutePatch, isHostedLlm, localRoutePatch, onHostedProviders } from "../lib/onboarding/setupMode";
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
import { DoneScribbles } from "./onboarding/DoneScribbles";
import { ChoiceCard, OrDivider, SelectCard } from "./onboarding/ChoiceCard";
import { FieldLabel, FieldPanel } from "./FormSection";
import { checkModelKeys, type KeyProblems } from "../lib/onboarding/keyCheck";
import { OrgStep } from "./onboarding/OrgStep";
import { MicStep } from "./onboarding/MicStep";
import { ContextStep } from "./onboarding/ContextStep";
import { mergeTerms, type AddedTerm, type MicRun } from "../lib/onboarding/micCheck";
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

// The steps, which of them show on each route (Cloud: no model step; Local: no
// org step; OSS: Local without the account step) and where a saved wizard
// resumes live in lib/onboarding/steps.ts, pure and unit-tested.
// `onboardingStepId` persists the step by id, so a resumed wizard lands on the
// same step even when the visible list has changed.
//
// The perms step runs on both platforms: macOS walks the TCC prompts; Windows
// has no runtime prompt, but the step is still the only place that shows
// whether the mic is actually allowed (the backend reads the consent store) and
// sends the user to the exact pane that flips it (ms-settings:privacy-microphone).

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
  // The route (Cloud / Local) decides which steps show; it is picked on the
  // account step, and a fresh install starts local until then.
  const mode = settings.setupMode;
  const steps = visibleSteps(mode, signedIn, CLOUD_ENABLED);
  // Where the transcription gate sits on this route: Cloud's is signing in on
  // the account step, Local's the provider pickers on the model step.
  const gate = gateStep(mode, CLOUD_ENABLED);

  const [current, setCurrent] = useState<StepId>(() => {
    const { settings: saved, cloudAuth: auth } = useStore.getState();
    // Never past the gate while transcription can't run (a cloud session that
    // has since signed out lands on the account step). The local model catalog
    // isn't loaded yet here, so an on-device setup reads as not ready and
    // resumes on the model step (fail closed) to confirm the downloaded model.
    return resumeStep(savedStep(saved), {
      mode: saved.setupMode,
      signedIn: !!auth,
      cloudEnabled: CLOUD_ENABLED,
      ready: transcriptionReady(saved, !!auth, { models: null, downloads: {} }),
    });
  });
  const index = Math.max(0, steps.indexOf(current));
  const [perms, setPerms] = useState<Perms | null>(null);
  // The organization step while it offers its two choices (each card has its
  // own button), when the footer steps aside.
  const [orgChoosing, setOrgChoosing] = useState(false);
  // The model step's Next checks the keys with their vendors first.
  const [checkingKeys, setCheckingKeys] = useState(false);
  const [keyProblems, setKeyProblems] = useState<KeyProblems>({});
  // The dictionary terms this wizard found (names from the self-introduction
  // and the AI memory, the user's name and company, ones typed on the context
  // step), listed there so they can be taken back out.
  const [addedTerms, setAddedTerms] = useState<AddedTerm[]>([]);
  // What the last microphone check added, so testing again replaces it.
  const micRun = useRef<MicRun | null>(null);

  // Persist the step so granting a permission (which often needs an app restart)
  // resumes here instead of bouncing back to step 1.
  useEffect(() => {
    patch({ onboardingStepId: current });
  }, [current, patch]);

  // Don't strand the user on a step that no longer shows, or past the account
  // step on Cloud once signed out: both land on this route's gate (isStranded).
  const strandedOn = isStranded(current, { steps, gate, signedIn });
  useEffect(() => {
    if (strandedOn) setCurrent(gate);
  }, [strandedOn, gate]);

  // On-device catalog + download state, live only while "local" is selected;
  // owned here (not in ModelStep) because it feeds the gate below.
  const local = useLocalSttModels(usesLocalModel(settings.transcriptionProvider));
  const gateBlock = accountGateBlock(settings, !!cloudAuth, local);
  const ready = gateBlock === null;
  // Neither Next on the gate step nor the welcome screen's Skip may get past
  // the gate: skipping used to land users in a mock recorder that played a
  // fake transcript and saved nothing, so the first meeting silently failed.
  const nextBlocked = current === gate && !ready;
  const skipBlocked = !ready;

  function goTo(step: StepId) {
    setCurrent(step);
  }

  // Read the route fresh from the store: picking Cloud or Local on the account
  // step patches it in the same click that moves on, before this render's
  // `steps` has caught up.
  function next() {
    const { settings: now, cloudAuth: auth } = useStore.getState();
    const shown = visibleSteps(now.setupMode, !!auth, CLOUD_ENABLED);
    const at = Math.max(0, shown.indexOf(current));
    goTo(shown[Math.min(shown.length - 1, at + 1)]);
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
      await openRecording(id, "summary");
    } else {
      log.warn("onboarding: sample recording unavailable");
    }
  }

  const micOk = perms?.microphone === "authorized";
  const systemAudioOk = perms?.systemAudio === "granted";
  const intro = current === "intro";
  // The first and last screens share the hero look: blue bars, no title bar,
  // only the language in the corner.
  const hero = intro || current === "done";
  // Which footer this step gets (footerFor explains the cases).
  const cloudConfirmed = mode === "cloud" && signedIn;
  const footer = footerFor(current, { cloudConfirmed, orgChoosing });
  const showFooter = footer.show;
  const skipFooter = footer.skip;
  const nextLabel = skipFooter ? t("onboarding.start") : t("onboarding.next");
  const skipTitle = skipBlocked && gateBlock ? t(GATE_HINT[gateBlock]) : t("onboarding.skip");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div
        className={cn(
          // One size for every step, so the dialog never jumps between them;
          // a short window gets all the height it has, and a long step scrolls.
          "relative flex h-[580px] max-h-[calc(100vh-3rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl shadow-2xl",
          hero ? "bg-(--ob-hero-bg) [--ob-hero-bg:#f5f5f5] dark:[--ob-hero-bg:var(--muted)]" : "bg-background",
        )}
      >
        {/* The welcome screen has no title bar: a hero, its title in the body,
            and only the language in the corner. Skip moves to the footer. */}
        {hero ? (
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
            intro && "px-6 pt-[63px] pb-16",
            current === "done" && "items-center justify-center px-6 pb-16",
            !hero && "px-5 py-5",
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
            <ModelStep local={local} keyProblems={keyProblems} />
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

          {current === "mic" && (
            <MicStep
              onTermsAdded={(terms) => setAddedTerms((prev) => mergeTerms(prev, terms))}
              onTermsRemoved={(ids) => setAddedTerms((prev) => prev.filter((term) => !ids.includes(term.id)))}
              lastRun={micRun}
            />
          )}

          {current === "context" && <ContextStep terms={addedTerms} setTerms={setAddedTerms} />}

          {current === "done" && (
            <div className="flex flex-col items-center gap-9 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#d9f7e5] text-[#006a3b] dark:bg-success dark:text-success-foreground">
                <Check className="size-6" />
              </div>
              <div className="flex flex-col items-center gap-5">
                <h2 className="text-2xl leading-[1.2] font-semibold">{t("onboarding.done.title")}</h2>
                <p className="relative text-sm leading-[1.4] whitespace-nowrap text-[#333] dark:text-foreground">
                  <span className="font-medium">{t("onboarding.done.lead")}</span>
                  <br />
                  {t("onboarding.done.body")}
                  <DoneScribbles />
                </p>
              </div>
              <div className="flex items-center justify-center gap-6">
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
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={samplePulse.active}
                  onClick={() =>
                    walkThroughSample().catch((error) =>
                      log.error("onboarding: sample walkthrough failed", { error: String(error) }),
                    )
                  }
                >
                  {t("onboarding.done.sample")}
                </Button>
              </div>
              {/* The transcribing beat sits under the buttons, in a slot that is
                  always there: the buttons never move when it shows. */}
              <div className="-mt-6 flex h-8 items-center justify-center">
                {samplePulse.active && <TranscribingPulse className="ob-fade-in" />}
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
 * The route choice (official build only): Cloud or Local.
 *
 * - Cloud signs in here. On success it sets the route and Parley's hosted
 *   transcription + AI, and the step turns into the signed-in confirmation;
 *   the cloud route has no model step, so that is the whole setup of models.
 * - Local sets the route (moving anything hosted off Parley, see
 *   localRoutePatch) and moves on to the model step.
 *
 * Already signed in (a session kept from before, or Back from the Local
 * route), the Cloud card needs no new sign-in: it just takes the route.
 */
function AccountStep({ onBack, onContinue }: Readonly<{ onBack: () => void; onContinue: () => void }>) {
  const { t } = useI18n();
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const mode = useStore((s) => s.settings.setupMode);
  const onHosted = useStore((s) => onHostedProviders(s.settings));
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browser sign-in can finish long after the click, by which time the
  // user may have carried on without it and picked the Local route.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const confirmed = mode === "cloud" && !!cloudAuth;
  // On the cloud route and signed in, the hosted pair is the only setup: fill
  // it in if anything else crept in (e.g. a saved state that derived "cloud"
  // but was edited since), so the gate this step holds is met.
  useEffect(() => {
    if (confirmed && !onHosted) patch(cloudRoutePatch());
  }, [confirmed, onHosted, patch]);

  async function doSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { signInWithGoogle } = await import("../lib/cloud/client");
      await signInWithGoogle();
      // Still here → the cloud route on Parley's hosted STT + LLM; the step
      // then shows the signed-in confirmation. Gone → the session counts, but
      // the route they picked meanwhile stands.
      if (!mounted.current) return;
      patch(cloudRoutePatch());
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setSigningIn(false);
    }
  }

  function pickCloud() {
    if (cloudAuth) {
      patch(cloudRoutePatch());
      return;
    }
    doSignIn().catch((error) => log.error("onboarding: sign-in failed", { error: String(error) }));
  }

  function pickLocal() {
    patch(localRoutePatch(useStore.getState().settings));
    onContinue();
  }

  if (confirmed) {
    return (
      <div className="flex flex-col gap-4">
        <ConfirmCard
          pills={[{ key: "email", icon: <UserRoundCheck className="size-3.5" />, label: cloudAuth.user.email }]}
          title={t("onboarding.account.cloud.unlocked")}
          body={t("onboarding.account.cloud.allowance")}
        />
        {/* The way back to the other route: the cards are gone once signed in. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 self-start px-2.5 text-xs"
          onClick={() => patch(localRoutePatch(useStore.getState().settings))}
        >
          {t("onboarding.account.switchLocal")}
        </Button>
      </div>
    );
  }

  let cloudCta = t("onboarding.account.cloud.cta");
  if (signingIn) cloudCta = t("settings.account.signingIn");
  else if (cloudAuth) cloudCta = t("onboarding.account.cloud.use");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <ChoiceCard
        primary
        fill
        icon={<Cloud className="size-3.5" />}
        label={t("onboarding.account.cloud.tag")}
        art={{ src: "/onboarding/signin-member-lines.svg", className: "top-0 left-[-444px] h-[200px] w-[967px]" }}
        action={
          <div className="flex flex-col items-end">
            <Button
              size="sm"
              className="h-8 gap-2 px-2.5 text-xs"
              disabled={signingIn || (!cloudAuth && !isTauri())}
              onClick={pickCloud}
            >
              {cloudCta}
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
        <p className="text-sm leading-relaxed">{t("onboarding.account.cloud.body")}</p>
      </ChoiceCard>

      <OrDivider label={t("onboarding.account.or")} />

      <ChoiceCard
        fill
        icon={<Laptop className="size-3.5" />}
        label={t("onboarding.account.local.tag")}
        art={{ src: "/onboarding/signin-guest-lines.svg", className: "top-[38px] left-0 h-[116.52px] w-[774.18px]" }}
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-2 bg-background px-2.5 text-xs hover:bg-background/80"
            onClick={pickLocal}
          >
            {t("onboarding.account.local.cta")}
            <ChevronRight className="size-3.5" />
          </Button>
        }
      >
        <p className="text-sm leading-relaxed">{t("onboarding.account.local.body")}</p>
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
 * Make transcription work, on the local route (and in the OSS build, which is
 * always local): the bring-your-own panel, already open. Parley's hosted
 * models are not offered here — they are the cloud route, picked on the
 * account step. The STT provider is required — it is what the gate checks; the
 * LLM is optional (recording works without it, analysis doesn't).
 */
function ModelStep({
  local,
  keyProblems,
}: Readonly<{
  local: LocalSttModelsState;
  /** What Next's key check found wrong, shown under the field it is about. */
  keyProblems: KeyProblems;
}>) {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const listing = { cloudEnabled: CLOUD_ENABLED, signedIn: !!cloudAuth };

  const llm = PROVIDER_BY_ID[settings.llmProviders.deep];
  const stt = STT_BY_ID[settings.transcriptionProvider];

  // Nothing may silently stay hosted on the local route: someone who signed
  // in, then picked Local, or resumed here with Parley's providers still set,
  // is moved to their own. (A no-op when nothing is hosted.)
  const hosted =
    usesCloudSession(settings.transcriptionProvider) ||
    isHostedLlm(settings.llmProviders.realtime) ||
    isHostedLlm(settings.llmProviders.deep);
  useEffect(() => {
    if (hosted) patch(localRoutePatch(useStore.getState().settings));
  }, [hosted, patch]);

  const problem = (p: KeyProblems[keyof KeyProblems]) =>
    p && <p className="text-[11px] text-danger-foreground">{t(p.key, p.vars)}</p>;

  return (
    <div className="flex flex-col gap-6">
      <SelectCard
        selected
        icon={<Cpu className="size-3.5" />}
        label={t("onboarding.model.own")}
        note={t("onboarding.model.ownNote")}
        art={{ src: "/onboarding/org-solo-lines.svg", className: "top-[38px] left-0 h-[116.52px] w-[774.18px]" }}
      >
        <>
          {/* Transcription — required: it is what the gate checks. */}
          <FieldPanel>
            <FieldLabel label={t("onboarding.stt.provider")} tag={t("onboarding.account.required")} />
            <Select
              value={settings.transcriptionProvider}
              onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Never Parley's hosted STT: that is the cloud route. */}
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
          </FieldPanel>

          {/* AI model — optional: recording works without it. */}
          <FieldPanel>
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
                {/* Never Parley's hosted "parley" LLM: that is the cloud
                    route, even when this install happens to be signed in. */}
                {PROVIDERS.filter((p) => isProviderListed(p, listing) && !p.requiresAccount).map((p) => (
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
          </FieldPanel>
        </>
      </SelectCard>
    </div>
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
