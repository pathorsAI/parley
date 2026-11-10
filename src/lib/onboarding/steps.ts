// Which onboarding steps show, and where a saved wizard resumes. Pure, so the
// per-route rules are unit-tested without rendering the wizard.

import type { Settings, SetupMode } from "../types";
import { effectiveSetupMode } from "./setupMode";

export type StepId = "intro" | "account" | "org" | "model" | "perms" | "mic" | "context" | "done";

// One job per step: say what Parley is, pick a route (Cloud signs in here),
// settle the organization (Cloud) or make transcription work with the user's
// own models (Local), get the OS permissions, check the mic, tell the AI who
// the user is, then hand off to a first real run. Teaching the rest of the app
// lives in the Home checklist, not here.
export const ALL_STEPS: readonly StepId[] = ["intro", "account", "org", "model", "perms", "mic", "context", "done"];

/** The steps of the four-step wizard that `onboardingStep` indexed. */
const LEGACY_STEPS: readonly StepId[] = ["intro", "account", "perms", "done"];

export function isStepId(v: string): v is StepId {
  return (ALL_STEPS as readonly string[]).includes(v);
}

/** Where a saved wizard resumes: the saved id, else the legacy index's step. */
export function savedStep(saved: Readonly<Pick<Settings, "onboardingStep" | "onboardingStepId">>): StepId {
  if (isStepId(saved.onboardingStepId)) return saved.onboardingStepId;
  return LEGACY_STEPS[saved.onboardingStep] ?? "intro";
}

/**
 * The steps this route shows, in order.
 *
 * - Cloud: intro, account, org (once signed in), perms, mic, context, done. No
 *   model step: the cloud route always runs on Parley's hosted models, so
 *   there is nothing to pick.
 * - Local: intro, account, model, perms, mic, context, done. No org step:
 *   organizations live in the cloud.
 * - OSS build (no cloud edition): Local without the account step — there is no
 *   account and no route to choose.
 */
export function visibleSteps(mode: SetupMode, signedIn: boolean, cloudEnabled: boolean): StepId[] {
  const cloud = effectiveSetupMode(mode, cloudEnabled) === "cloud";
  return ALL_STEPS.filter((s) => {
    if (s === "account") return cloudEnabled;
    if (s === "org") return cloud && signedIn;
    if (s === "model") return !cloud;
    return true;
  });
}

/**
 * The step that holds the transcription gate: nothing after it is reachable
 * until transcription can actually run. Cloud satisfies it by signing in on the
 * account step; Local by a key or a downloaded model on the model step.
 */
export function gateStep(mode: SetupMode, cloudEnabled: boolean): StepId {
  return effectiveSetupMode(mode, cloudEnabled) === "cloud" ? "account" : "model";
}

/**
 * Where a saved wizard opens: the first visible step at or after the saved one
 * (a step that is hidden now, e.g. "org" after signing out, resumes at the one
 * after it) — but never past the gate step while transcription isn't ready, so
 * a cloud session that has since signed out lands back on the account step and
 * a local setup without a working provider on the model step. (The caller
 * checks readiness before the on-device catalog has loaded, which reads as not
 * ready: a local on-device setup fails closed and confirms its model.)
 */
export function resumeStep(
  saved: StepId,
  ctx: Readonly<{ mode: SetupMode; signedIn: boolean; cloudEnabled: boolean; ready: boolean }>,
): StepId {
  const shown = visibleSteps(ctx.mode, ctx.signedIn, ctx.cloudEnabled);
  const resumed = ALL_STEPS.slice(ALL_STEPS.indexOf(saved)).find((s) => shown.includes(s)) ?? "intro";
  const gate = gateStep(ctx.mode, ctx.cloudEnabled);
  if (!ctx.ready && ALL_STEPS.indexOf(resumed) > ALL_STEPS.indexOf(gate)) return gate;
  return resumed;
}
