import { describe, it, expect } from "vitest";
import {
  artifactDisplay,
  chainQueued,
  deriveStudyPipeline,
  evaluateStages,
  type StudyPipelineFacts,
} from "./studyPipeline";

/** A ready deep-lane session. The realtime key is OFF by default so the
 *  artifact-topology cases below stay about the four report artifacts; the
 *  filing cases opt in with `hasRealtimeKey: true`. */
function facts(patch: Partial<StudyPipelineFacts> = {}): StudyPipelineFacts {
  return {
    inReplay: true,
    wizardOpen: false,
    diarizing: false,
    hasDeepKey: true,
    hasRealtimeKey: false,
    readOnly: false,
    hasTranscript: true,
    analysisStatus: "idle",
    actionItemsStatus: "idle",
    briefStatus: "idle",
    deliveryStatus: "idle",
    filingStatus: "idle",
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

describe("evaluateStages: the filing pass (a stage, not a report artifact)", () => {
  const filing = (patch: Partial<StudyPipelineFacts> = {}) =>
    facts({ hasRealtimeKey: true, ...patch });

  it("goes out in the SAME tick as findings — it waits on nothing upstream", () => {
    const out = evaluateStages(filing());
    expect(out).toContain("filing");
    expect(out).toContain("findings");
    // Not "after findings finish": the suggestion must land with the transcript.
    expect(evaluateStages(filing({ analysisStatus: "running" }))).toEqual(["filing"]);
  });

  it("runs on a realtime-only key, where the four report artifacts cannot", () => {
    const out = evaluateStages(filing({ hasDeepKey: false }));
    expect(out).toEqual(["filing"]);
    // ...and the deep lane alone still gets the artifacts but no suggestion.
    expect(evaluateStages(facts({ hasRealtimeKey: false }))).toEqual(["findings"]);
  });

  it("declines on a READ-ONLY recording — nothing there to rename or refile", () => {
    expect(evaluateStages(filing({ readOnly: true }))).toEqual(["findings"]);
  });

  it("runs once: any status but idle means it already ran or is running", () => {
    for (const filingStatus of ["running", "done", "error"] as const) {
      expect(evaluateStages(filing({ filingStatus }))).toEqual(["findings"]);
    }
  });

  it("still defers to the wizard and to auto-analysis being off", () => {
    expect(evaluateStages(filing({ wizardOpen: true }))).toEqual([]);
    expect(evaluateStages(filing({ autoAnalyze: false }))).toEqual([]);
    expect(evaluateStages(filing({ hasTranscript: false }))).toEqual([]);
    expect(evaluateStages(filing({ inReplay: false }))).toEqual([]);
  });
});

describe("evaluateStages: post-save speaker correction (diarizing)", () => {
  it("holds every deep-lane stage while the speakers are being corrected", () => {
    expect(evaluateStages(facts({ diarizing: true }))).toEqual([]);
    // Mid-chain too: a restored findings pass must not fan out on drifted labels.
    expect(
      evaluateStages(facts({ diarizing: true, analysisStatus: "done" }))
    ).toEqual([]);
    expect(
      evaluateStages(
        facts({ diarizing: true, analysisStatus: "done", actionItemsStatus: "done" })
      )
    ).toEqual([]);
  });

  it("lets filing run immediately — it reads the text, not who said it", () => {
    expect(evaluateStages(facts({ diarizing: true, hasRealtimeKey: true }))).toEqual([
      "filing",
    ]);
  });

  it("releases the whole chain the moment the correction lands", () => {
    const held = facts({ diarizing: true, hasRealtimeKey: true, filingStatus: "running" });
    expect(evaluateStages(held)).toEqual([]);
    expect(evaluateStages({ ...held, diarizing: false })).toEqual(["findings"]);
  });

  it("keeps every held artifact reading QUEUED (skeletons), never idle", () => {
    const p = deriveStudyPipeline(facts({ diarizing: true }));
    for (const key of ["findings", "actions", "brief", "delivery"]) {
      expect(displayOf(p, key)).toBe("queued");
    }
    expect(p.active).toBe(true);
    expect(p.diarizing).toBe(true);
    expect(artifactDisplay(facts({ diarizing: true }), "brief")).toBe("queued");
  });

  it("an artifact restored as done stays done while the speakers are corrected", () => {
    const p = deriveStudyPipeline(facts({ diarizing: true, analysisStatus: "done" }));
    expect(displayOf(p, "findings")).toBe("done");
    expect(displayOf(p, "actions")).toBe("queued");
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

  it("a section's own display (artifactDisplay) is exactly what the chip shows for it", () => {
    // The report sections pick skeleton vs empty message off artifactDisplay;
    // the chip counts off deriveStudyPipeline. One must never say "queued"
    // while the other says "idle".
    const cases = [
      facts(),
      facts({ analysisStatus: "running" }),
      facts({ analysisStatus: "done", actionItemsStatus: "running" }),
      facts({ analysisStatus: "error" }),
      facts({ autoAnalyze: false }),
      facts({ hasDeepKey: false }),
      facts({ analysisStatus: "done", actionItemsStatus: "done", briefStatus: "done", deliveryStatus: "done" }),
    ];
    for (const f of cases) {
      const p = deriveStudyPipeline(f);
      for (const a of p.artifacts) expect(artifactDisplay(f, a.key)).toBe(a.display);
    }
  });

  it("the chip still counts FOUR artifacts — filing is a stage, not one of them", () => {
    const p = deriveStudyPipeline(facts({ hasRealtimeKey: true, filingStatus: "running" }));
    expect(p.total).toBe(4);
    expect(p.artifacts.map((a) => a.key)).toEqual([
      "findings",
      "actions",
      "brief",
      "delivery",
    ]);
  });
});
