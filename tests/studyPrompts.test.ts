import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every study-stage prompt the desktop builds, captured at the LLM boundary.
//
// The prompt TEXT lives in shared/prompts/study.json (shared with Android); the
// desktop composes it in src/lib/ai/*. These snapshots pin exactly what goes
// out — system prompt and user prompt — for every lens, mode and language, so a
// refactor of the composition (or a stray edit of the JSON) shows up as a diff.
//
// The same captured calls also produce shared/prompts/study.golden.json: fixed
// inputs + the desktop's prompts for them, which Android's
// StudyPromptsGoldenTest replays to prove the phone asks the same questions.
// Regenerate it with UPDATE_STUDY_GOLDEN=1 bunx vitest run tests/studyPrompts.test.ts

type Captured = { system: string; prompt: string };

const captured = vi.hoisted(() => ({ calls: [] as { system: string; prompt: string }[] }));

/** One object that satisfies every structured stage's schema (each reads only its keys). */
const FAKE_OBJECT = vi.hoisted(() => ({
  kind: "internal",
  moments: [],
  actions: [],
  tone: "neutral",
  tone_evidence: "",
  filler_level: "ok",
  filler_examples: [],
  filler_note: "",
  pace: "comfortable",
  summary: "",
}));

vi.mock("../src/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../src/lib/usage/log", () => ({ recordLlmUsage: vi.fn(async () => {}) }));
vi.mock("../src/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("../src/lib/ai/provider")>()),
  getModel: vi.fn(() => ({})),
  getProviderOptions: vi.fn(() => ({})),
}));
vi.mock("../src/lib/ai/generate", async (orig) => {
  const capture = async (o: { system: string; prompt: string }) => {
    captured.calls.push({ system: o.system, prompt: o.prompt });
    return { object: FAKE_OBJECT, usage: undefined };
  };
  return {
    ...(await orig<typeof import("../src/lib/ai/generate")>()),
    streamObjectResilient: vi.fn(capture),
    generateObjectResilient: vi.fn(capture),
  };
});
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  streamText: vi.fn((o: { system: string; prompt: string }) => {
    captured.calls.push({ system: o.system, prompt: o.prompt });
    return {
      textStream: (async function* () {
        yield "brief";
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve(undefined),
    };
  }),
}));

import { detectMeetingKind } from "../src/lib/ai/meetingKind";
import { analyzeTimeline } from "../src/lib/ai/timeline";
import { generateActionItems } from "../src/lib/ai/actionItems";
import { generatePostMeetingReport } from "../src/lib/ai/report";
import { analyzeDelivery } from "../src/lib/ai/delivery";
import { fillerWatchlist, FILLER_WORDS } from "../src/lib/analysis/fillerWords";
import {
  buildBuiltinEvalLabels,
  buildPresetEvalDefs,
  buildPresetEvalTemplates,
  defaultEvalDefs,
  evalsFromDefs,
} from "../src/lib/evaluations/presets";
import { EVAL_TEMPLATE_OF, lensOf } from "../src/lib/analysis/lens";
import { useStore } from "../src/lib/store";
import { translate, type TranslationKey } from "../src/i18n";
import STUDY from "../shared/prompts/study.json";
import type {
  ActionItem,
  AnalysisLens,
  AppLanguage,
  EvalDef,
  MeetingKind,
  Settings,
  TimelineEvent,
  TranscriptSegment,
} from "../src/lib/types";

// ── Fixed inputs ────────────────────────────────────────────────────────────

