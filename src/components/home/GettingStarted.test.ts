import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Boundaries: logging (its Tauri-less path touches `window`), and the modules
// the CTAs call into — opening a recording, starting a meeting, loading the
// sample all reach Tauri. Rendering never calls them; mocking keeps the import
// graph out of native code.
vi.mock("../../lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../../lib/history/history", () => ({ loadHistoryEntry: vi.fn() }));
vi.mock("../../lib/meeting/start", () => ({ beginMeeting: vi.fn() }));
vi.mock("../../lib/replay/ingest", () => ({ startImportFlow: vi.fn() }));
vi.mock("../../lib/onboarding/sample", () => ({ loadSampleRecording: vi.fn() }));

import { DEFAULT_GETTING_STARTED, useStore } from "../../lib/store";
import type { LibraryTree } from "../shell/useLibraryTree";
import { GettingStarted } from "./GettingStarted";
import { HomeScreen } from "./HomeScreen";
import type { GettingStartedState, Settings } from "../../lib/types";

// A server render reads zustand's SERVER snapshot — the store's INITIAL state
// object — not the live one, so `setState` alone wouldn't reach the markup.
// Arrange settings on that initial object (and mirror them into the live state)
// and put the pristine settings back after every test.
const INITIAL = useStore.getInitialState();
const PRISTINE_SETTINGS = INITIAL.settings;

function arrange(over: Partial<Settings>, gettingStarted: Partial<GettingStartedState> = {}) {
  const settings: Settings = {
    ...PRISTINE_SETTINGS,
    language: "en",
    ...over,
    gettingStarted: { ...DEFAULT_GETTING_STARTED, ...gettingStarted },
  };
  (INITIAL as { settings: Settings }).settings = settings;
  useStore.setState({ settings });
}

function renderChecklist(over: Partial<GettingStartedState>): string {
  return renderToStaticMarkup(
    createElement(GettingStarted, {
      state: { ...DEFAULT_GETTING_STARTED, ...over },
      latestId: null,
    }),
  );
}

const emptyTree = { summaries: [], personalFolders: [] } as unknown as LibraryTree;
const renderHome = () => renderToStaticMarkup(createElement(HomeScreen, { tree: emptyTree }));

beforeEach(() => arrange({}));
afterEach(() => {
  (INITIAL as { settings: Settings }).settings = PRISTINE_SETTINGS;
  useStore.setState(INITIAL, true);
});

describe("GettingStarted", () => {
  it("renders the four steps in order with the progress count", () => {
    const html = renderChecklist({ recorded: true });
    const steps = [...html.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);
    expect(steps).toEqual(["recorded", "filed", "replayed", "handedOff"]);
    expect(html).toContain("Do one lap, five minutes");
    expect(html).toMatch(/data-testid="gs-progress"[^>]*>1 \/ 4</);
  });

  it("ticks only the steps that are done, and drops their call to action", () => {
    const html = renderChecklist({ recorded: true, replayed: true });
    expect(html).toContain('data-step="recorded" data-done="true"');
    expect(html).toContain('data-step="filed" data-done="false"');
    expect(html).toContain('data-step="replayed" data-done="true"');
    // Done steps lose their CTA; pending ones keep theirs.
    expect(html).not.toContain("Open replay");
    expect(html).toContain("File it");
    expect(html).toContain("Show me");
  });

  it("offers the sample while nothing is recorded, leaving Start meeting to Home", () => {
    const html = renderChecklist({});
    expect(html).not.toContain("Start meeting");
    expect(html).toContain("Use the sample");
    expect(html).toMatch(/data-testid="gs-progress"[^>]*>0 \/ 4</);
  });

  it("speaks zh-TW by default", () => {
    arrange({ language: "zh-TW" });
    const html = renderChecklist({});
    expect(html).toContain("先跑一輪，5 分鐘");
    expect(html).toContain("不用了");
  });
});

const ALL_DONE = { recorded: true, filed: true, replayed: true, handedOff: true };

describe("HomeScreen checklist visibility", () => {
  it("shows the checklist for a fresh user, and the sample only once", () => {
    arrange({});
    const html = renderHome();
    expect(html).toContain('data-testid="getting-started"');
    // The empty-recordings box would offer the sample too — the checklist already does.
    expect(html.match(/Use the sample/g)).toHaveLength(1);
  });

  it("hides the checklist once dismissed, and the empty box offers the sample instead", () => {
    arrange({}, { dismissedAt: 1 });
    const html = renderHome();
    expect(html).not.toContain('data-testid="getting-started"');
    expect(html.match(/Use the sample/g)).toHaveLength(1);
  });

  it("hides the checklist once all four steps are done", () => {
    arrange({}, ALL_DONE);
    expect(renderHome()).not.toContain('data-testid="getting-started"');
  });

  it("points at voice typing once the lap is done, until that hint is seen", () => {
    arrange({ voiceTypingEnabled: true, hintsSeen: [] }, ALL_DONE);
    expect(renderHome()).toContain("Parley isn&#x27;t just for meetings");

    arrange({ voiceTypingEnabled: false, hintsSeen: [] }, ALL_DONE);
    expect(renderHome()).not.toContain("just for meetings");

    arrange({ voiceTypingEnabled: true, hintsSeen: ["home.voiceTyping"] }, ALL_DONE);
    expect(renderHome()).not.toContain("just for meetings");
  });
});
