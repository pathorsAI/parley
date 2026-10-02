import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The host's press → release → settle → deliver lifecycle, against an
// in-memory event bus standing in for Tauri and a scripted backend. Every
// timing rule is unit-tested in settle.test.ts; this is about the orderings
// between them: a re-press during a polish, a close racing the stop, a cap
// racing the release, a previous session's late events.
const mocks = vi.hoisted(() => {
  type Handler = (e: { payload: unknown }) => void;
  return {
    handlers: new Map<string, Set<Handler>>(),
    emitted: [] as { name: string; payload: unknown }[],
    invoke: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {} as Record<string, unknown>,
    polish: {
      on: false,
      run: vi.fn(),
    },
  };
});

/** Deliver `payload` to every listener of `name`, as Tauri would. */
function fire(name: string, payload: unknown): void {
  for (const h of [...(mocks.handlers.get(name) ?? [])]) h({ payload });
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, h: (e: { payload: unknown }) => void) => {
    const set = mocks.handlers.get(name) ?? new Set();
    set.add(h);
    mocks.handlers.set(name, set);
    return () => set.delete(h);
  },
  emit: async (name: string, payload: unknown) => {
    mocks.emitted.push({ name, payload });
    fire(name, payload);
  },
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(async () => {}),
  unregister: vi.fn(async () => {}),
}));
vi.mock("../platform", () => ({ isMac: () => false }));
vi.mock("../tray", () => ({ TRAY_VOICE_TOGGLE_EVENT: "voicetyping://toggle" }));
vi.mock("../tauriEvents", () => ({ isTauri: () => true }));
vi.mock("../store", () => ({
  useStore: { getState: () => ({ settings: mocks.settings }) },
}));
vi.mock("../transcription/providers", () => ({
  sttApiKey: () => "token",
  sttRelayUrl: () => "wss://relay.test/stt",
}));
vi.mock("../transcription/languageHints", () => ({ languageHintsFromSettings: () => [] }));
vi.mock("../log", () => ({ log: mocks.log }));
vi.mock("../textNormalize", () => ({ normalizeTranscriptText: async (raw: string) => raw }));
vi.mock("../zhConvert", () => ({ preloadZhConverter: () => {} }));
vi.mock("./overlay", async (importActual) => ({
  ...(await importActual<typeof import("./overlay")>()),
  showOverlay: async () => {},
  hideOverlay: async () => {},
  prewarmOverlay: async () => {},
}));
vi.mock("./history", () => ({ appendVoiceEntry: vi.fn(async () => {}) }));
vi.mock("./polish", () => ({
  canPolish: () => mocks.polish.on,
  shouldPolish: () => true,
  polishTranscriptOutcome: (opts: { raw: string }) => mocks.polish.run(opts),
}));
vi.mock("../dictionary", () => ({
  addEntry: vi.fn(),
  applyReplacements: (s: string) => s,
  isIgnoredTwice: () => false,
  profileTerms: () => [],
  recognitionTerms: () => [],
  recordIgnore: vi.fn(),
  removeEntry: vi.fn(),
  removeVariant: vi.fn(),
  vocabularyTerms: () => [],
  whenDictionaryReady: async () => {},
}));
vi.mock("../dictionary/diffCorrection", () => ({ detectCorrection: () => null }));

/** The scripted backend: what each command does, and the session ids. */
const backend = {
  session: 0,
  pasteApp: "com.apple.Notes" as string | null,
  /** When set, `stop_voice_typing` waits for this before resolving. */
  stopGate: null as Promise<void> | null,
};

function routeInvoke(): void {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "start_voice_typing":
        backend.session += 1;
        // Rust announces the session before the command returns.
        fire("voicetyping://session", { phase: "start", session: backend.session });
        return undefined;
      case "stop_voice_typing":
        if (backend.stopGate) await backend.stopGate;
        return undefined;
      case "paste_to_frontmost":
        return { pasted: true, appBundleId: backend.pasteApp };
      case "observe_pasted_field":
        return false;
      default:
        return undefined;
    }
  });
}

/** Let every pending promise run, then move the clock by `ms`. */
async function tick(ms = 0): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function key(down: boolean): Promise<void> {
  fire("voicetyping://ptt", { down });
  await tick();
}