const SEGMENTS: TranscriptSegment[] = [
  { id: "seg-0", source: "mix", speaker: 1, text: "Thanks for joining. Let's settle the pilot rollout date today.", isFinal: true, startMs: 0, endMs: 4000 },
  { id: "seg-1", source: "mix", speaker: 2, text: "Um, we need the security review signed off before any rollout.", isFinal: true, startMs: 4500, endMs: 9000 },
  { id: "seg-2", source: "mix", speaker: 0, text: "嗯，我覺得價格還可以再談。", isFinal: true, startMs: 9500, endMs: 13000 },
  { id: "seg-3", source: "mix", speaker: 1, text: "and the budget is", isFinal: false, startMs: 13500, endMs: 15000 },
  { id: "seg-4", source: "mix", speaker: 2, text: "   ", isFinal: true, startMs: 15500, endMs: 16000 },
  { id: "seg-5", source: "mix", speaker: 2, text: "Our budget this quarter is 40,000, so 6,000 a month is too high.", isFinal: true, startMs: 65000, endMs: 70000 },
  { id: "seg-6", source: "mix", speaker: 1, text: "Could we phase it, starting with one team in November?", isFinal: true, startMs: 71000, endMs: 75500 },
  { id: "seg-7", source: "mix", speaker: 2, text: "就是說，我們需要老闆同意才能簽。", isFinal: true, startMs: 78000, endMs: 82000 },
];

const SPEAKER_NAMES: Record<string, string> = { "mix-2": "Amy" };

const MEETING_CONTEXT = "Pilot rollout and pricing call with Acme's operations team.";

const FINDINGS: TimelineEvent[] = [
  { id: "f1", atMs: 65000, severity: "warn", source: "extra", title: "Budget ceiling", detail: "Amy capped the quarter at 40,000 and called 6,000 a month too high.", side: "them" },
  { id: "f2", atMs: 4500, severity: "info", source: "extra", title: "Rollout gated on security review", detail: "Nothing ships before the security review is signed off.", category: "decision" },
  { id: "f3", atMs: 78000, severity: "critical", source: "extra", title: "Sign-off needs the boss", detail: "Amy cannot sign without her manager's approval." },
];

const ACTION_ITEMS: ActionItem[] = [
  { id: "a1", text: "Send the phased rollout proposal", done: false, linkedEventId: null, atMs: null },
  { id: "a2", text: "Book the security review", done: true, linkedEventId: null, atMs: null },
];

const LANGUAGES: AppLanguage[] = ["en", "zh-TW"];
const LENSES: AnalysisLens[] = ["decision", "opportunity", "adversarial"];
const GOLDEN_KINDS: MeetingKind[] = ["internal", "sales", "pricing"];
const KIND_OF_LENS: Record<AnalysisLens, MeetingKind> = {
  decision: "internal",
  opportunity: "sales",
  adversarial: "pricing",
};

const BASE_SETTINGS: Settings = useStore.getState().settings;
const INITIAL_STATE = useStore.getState();

function settingsFor(language: AppLanguage, withProfile = false): Settings {
  return {
    ...BASE_SETTINGS,
    language,
    userName: withProfile ? "Jack" : "",
    userRole: withProfile ? "Founder" : "",
    userCompany: withProfile ? "Pathors" : "",
    userBackground: withProfile ? "Runs sales and product for a voice-AI startup." : "",
  };
}

const tFor = (language: AppLanguage) => (key: TranslationKey) => translate(language, key);

function templateEvals(kind: MeetingKind, language: AppLanguage): EvalDef[] {
  const tpl = buildPresetEvalTemplates(tFor(language)).find((x) => x.id === EVAL_TEMPLATE_OF[kind]);
  if (!tpl) throw new Error(`no template for ${kind}`);
  return tpl.evals;
}

function setStoreContext(ctx: Partial<{ meetingContext: string; meetingBatna: string; meetingTarget: string; meetingFloor: string }>) {
  useStore.setState({ meetingContext: "", meetingBatna: "", meetingTarget: "", meetingFloor: "", ...ctx });
}

/** Run one stage and return the single LLM call it made. */
async function captureOne(run: () => Promise<unknown>): Promise<Captured> {
  captured.calls.length = 0;
  await run();
  expect(captured.calls).toHaveLength(1);
  return captured.calls[0];
}

// ── Stage drivers ──────────────────────────────────────────────────────────

const meetingKindCall = (settings: Settings, meetingContext?: string, segments = SEGMENTS) =>
  captureOne(() => detectMeetingKind({ settings, segments, meetingContext, names: SPEAKER_NAMES }));

