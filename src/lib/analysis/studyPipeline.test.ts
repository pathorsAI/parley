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
    intelExtractable: true,
    analysisStatus: "idle",
    actionItemsStatus: "idle",
    briefStatus: "idle",
    deliveryStatus: "idle",
    intelStatus: "idle",
    studyMeetingType: "general",
    intelType: null,
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
    // Not just findings: intel is independent of the findings pass and used to
    // leak a deep extraction over the pre-trim, un-diarized transcript.
    expect(
      evaluateStages(facts({ wizardOpen: true, studyMeetingType: "sales" }))
    ).toEqual([]);
    // ...and simply closing it un-defers. No gate to release, nothing to leak.
    expect(
      evaluateStages(facts({ wizardOpen: false, studyMeetingType: "sales" }))
    ).toEqual(["findings", "intel"]);
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

  it("intel: 'idle' always wants a run (fresh pick OR invalidation); 'done' only re-runs on a type mismatch", () => {
    const base = facts({ analysisStatus: "running", studyMeetingType: "sales" });
    // No board yet → extract.
    expect(evaluateStages(base)).toContain("intel");
    // Invalidated over a MATCHING board (manual regenerate) → extract again.
    expect(
      evaluateStages({ ...base, intelType: "sales", intelStatus: "idle" })
    ).toContain("intel");
    // Board matches and is done → nothing to do.
    expect(
      evaluateStages({ ...base, intelType: "sales", intelStatus: "done" })
    ).not.toContain("intel");
    // Restored board of ANOTHER type (status "done") → re-extract for the picked one.
    expect(
      evaluateStages({ ...base, intelType: "negotiation", intelStatus: "done" })
    ).toContain("intel");
    // A failed run blocks auto-retry until the type changes (which resets to idle).
    expect(evaluateStages({ ...base, intelStatus: "error" })).not.toContain("intel");
  });

  it("intel never dispatches on a transcript too short to extract — the chip must not queue forever", () => {
    expect(
      evaluateStages(facts({ studyMeetingType: "sales", intelExtractable: false }))
    ).not.toContain("intel");
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
        intelStatus: "done",
        studyMeetingType: "sales",
        intelType: "sales",
      })
    );
    expect(p.total).toBe(5);
    expect(p.done).toBe(5);
    expect(p.active).toBe(false);
  });

  it("intel is excluded from the totals without a typed template — or without enough transcript", () => {
    const general = deriveStudyPipeline(facts());
    expect(general.total).toBe(4);
    expect(general.artifacts.find((a) => a.key === "intel")?.applicable).toBe(false);

    const typed = deriveStudyPipeline(facts({ studyMeetingType: "negotiation" }));
    expect(typed.total).toBe(5);
    expect(displayOf(typed, "intel")).toBe("queued");

    const short = deriveStudyPipeline(
      facts({ studyMeetingType: "negotiation", intelExtractable: false })
    );
    expect(short.total).toBe(4);
    expect(displayOf(short, "intel")).toBe("idle");
  });
});