function segment(session: number, id: string, text: string, isFinal: boolean): void {
  fire("transcript://segment", {
    id: `voice-typing-${id}`,
    source: "voice-typing",
    text,
    is_final: isFinal,
    session,
  });
}

/** Rust's answer to the closing finalize: the last final, the cleared tail,
 *  then the close — in that order, from one task. */
function finish(session: number, id: string, text: string): void {
  segment(session, id, text, true);
  segment(session, "tail", "", false);
  fire("stt://closed", { source: "voice-typing", session });
}

function calls(cmd: string): unknown[] {
  return mocks.invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
}

function copied(): string[] {
  return calls("copy_to_clipboard").map((a) => (a as { text: string }).text);
}

function phases(): string[] {
  return mocks.emitted
    .filter((e) => e.name === "voicetyping://session")
    .map((e) => (e.payload as { phase: string }).phase);
}

function dones(): { message?: string; text?: string }[] {
  return mocks.emitted
    .filter((e) => e.name === "voicetyping://session")
    .map((e) => e.payload as { phase: string; message?: string; text?: string })
    .filter((p) => p.phase === "done")
    .map(({ message, text }) => ({ message, text }));
}

function settledReasons(): string[] {
  return [...mocks.log.info.mock.calls, ...mocks.log.warn.mock.calls]
    .filter((c) => c[0] === "voice-typing: settled" || c[0] === "voice-typing: dictation ended empty")
    .map((c) => (c[1] as { reason: string }).reason);
}