const timelineCall = (opts: {
  settings: Settings;
  lens: AnalysisLens;
  mode: "live" | "replay";
  evals: EvalDef[];
  meetingContext?: string;
  segments?: TranscriptSegment[];
}) =>
  captureOne(() =>
    analyzeTimeline({
      settings: opts.settings,
      segments: opts.segments ?? SEGMENTS,
      evals: opts.evals,
      meetingContext: opts.meetingContext,
      names: SPEAKER_NAMES,
      mode: opts.mode,
      lens: opts.lens,
    })
  );

const actionItemsCall = (opts: { settings: Settings; lens: AnalysisLens; findings: TimelineEvent[]; meetingContext?: string }) =>
  captureOne(() =>
    generateActionItems({
      settings: opts.settings,
      segments: SEGMENTS,
      findings: opts.findings,
      meetingContext: opts.meetingContext,
      lens: opts.lens,
      names: SPEAKER_NAMES,
    })
  );

const briefCall = (opts: {
  settings: Settings;
  lens: AnalysisLens;
  evals: EvalDef[];
  todos: { id: string; text: string; done: boolean }[];
  meetingContext?: string;
  segments?: TranscriptSegment[];
}) =>
  captureOne(() =>
    generatePostMeetingReport({
      settings: opts.settings,
      segments: opts.segments ?? SEGMENTS,
      evaluations: evalsFromDefs(opts.evals),
      todos: opts.todos,
      names: SPEAKER_NAMES,
      meetingContext: opts.meetingContext,
      lens: opts.lens,
      onDelta: () => {},
    })
  );

const deliveryCall = (opts: {
  settings: Settings;
  mode: "live" | "post";
  prosody?: { speechRateHz: number; pitchVarSemitones: number };
  measuredRateHz?: number | null;
}) =>
  captureOne(() =>
    analyzeDelivery({
      settings: opts.settings,
      segments: SEGMENTS,
      names: SPEAKER_NAMES,
      prosody: opts.prosody
        ? { f0Hz: 180, monotonyScore: 0.3, sessionRateHz: 4.1, voicedRatio: 0.6, ...opts.prosody }
        : null,
      measuredRateHz: opts.measuredRateHz,
      mode: opts.mode,
    })
  );

const TODOS = ACTION_ITEMS.map(({ id, text, done }) => ({ id, text, done }));

beforeEach(() => {
  useStore.setState(INITIAL_STATE, true);
  setStoreContext({});
});

// ── Snapshots: the proof that the desktop's prompts did not move ────────────

describe("study prompts — meeting kind", () => {
  for (const language of LANGUAGES) {
    it(`blank profile, with context (${language})`, async () => {
      expect(await meetingKindCall(settingsFor(language), MEETING_CONTEXT)).toMatchSnapshot();
    });
    it(`full profile, no context (${language})`, async () => {
      expect(await meetingKindCall(settingsFor(language, true))).toMatchSnapshot();
    });
  }
});

describe("study prompts — timeline", () => {
  for (const language of LANGUAGES) {
    for (const lens of LENSES) {
      for (const mode of ["live", "replay"] as const) {
        it(`${lens} ${mode} (${language})`, async () => {
          const call = await timelineCall({
            settings: settingsFor(language),
            lens,
            mode,
            evals: templateEvals(KIND_OF_LENS[lens], language),
            meetingContext: MEETING_CONTEXT,
          });
          expect(call).toMatchSnapshot();
        });
      }
    }
  }
  it("full profile, adversarial replay (en)", async () => {
    const call = await timelineCall({
      settings: settingsFor("en", true),
      lens: "adversarial",
      mode: "replay",
      evals: templateEvals("rivalry", "en"),
      meetingContext: MEETING_CONTEXT,
    });
    expect(call).toMatchSnapshot();
  });
  it("no evals, no context (zh-TW)", async () => {
    const call = await timelineCall({ settings: settingsFor("zh-TW"), lens: "decision", mode: "replay", evals: [] });
    expect(call).toMatchSnapshot();
  });
  it("no speech captured (en)", async () => {
    const call = await timelineCall({
      settings: settingsFor("en"),
      lens: "opportunity",
      mode: "live",
      evals: templateEvals("sales", "en"),
      segments: [],
    });
    expect(call).toMatchSnapshot();
  });
});

