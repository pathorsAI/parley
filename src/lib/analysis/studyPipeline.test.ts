import { describe, it, expect } from "vitest";
import {
  chainQueued,
  deriveStudyPipeline,
  evaluateStages,
  type StudyPipelineFacts,
} from "./studyPipeline";

function facts(patch: Partial<StudyPipelineFacts> = {}): StudyPipelineFacts {
  return {
    inReplay: true,
    wizardOpen: false,
    hasDeepKey: true,
    hasTranscript: true,
    analysisStatus: "idle",
    actionItemsStatus: "idle",
    briefStatus: "idle",
    deliveryStatus: "idle",
    autoAnalyze: true,
    ...patch,
  };
}

function displayOf(p: ReturnType<typeof deriveStudyPipeline>, key: string) {
  return p.artifacts.find((a) => a.key === key)?.display;
}

describe("evaluateStages (the scheduler's whole topology)", () => {
  it("a fresh session starts with the findings pass only", () => {
    expect(evaluateStages(facts())).toEqual(["findings"]);
  });

  it("an OPEN ingest wizard defers the WHOLE DAG — no pass may spend on an unconfirmed transcript", () => {
    expect(evaluateStages(facts({ wizardOpen: true }))).toEqual([]);
    // ...and simply closing it un-defers. No gate to release, nothing to leak.
    expect(evaluateStages(facts({ wizardOpen: false }))).toEqual(["findings"]);
  });

  it("finished findings fan out to action items + delivery (brief still waits)", () => {
    expect(evaluateStages(facts({ analysisStatus: "done" }))).toEqual([
      "actions",
      "delivery",
    ]);
  });

  it("the brief starts once action items SETTLE — done or error alike", () => {
    for (const actionItemsStatus of ["done", "error"] as const) {
      expect(
        evaluateStages(
          facts({ analysisStatus: "done", actionItemsStatus, deliveryStatus: "done" })
        )
      ).toEqual(["brief"]);
    }
  });

  it("a failed findings pass stops the chain", () => {
    expect(evaluateStages(facts({ analysisStatus: "error" }))).toEqual([]);
  });

  it("nothing runs outside replay, without a deep key, or without a transcript", () => {
    expect(evaluateStages(facts({ inReplay: false }))).toEqual([]);
    expect(evaluateStages(facts({ hasDeepKey: false }))).toEqual([]);
    expect(evaluateStages(facts({ hasTranscript: false }))).toEqual([]);
  });

  it("auto-analysis OFF stops every stage — the recording stays unanalyzed for an external AI", () => {
    // Everything else is ready: key, transcript, wizard closed, and every
    // status idle. Only the switch holds it back.
    const ready = facts();
    expect(evaluateStages(ready)).toEqual(["findings"]);
    expect(evaluateStages({ ...ready, autoAnalyze: false })).toEqual([]);
    // ...and it holds MID-chain too: a findings pass that already ran (restored
    // from disk, or written back over MCP) must not fan out on its own.
    expect(
      evaluateStages({ ...ready, autoAnalyze: false, analysisStatus: "done" })
    ).toEqual([]);
  });
});

describe("deriveStudyPipeline (what the chip + sections say)", () => {
  it("a fresh session with key + transcript is FULLY queued — never a silent blank", () => {
    const p = deriveStudyPipeline(facts());
    expect(displayOf(p, "findings")).toBe("queued");
    expect(displayOf(p, "actions")).toBe("queued");
    expect(displayOf(p, "brief")).toBe("queued");
    expect(displayOf(p, "delivery")).toBe("queued");
    expect(p.active).toBe(true);
    expect(p.done).toBe(0);
  });

  it("the brief reads QUEUED (not idle) for the whole analysis → action-items window", () => {
    // The exact state the old UI showed as a dead "Generate" button.
    const f = facts({ analysisStatus: "done", actionItemsStatus: "running" });
    const p = deriveStudyPipeline(f);
    expect(displayOf(p, "brief")).toBe("queued");
    expect(displayOf(p, "actions")).toBe("running");
    expect(p.active).toBe(true);
    // The section's narrow selector shares the rule by construction.
    expect(chainQueued(f)).toBe(true);
  });

  it("without a deep-lane key nothing is queued and the pipeline is inactive", () => {
    const f = facts({ hasDeepKey: false });
    const p = deriveStudyPipeline(f);
    expect(p.artifacts.every((a) => a.display === "idle")).toBe(true);
    expect(p.active).toBe(false);
    expect(p.hasDeepKey).toBe(false);
    expect(chainQueued(f)).toBe(false);
  });

  it("a failed findings pass shows error upstream and idle (not queued-forever) downstream", () => {
    const f = facts({ analysisStatus: "error" });
    const p = deriveStudyPipeline(f);
    expect(displayOf(p, "findings")).toBe("error");
    expect(displayOf(p, "actions")).toBe("idle");
    expect(displayOf(p, "brief")).toBe("idle");
    expect(p.errors).toBe(1);
    expect(p.active).toBe(false);
    expect(chainQueued(f)).toBe(false);
  });

  it("a fully restored entry counts done/total with no activity", () => {
    const p = deriveStudyPipeline(
      facts({
        analysisStatus: "done",
        actionItemsStatus: "done",
        briefStatus: "done",
        deliveryStatus: "done",
      })
    );
    expect(p.total).toBe(4);
    expect(p.done).toBe(4);
    expect(p.active).toBe(false);
  });

  it("auto-analysis OFF reads idle, not queued — nothing is coming to fulfil the promise", () => {
    const f = facts({ autoAnalyze: false });
    const p = deriveStudyPipeline(f);
    expect(p.artifacts.every((a) => a.display === "idle")).toBe(true);
    expect(p.active).toBe(false);
    expect(chainQueued(f)).toBe(false);
    // The capability flags still report the truth: a key and a transcript are
    // there, so the sections offer "Regenerate" rather than a missing-key hint.
    expect(p.hasDeepKey).toBe(true);
    expect(p.hasTranscript).toBe(true);
  });

});