let cleanup: () => void = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.handlers.clear();
  mocks.emitted.length = 0;
  mocks.invoke.mockReset();
  for (const fn of Object.values(mocks.log)) fn.mockReset();
  mocks.polish.on = false;
  mocks.polish.run.mockReset();
  mocks.settings = {
    voiceTypingEnabled: true,
    voiceTypingMode: "hold",
    transcriptionProvider: "parley",
    voiceTypingShortcut: "Alt+Space",
    inputDevice: null,
  };
  backend.session = 0;
  backend.pasteApp = "com.apple.Notes";
  backend.stopGate = null;
  routeInvoke();
  vi.resetModules();
  const host = await import("./host");
  cleanup = host.initVoiceTyping();
  await tick();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("voice-typing host", () => {
  /** Regression: the relay answers a short tap seconds after the release, and
   *  the old quiet rule had already pasted nothing 60 ms after it. */
  it("waits for a short tap's answer and pastes it", async () => {
    await key(true);
    await tick(300);
    await key(false);
    expect(calls("stop_voice_typing")).toEqual([{ tail: true }]);

    await tick(2500);
    expect(copied()).toEqual([]);
    expect(dones()).toEqual([]);

    finish(1, "0", "好");
    await tick();
    expect(copied()).toEqual(["好"]);
    expect(dones()).toEqual([{ message: "ok", text: "好" }]);
    expect(settledReasons()).toEqual(["closed"]);
  });

  /** Regression: releasing on the last word pasted the interim text before
   *  the finalize's answer, without the last words. */
  it("does not deliver before the finalize answers a release mid-word", async () => {
    await key(true);
    segment(1, "0", "我們明天", true);
    segment(1, "tail", "見", false);
    await tick(1000);
    await key(false);

    await tick(1400);
    expect(copied()).toEqual([]);

    finish(1, "0", "我們明天見面");
    await tick();
    expect(copied()).toEqual(["我們明天見面"]);
  });

  it("falls back to quiet after a post-release answer when no close comes", async () => {
    await key(true);
    await key(false);
    await tick(800);
    segment(1, "0", "收到", true);
    segment(1, "tail", "", false);
    await tick(600);
    expect(copied()).toEqual([]);
    await tick(100);
    expect(copied()).toEqual(["收到"]);
    expect(settledReasons()).toEqual(["quiet"]);
  });

  it("gives up at the cap and says nothing was heard", async () => {
    await key(true);
    await key(false);
    await tick(5999);
    expect(dones()).toEqual([]);
    await tick(1);
    expect(dones()).toEqual([{ message: "empty", text: "" }]);
    expect(copied()).toEqual([]);
    expect(settledReasons()).toEqual(["timeout"]);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "voice-typing: dictation ended empty",
      expect.objectContaining({ reason: "timeout", closed: false, segments: 0 }),
    );
  });

  /** A re-press must open the mic at once, not behind the previous
   *  dictation's polish — and the two pastes still land in order. */
  it("restarts without waiting for the previous delivery, and keeps pastes in order", async () => {
    mocks.polish.on = true;
    mocks.polish.run.mockImplementation(
      (opts: { raw: string }) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: `${opts.raw}。`, outcome: "polished" }), 2000),
        ),
    );
    await key(true);
    segment(1, "0", "第一句話", true);
    await key(false);
    await tick(200);
    await key(true); // re-press while the first one is still settling

    expect(calls("start_voice_typing")).toHaveLength(2);
    expect(copied()).toEqual([]);
    expect(settledReasons()).toEqual(["restart"]);

    segment(2, "0", "第二句", true);
    await key(false);
    finish(2, "0", "第二句話");
    await tick();
    expect(copied()).toEqual([]); // queued behind the first delivery's polish

    await tick(2000);
    expect(copied()).toEqual(["第一句話。"]);
    await tick(2000);
    expect(copied()).toEqual(["第一句話。", "第二句話。"]);
    // Only the dictation that still owns the overlay ends it.
    expect(dones()).toEqual([{ message: "ok", text: "第二句話。" }]);
  });

  it("ignores the previous session's late close and segments after a re-press", async () => {
    await key(true);
    segment(1, "0", "舊的", true);
    await key(false);
    await key(true);
    fire("stt://closed", { source: "voice-typing", session: 1 });
    segment(1, "1", "舊的尾巴", true);
    segment(2, "0", "新的", true);
    await tick(500);
    await key(false);
    await tick(100);
    expect(copied()).toEqual(["舊的"]);

    finish(2, "0", "新的話");
    await tick();
    expect(copied()).toEqual(["舊的", "新的話"]);
  });

  it("cuts at the cap with no release tail, and ignores the real release", async () => {
    await key(true);
    segment(1, "0", "很長的一段話", true);
    await tick(600_000);
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
    expect(phases()).toContain("limit");

    await key(false);
    expect(calls("stop_voice_typing")).toHaveLength(1);
    finish(1, "0", "很長的一段話結束");
    await tick();
    expect(copied()).toEqual(["很長的一段話結束"]);
  });

  it("delivers what arrived before a mid-hold failure at once on release", async () => {
    await key(true);
    segment(1, "0", "說到一半", true);
    fire("voicetyping://error", { code: "connect", session: 1 });
    await key(false);
    await tick();
    expect(phases()).not.toContain("stop");
    expect(copied()).toEqual(["說到一半"]);
    expect(settledReasons()).toEqual(["failed"]);
  });

  it("delivers once when the close lands while the stop is still in flight", async () => {
    let releaseStop = () => {};
    backend.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    await key(true);
    fire("voicetyping://ptt", { down: false });
    await tick();
    finish(1, "0", "很快");
    await tick();
    expect(copied()).toEqual(["很快"]);

    releaseStop();
    await tick(6000);
    expect(copied()).toEqual(["很快"]);
    // No "finalizing" spinner after the dictation was already delivered.
    expect(phases().filter((p) => p !== "start")).toEqual(["done"]);
  });

  it("reports a paste that went to Parley itself as clipboard-only", async () => {
    backend.pasteApp = "com.pathors.parley";
    await key(true);
    await key(false);
    finish(1, "0", "貼到哪裡了");
    await tick();
    expect(copied()).toEqual(["貼到哪裡了"]);
    expect(dones()).toEqual([{ message: "clipboard-only", text: "貼到哪裡了" }]);
    expect(calls("observe_pasted_field")).toEqual([]);
  });

  it("toggle mode: a tap while the last dictation settles does not cut it again", async () => {
    mocks.settings.voiceTypingMode = "toggle";
    await key(true);
    await key(false);
    await key(true); // stop
    await key(false);
    await key(true); // during the settle window
    await key(false);
    expect(calls("start_voice_typing")).toHaveLength(1);
    expect(calls("stop_voice_typing")).toHaveLength(1);
    finish(1, "0", "切換模式");
    await tick();
    expect(copied()).toEqual(["切換模式"]);
  });
});