describe("study prompts — action items", () => {
  for (const language of LANGUAGES) {
    for (const lens of LENSES) {
      it(`${lens} (${language})`, async () => {
        const call = await actionItemsCall({ settings: settingsFor(language), lens, findings: FINDINGS, meetingContext: MEETING_CONTEXT });
        expect(call).toMatchSnapshot();
      });
    }
  }
  it("full profile, no findings, no context (en)", async () => {
    expect(await actionItemsCall({ settings: settingsFor("en", true), lens: "opportunity", findings: [] })).toMatchSnapshot();
  });
});

describe("study prompts — brief", () => {
  for (const language of LANGUAGES) {
    for (const lens of LENSES) {
      it(`${lens} (${language})`, async () => {
        const call = await briefCall({
          settings: settingsFor(language),
          lens,
          evals: templateEvals(KIND_OF_LENS[lens], language),
          todos: TODOS,
          meetingContext: MEETING_CONTEXT,
        });
        expect(call).toMatchSnapshot();
      });
    }
  }
  it("full profile, no rubric, no checklist, no context (zh-TW)", async () => {
    expect(await briefCall({ settings: settingsFor("zh-TW", true), lens: "adversarial", evals: [], todos: [] })).toMatchSnapshot();
  });
  it("no speech captured (en)", async () => {
    expect(
      await briefCall({ settings: settingsFor("en"), lens: "decision", evals: [], todos: TODOS, segments: [] })
    ).toMatchSnapshot();
  });
});

describe("study prompts — delivery", () => {
  for (const language of LANGUAGES) {
    it(`live with prosody (${language})`, async () => {
      setStoreContext({ meetingContext: MEETING_CONTEXT });
      expect(
        await deliveryCall({ settings: settingsFor(language), mode: "live", prosody: { speechRateHz: 4.26, pitchVarSemitones: 2.04 } })
      ).toMatchSnapshot();
    });
    it(`post with measured rate (${language})`, async () => {
      setStoreContext({ meetingContext: MEETING_CONTEXT });
      expect(await deliveryCall({ settings: settingsFor(language), mode: "post", measuredRateHz: 3.87 })).toMatchSnapshot();
    });
    it(`post without measured rate (${language})`, async () => {
      setStoreContext({ meetingContext: MEETING_CONTEXT });
      expect(await deliveryCall({ settings: settingsFor(language), mode: "post" })).toMatchSnapshot();
    });
  }
  it("full profile, negotiation setup in the store (en)", async () => {
    setStoreContext({
      meetingContext: MEETING_CONTEXT,
      meetingBatna: "Sign the competing pilot with Globex.",
      meetingTarget: "5,000 a month",
      meetingFloor: "4,200 a month",
    });
    expect(await deliveryCall({ settings: settingsFor("en", true), mode: "post", measuredRateHz: 4 })).toMatchSnapshot();
  });
  it("no meeting context (zh-TW)", async () => {
    expect(await deliveryCall({ settings: settingsFor("zh-TW", true), mode: "live" })).toMatchSnapshot();
  });
});

describe("study prompts — presets and filler words", () => {
  for (const language of LANGUAGES) {
    const t = tFor(language);
    it(`buildPresetEvalTemplates (${language})`, () => {
      expect(buildPresetEvalTemplates(t)).toMatchSnapshot();
    });
    it(`buildPresetEvalDefs (${language})`, () => {
      expect(buildPresetEvalDefs(t)).toMatchSnapshot();
    });
    it(`defaultEvalDefs (${language})`, () => {
      expect(defaultEvalDefs(t)).toMatchSnapshot();
    });
    it(`buildBuiltinEvalLabels (${language})`, () => {
      expect(Object.fromEntries(buildBuiltinEvalLabels(t))).toMatchSnapshot();
    });
    it(`fillerWatchlist (${language})`, () => {
      expect(fillerWatchlist(language)).toMatchSnapshot();
    });
  }
  it("FILLER_WORDS", () => {
    expect(FILLER_WORDS).toMatchSnapshot();
  });
});

