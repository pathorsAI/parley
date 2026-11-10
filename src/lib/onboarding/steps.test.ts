import { describe, it, expect } from "vitest";
import { footerFor, gateStep, isStranded, resumeStep, savedStep, visibleSteps } from "./steps";

describe("visibleSteps", () => {
  it("cloud: no model step, and the org step once signed in", () => {
    expect(visibleSteps("cloud", true, true)).toEqual(["intro", "account", "org", "perms", "mic", "context", "done"]);
    expect(visibleSteps("cloud", false, true)).toEqual(["intro", "account", "perms", "mic", "context", "done"]);
  });

  it("local: the model step, never the org step (even signed in)", () => {
    const local = ["intro", "account", "model", "perms", "mic", "context", "done"];
    expect(visibleSteps("local", false, true)).toEqual(local);
    expect(visibleSteps("local", true, true)).toEqual(local);
  });

  it("OSS build: local without the account step, whatever the saved route", () => {
    const oss = ["intro", "model", "perms", "mic", "context", "done"];
    expect(visibleSteps("local", false, false)).toEqual(oss);
    expect(visibleSteps("cloud", true, false)).toEqual(oss);
  });
});

describe("gateStep", () => {
  it("cloud signs in on the account step; local picks providers on the model step", () => {
    expect(gateStep("cloud", true)).toBe("account");
    expect(gateStep("local", true)).toBe("model");
    expect(gateStep("cloud", false)).toBe("model");
  });
});

describe("resumeStep", () => {
  const cloud = { mode: "cloud" as const, signedIn: true, cloudEnabled: true, ready: true };
  const local = { mode: "local" as const, signedIn: false, cloudEnabled: true, ready: true };

  it("resumes on the saved step when it shows and transcription is ready", () => {
    expect(resumeStep("mic", cloud)).toBe("mic");
    expect(resumeStep("org", cloud)).toBe("org");
    expect(resumeStep("model", local)).toBe("model");
  });

  it("a hidden saved step resumes at the next one that shows", () => {
    // Saved on the org step, now local: org is hidden, the model step follows it.
    expect(resumeStep("org", local)).toBe("model");
    // Saved on the model step, now cloud: perms follows it.
    expect(resumeStep("model", cloud)).toBe("perms");
  });

  it("a cloud user who signed out resumes on the account step, never past it", () => {
    const signedOut = { ...cloud, signedIn: false, ready: false };
    expect(resumeStep("context", signedOut)).toBe("account");
    expect(resumeStep("org", signedOut)).toBe("account");
    expect(resumeStep("account", signedOut)).toBe("account");
    expect(resumeStep("intro", signedOut)).toBe("intro");
  });

  it("a local user can't resume past the model step until the gate is met", () => {
    expect(resumeStep("perms", { ...local, ready: false })).toBe("model");
    expect(resumeStep("perms", local)).toBe("perms");
  });

  it("the OSS build gates on the model step", () => {
    expect(resumeStep("mic", { ...local, cloudEnabled: false, ready: false })).toBe("model");
    expect(resumeStep("account", { ...local, cloudEnabled: false })).toBe("model");
  });

  it("reads the legacy index when no id was saved", () => {
    expect(savedStep({ onboardingStep: 2, onboardingStepId: "" })).toBe("perms");
    expect(savedStep({ onboardingStep: 0, onboardingStepId: "mic" })).toBe("mic");
    expect(savedStep({ onboardingStep: 9, onboardingStepId: "nope" })).toBe("intro");
  });
});

describe("isStranded", () => {
  const cloudSteps = visibleSteps("cloud", true, true);
  it("leaves a step that no longer shows", () => {
    expect(isStranded("org", { steps: visibleSteps("cloud", false, true), gate: "account", signedIn: false })).toBe(true);
  });
  it("sends a signed-out cloud user past the account step back to it", () => {
    expect(isStranded("perms", { steps: cloudSteps, gate: "account", signedIn: false })).toBe(true);
    expect(isStranded("account", { steps: cloudSteps, gate: "account", signedIn: false })).toBe(false);
  });
  it("stays put while signed in, and on Local whatever the session", () => {
    expect(isStranded("perms", { steps: cloudSteps, gate: "account", signedIn: true })).toBe(false);
    expect(isStranded("perms", { steps: visibleSteps("local", false, true), gate: "model", signedIn: false })).toBe(false);
  });
});

describe("footerFor", () => {
  it("hides the footer on the route choice, the org choice and the last screen", () => {
    expect(footerFor("account", { cloudConfirmed: false, orgChoosing: false }).show).toBe(false);
    expect(footerFor("org", { cloudConfirmed: true, orgChoosing: true }).show).toBe(false);
    expect(footerFor("done", { cloudConfirmed: true, orgChoosing: false }).show).toBe(false);
  });
  it("gives the welcome screen and a confirmed cloud account the Skip / Start footer", () => {
    expect(footerFor("intro", { cloudConfirmed: false, orgChoosing: false })).toEqual({ show: true, skip: true });
    expect(footerFor("account", { cloudConfirmed: true, orgChoosing: false })).toEqual({ show: true, skip: true });
  });
  it("gives every other step a plain Next footer", () => {
    expect(footerFor("model", { cloudConfirmed: false, orgChoosing: false })).toEqual({ show: true, skip: false });
  });
});