// ── shared/prompts/study.json sanity ────────────────────────────────────────

describe("shared/prompts/study.json", () => {
  const evals = STUDY.evals as Record<string, { prompt: string; name: Record<string, string> }>;

  for (const language of LANGUAGES) {
    it(`every eval name matches the i18n tpl.eval.<id>.name (${language})`, () => {
      for (const [id, def] of Object.entries(evals)) {
        expect(def.name[language], id).toBe(translate(language, `tpl.eval.${id}.name` as TranslationKey));
      }
    });
  }

  it("every template and core eval id exists in evals", () => {
    const ids = [...STUDY.coreEvals, ...Object.values(STUDY.templates as Record<string, string[]>).flat()];
    for (const id of ids) expect(evals[id], id).toBeDefined();
  });

  it("every kind's template exists", () => {
    for (const [kind, k] of Object.entries(STUDY.kinds as Record<string, { lens: string; template: string }>)) {
      expect((STUDY.templates as Record<string, string[]>)[k.template], kind).toBeDefined();
      expect(k.lens).toBe(lensOf(kind as MeetingKind));
      expect(k.template).toBe(EVAL_TEMPLATE_OF[kind as MeetingKind]);
    }
  });
});

// ── shared/prompts/study.golden.json — the fixture Android replays ──────────

const GOLDEN_PATH = join(__dirname, "..", "shared", "prompts", "study.golden.json");

type GoldenCase = { stage: string; kind?: MeetingKind; lens?: AnalysisLens; language: AppLanguage } & Captured;

async function buildGolden() {
  const cases: GoldenCase[] = [];
  for (const language of LANGUAGES) {
    const settings = settingsFor(language);
    cases.push({ stage: "meetingKind", language, ...(await meetingKindCall(settings, MEETING_CONTEXT)) });
    for (const kind of GOLDEN_KINDS) {
      const lens = lensOf(kind);
      const call = await timelineCall({ settings, lens, mode: "replay", evals: templateEvals(kind, language), meetingContext: MEETING_CONTEXT });
      cases.push({ stage: "timeline", kind, lens, language, ...call });
    }
    for (const kind of GOLDEN_KINDS) {
      const lens = lensOf(kind);
      const call = await actionItemsCall({ settings, lens, findings: FINDINGS, meetingContext: MEETING_CONTEXT });
      cases.push({ stage: "actionItems", kind, lens, language, ...call });
    }
    for (const kind of GOLDEN_KINDS) {
      const lens = lensOf(kind);
      const call = await briefCall({ settings, lens, evals: templateEvals(kind, language), todos: TODOS, meetingContext: MEETING_CONTEXT });
      cases.push({ stage: "brief", kind, lens, language, ...call });
    }
    setStoreContext({ meetingContext: MEETING_CONTEXT });
    cases.push({ stage: "delivery", language, ...(await deliveryCall({ settings, mode: "post" })) });
    setStoreContext({});
  }
  return {
    $comment:
      "Prompts the DESKTOP builds for fixed inputs (blank profile, replay/post mode). Android's StudyPromptsGoldenTest checks that the phone builds the same system and user prompts. Regenerate: UPDATE_STUDY_GOLDEN=1 bunx vitest run tests/studyPrompts.test.ts",
    input: {
      segments: SEGMENTS,
      speakerNames: SPEAKER_NAMES,
      meetingContext: MEETING_CONTEXT,
      findings: FINDINGS,
      actionItems: ACTION_ITEMS,
    },
    cases,
  };
}

describe("shared/prompts/study.golden.json", () => {
  it("matches what the desktop builds", async () => {
    const text = JSON.stringify(await buildGolden(), null, 2) + "\n";
    if (process.env.UPDATE_STUDY_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, text);
      return;
    }
    expect(existsSync(GOLDEN_PATH), "missing — run UPDATE_STUDY_GOLDEN=1 bunx vitest run tests/studyPrompts.test.ts").toBe(true);
    expect(readFileSync(GOLDEN_PATH, "utf8"), "stale — run UPDATE_STUDY_GOLDEN=1 bunx vitest run tests/studyPrompts.test.ts").toBe(text);
  });
});
