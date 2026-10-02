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
    hide: vi.fn(async () => {}),
    append: vi.fn<(text: string, appBundleId: string | null) => Promise<void>>(async () => {}),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {} as Record<string, unknown>,
    polish: {
      on: false,
      run: vi.fn(),
      /** The length gate; every text passes unless a test installs the real
       *  one (most tests dictate a few characters with polish on). */
      gate: null as ((text: string) => boolean) | null,
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
  hideOverlay: () => mocks.hide(),
  prewarmOverlay: async () => {},
}));
vi.mock("./history", () => ({
  appendVoiceEntry: (text: string, appBundleId: string | null) => mocks.append(text, appBundleId),
}));
vi.mock("./polish", () => ({
  canPolish: () => mocks.polish.on,
  shouldPolish: (text: string) => mocks.polish.gate?.(text) ?? true,
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
  /** What `insert_text` says about the paste: false when Rust left the text
   *  on the clipboard (no Accessibility, UIPI). */
  pasted: true,
  /** When set, `stop_voice_typing` waits for this before resolving. */
  stopGate: null as Promise<void> | null,
  /** When set, `start_voice_typing` waits for this, then fails with it. */
  startFailure: null as { gate: Promise<void>; error: string } | null,
  /** When set, `start_voice_typing` waits for this, then succeeds. */
  startGate: null as Promise<void> | null,
};

function routeInvoke(): void {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "start_voice_typing":
        if (backend.startFailure) {
          await backend.startFailure.gate;
          throw new Error(backend.startFailure.error);
        }
        if (backend.startGate) await backend.startGate;
        backend.session += 1;
        // Rust announces the session before the command returns.
        fire("voicetyping://session", { phase: "start", session: backend.session });
        return undefined;
      case "stop_voice_typing":
        if (backend.stopGate) await backend.stopGate;
        return undefined;
      case "insert_text":
        return { pasted: backend.pasted, appBundleId: backend.pasteApp };
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

/** What was typed into the field (the normal delivery). */
function inserted(): string[] {
  return calls("insert_text").map((a) => (a as { text: string }).text);
}

/** What was explicitly copied to the clipboard (Undo, the Copy button). */
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
/** The commands the host invoked while it booted; cleared from the mock
 *  afterwards, so every test reads only what its own presses caused. */
let bootCalls: unknown[][] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.handlers.clear();
  mocks.emitted.length = 0;
  mocks.invoke.mockReset();
  for (const fn of Object.values(mocks.log)) fn.mockReset();
  mocks.hide.mockClear();
  mocks.append.mockClear();
  mocks.polish.on = false;
  mocks.polish.run.mockReset();
  mocks.polish.gate = null;
  mocks.settings = {
    voiceTypingEnabled: true,
    voiceTypingMode: "hold",
    transcriptionProvider: "parley",
    voiceTypingShortcut: "Alt+Space",
    inputDevice: null,
  };
  backend.session = 0;
  backend.pasteApp = "com.apple.Notes";
  backend.pasted = true;
  backend.stopGate = null;
  backend.startFailure = null;
  backend.startGate = null;
  routeInvoke();
  vi.resetModules();
  const host = await import("./host");
  cleanup = host.initVoiceTyping();
  await tick();
  bootCalls = [...mocks.invoke.mock.calls];
  mocks.invoke.mockClear();
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
    expect(inserted()).toEqual([]);
    expect(dones()).toEqual([]);

    finish(1, "0", "好");
    await tick();
    expect(inserted()).toEqual(["好"]);
    // The insert is the delivery: nothing is copied to the clipboard to stay.
    expect(copied()).toEqual([]);
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
    expect(inserted()).toEqual([]);

    finish(1, "0", "我們明天見面");
    await tick();
    expect(inserted()).toEqual(["我們明天見面"]);
  });

  it("falls back to quiet after a post-release answer when no close comes", async () => {
    await key(true);
    await key(false);
    await tick(800);
    segment(1, "0", "收到", true);
    segment(1, "tail", "", false);
    await tick(600);
    expect(inserted()).toEqual([]);
    await tick(100);
    expect(inserted()).toEqual(["收到"]);
    expect(settledReasons()).toEqual(["quiet"]);
  });

  it("gives up at the cap and says nothing was heard", async () => {
    await key(true);
    await key(false);
    await tick(5999);
    expect(dones()).toEqual([]);
    await tick(1);
    expect(dones()).toEqual([{ message: "empty", text: "" }]);
    expect(inserted()).toEqual([]);
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
    expect(inserted()).toEqual([]);
    expect(settledReasons()).toEqual(["restart"]);

    segment(2, "0", "第二句", true);
    await key(false);
    finish(2, "0", "第二句話");
    await tick();
    expect(inserted()).toEqual([]); // queued behind the first delivery's polish

    await tick(2000);
    expect(inserted()).toEqual(["第一句話。"]);
    await tick(2000);
    expect(inserted()).toEqual(["第一句話。", "第二句話。"]);
    // Only the dictation that still owns the overlay ends it.
    expect(dones()).toEqual([{ message: "ok", text: "第二句話。" }]);
  });

  /** Regression: softening drops a 7-character phrase's 。 (8 units → 7) and
   *  the space after a full-width mark, which took these under the real
   *  MIN_POLISH_CHARS gate, so polish — and its speaker-name repair — stopped
   *  running on them. The gate measures the text as the recognizer gave it;
   *  the softened text is still what is polished and pasted. */
  it.each([
    { finals: ["我們明天見個面。"], softened: "我們明天見個面", stt: "我們明天見個面。" },
    { finals: ["好的。", " 我知道。"], softened: "好的，我知道。", stt: "好的。 我知道。" },
  ])("polishes $stt although softening takes it under the length gate", async (c) => {
    mocks.polish.gate = (await vi.importActual<typeof import("./polish")>("./polish")).shouldPolish;
    expect(mocks.polish.gate(c.softened)).toBe(false);
    mocks.polish.on = true;
    mocks.polish.run.mockImplementation(async (opts: { raw: string }) => ({
      text: `${opts.raw}！`,
      outcome: "polished",
    }));
    await key(true);
    await key(false);
    c.finals.slice(0, -1).forEach((f, i) => segment(1, String(i), f, true));
    finish(1, String(c.finals.length - 1), c.finals[c.finals.length - 1]);
    await tick();
    expect(mocks.polish.run).toHaveBeenCalledTimes(1);
    expect(mocks.polish.run.mock.calls[0][0]).toMatchObject({ raw: c.softened, gateText: c.stt });
    expect(inserted()).toEqual([`${c.softened}！`]);
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
    expect(inserted()).toEqual(["舊的"]);

    finish(2, "0", "新的話");
    await tick();
    expect(inserted()).toEqual(["舊的", "新的話"]);
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
    expect(inserted()).toEqual(["很長的一段話結束"]);
  });

  it("delivers what arrived before a mid-hold failure at once on release", async () => {
    await key(true);
    segment(1, "0", "說到一半", true);
    fire("voicetyping://error", { code: "connect", session: 1 });
    await key(false);
    await tick();
    expect(phases()).not.toContain("stop");
    expect(inserted()).toEqual(["說到一半"]);
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
    expect(inserted()).toEqual(["很快"]);

    releaseStop();
    await tick(6000);
    expect(inserted()).toEqual(["很快"]);
    // No "finalizing" spinner after the dictation was already delivered.
    expect(phases().filter((p) => p !== "start")).toEqual(["done"]);
  });

  /** Rust decides (Accessibility, UIPI); the host only reports it, and does
   *  not watch a field nothing was pasted into. */
  it("reports an insert Rust could not paste as clipboard-only", async () => {
    backend.pasted = false;
    await key(true);
    await key(false);
    finish(1, "0", "貼到哪裡了");
    await tick();
    expect(inserted()).toEqual(["貼到哪裡了"]);
    expect(dones()).toEqual([{ message: "clipboard-only", text: "貼到哪裡了" }]);
    expect(calls("observe_pasted_field")).toEqual([]);
    expect(mocks.append).toHaveBeenCalledWith("貼到哪裡了", "com.apple.Notes");
  });

  /** Regression: a paste into Parley's own Ask box was reported as
   *  clipboard-only, so the overlay said to press ⌘V for text that was
   *  already in the field, and a user who did got it twice. */
  it("a dictation into one of Parley's own fields is inserted like any other", async () => {
    backend.pasteApp = "com.pathors.parley";
    await key(true);
    await key(false);
    finish(1, "0", "幫我整理待辦事項");
    await tick();
    expect(inserted()).toEqual(["幫我整理待辦事項"]);
    expect(dones()).toEqual([{ message: "ok", text: "幫我整理待辦事項" }]);
    expect(calls("observe_pasted_field")).toEqual([{ insertedText: "幫我整理待辦事項" }]);
    expect(mocks.append).toHaveBeenCalledWith("幫我整理待辦事項", "com.pathors.parley");
  });

  it("watches the field a pasted dictation landed in", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "看得到嗎");
    await tick();
    expect(calls("observe_pasted_field")).toEqual([{ insertedText: "看得到嗎" }]);
  });

  /** Regression: the tap was swallowed while the last dictation waited for
   *  the recognizer's answer (1–6 s), so the next sentence was never
   *  recorded — and the tap after it, meant as a stop, started a recording. */
  it("toggle mode: a tap while the last dictation settles starts the next one", async () => {
    mocks.settings.voiceTypingMode = "toggle";
    await key(true);
    await key(false);
    await key(true); // stop
    await key(false);
    segment(1, "0", "切換模式", true);
    await tick(1000);
    await key(true); // during the settle window: the next sentence
    await key(false);
    expect(calls("start_voice_typing")).toHaveLength(2);
    expect(calls("stop_voice_typing")).toHaveLength(1);
    expect(settledReasons()).toEqual(["restart"]);
    expect(inserted()).toEqual(["切換模式"]);

    // …and the tap after that stops it, as the user meant.
    segment(2, "0", "下一句", true);
    await key(true);
    await key(false);
    expect(calls("start_voice_typing")).toHaveLength(2);
    expect(calls("stop_voice_typing")).toEqual([{ tail: true }, { tail: true }]);
    finish(2, "0", "下一句話");
    await tick();
    expect(inserted()).toEqual(["切換模式", "下一句話"]);
  });
});

async function escape(fromTrigger = false): Promise<void> {
  fire("voicetyping://cancel", { fromTrigger });
  await tick();
}

async function undo(): Promise<void> {
  fire("voicetyping://cancel-action", { action: "undo" });
  await tick();
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1];
}

/** Every arm/disarm the host asked Rust for, in order. */
function armed(): boolean[] {
  return calls("set_voice_typing_cancel_armed").map((a) => (a as { armed: boolean }).armed);
}

/** A polish round trip of `ms` that gives up the moment its signal aborts. */
function slowPolish(ms: number) {
  return (opts: { raw: string; signal?: AbortSignal }) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ text: `${opts.raw}。`, outcome: "polished" }), ms);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({ text: null, outcome: "cancelled" });
      });
    });
}

describe("voice-typing host: Esc cancels, Undo copies", () => {
  it("cancels a held dictation: the mic stops at once, nothing is delivered, the key-up is a no-op", async () => {
    await key(true);
    expect(armed()).toEqual([true]);
    segment(1, "0", "不要了", true);
    await escape();
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
    expect(phases()).toContain("cancelled");
    expect(armed()).toEqual([true, false]);

    await key(false);
    expect(calls("stop_voice_typing")).toHaveLength(1);
    finish(1, "0", "不要了");
    await tick(4999);
    expect(copied()).toEqual([]);
    expect(inserted()).toEqual([]);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(dones()).toEqual([]);
    // No "finalizing" spinner over the Undo.
    expect(phases()).not.toContain("stop");
    expect(mocks.hide).not.toHaveBeenCalled();

    // The offer runs out: the overlay goes, and nothing was saved.
    await tick(1);
    expect(mocks.hide).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("Undo before the text settles copies it once it does, and never pastes", async () => {
    await key(true);
    segment(1, "0", "先取消", true);
    await escape();
    await undo();
    expect(last(phases())).toBe("stop");

    finish(1, "0", "先取消再復原");
    await tick();
    expect(copied()).toEqual(["先取消再復原"]);
    expect(inserted()).toEqual([]);
    expect(calls("observe_pasted_field")).toEqual([]);
    expect(mocks.append).toHaveBeenCalledWith("先取消再復原", null);
    expect(dones()).toEqual([{ message: "recovered", text: "先取消再復原" }]);

    // The offer's clock stopped at the Undo: only the done's own hide follows.
    await tick(6000);
    expect(mocks.hide).toHaveBeenCalledTimes(1);
  });

  it("Undo after the text settled copies it at once, and a second Undo does nothing", async () => {
    await key(true);
    await escape();
    finish(1, "0", "已經好了");
    await tick();
    expect(copied()).toEqual([]);

    await undo();
    expect(copied()).toEqual(["已經好了"]);
    await undo();
    expect(copied()).toEqual(["已經好了"]);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it("Undo on a cancel that heard nothing says there is nothing to recover", async () => {
    await key(true);
    await escape();
    finish(1, "0", "");
    await tick();
    await undo();
    expect(copied()).toEqual([]);
    expect(dones()).toEqual([{ message: "nothing", text: "" }]);
  });

  it("a server close racing the Esc still stops the mic, and a failure keeps the Undo", async () => {
    await key(true);
    segment(1, "0", "說完了", true);
    fire("voicetyping://cancel", { fromTrigger: false });
    fire("voicetyping://error", { code: "connect", session: 1 });
    fire("stt://closed", { source: "voice-typing", session: 1 });
    await tick();
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
    expect(phases()).not.toContain("error");
    expect(last(phases())).toBe("cancelled");

    await undo();
    expect(copied()).toEqual(["說完了"]);
  });

  it("Esc during the polish abandons it and pastes nothing; Undo polishes it again", async () => {
    mocks.polish.on = true;
    mocks.polish.run.mockImplementation(slowPolish(2000));
    await key(true);
    segment(1, "0", "潤飾到一半", true);
    await key(false);
    finish(1, "0", "潤飾到一半取消");
    await tick(500);
    expect(last(phases())).toBe("polishing");

    await escape();
    const first = mocks.polish.run.mock.calls[0][0] as { signal?: AbortSignal };
    expect(first.signal?.aborted).toBe(true);
    expect(last(phases())).toBe("cancelled");
    await tick(3000);
    expect(copied()).toEqual([]);
    expect(inserted()).toEqual([]);
    expect(mocks.log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("polish"),
      expect.anything(),
    );

    await undo();
    expect(last(phases())).toBe("polishing");
    await tick(2000);
    expect(copied()).toEqual(["潤飾到一半取消。"]);
    expect(inserted()).toEqual([]);
    expect(dones()).toEqual([{ message: "recovered", text: "潤飾到一半取消。" }]);
  });

  it.each(["timedOut", "failed"] as const)(
    "an Undo whose polish %s copies the text as dictated, and says so",
    async (outcome) => {
      mocks.polish.on = true;
      // The dictation's own pass is abandoned by the Esc; the Undo's breaks.
      mocks.polish.run
        .mockImplementationOnce(slowPolish(2000))
        .mockImplementationOnce(async () => ({ text: null, outcome }));
      await key(true);
      await key(false);
      finish(1, "0", "潤飾沒有回來的一句話");
      await tick(500);
      await escape();
      await tick(1000);

      await undo();
      expect(mocks.polish.run).toHaveBeenCalledTimes(2);
      expect(copied()).toEqual(["潤飾沒有回來的一句話"]);
      expect(mocks.append).toHaveBeenCalledWith("潤飾沒有回來的一句話", null);
      // Not the plain "copied": the user just sat through "polishing…".
      expect(dones()).toEqual([{ message: "recovered-unpolished", text: "潤飾沒有回來的一句話" }]);
    },
  );

  it("a polish that came back despite the Esc is not run again on Undo", async () => {
    mocks.polish.on = true;
    // The answer was already on its way: the abort does not stop it.
    mocks.polish.run.mockImplementation(
      (opts: { raw: string }) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: `${opts.raw}。`, outcome: "polished" }), 1000),
        ),
    );
    await key(true);
    await key(false);
    finish(1, "0", "已經潤飾好的一句話");
    await tick(500);
    await escape();
    await tick(1000);
    expect(copied()).toEqual([]);
    await undo();
    expect(copied()).toEqual(["已經潤飾好的一句話。"]);
    expect(mocks.polish.run).toHaveBeenCalledTimes(1);
  });

  it("an Undo measures the polish gate on the cancelled dictation's unsoftened text", async () => {
    mocks.polish.gate = (await vi.importActual<typeof import("./polish")>("./polish")).shouldPolish;
    mocks.polish.on = true;
    mocks.polish.run.mockImplementation(async (opts: { raw: string }) => ({
      text: `${opts.raw}！`,
      outcome: "polished",
    }));
    await key(true);
    await escape(); // before it settles: its delivery holds the text unpolished
    finish(1, "0", "我們明天見個面。");
    await tick();
    expect(mocks.polish.run).not.toHaveBeenCalled();

    await undo();
    expect(mocks.polish.run).toHaveBeenCalledTimes(1);
    expect(mocks.polish.run.mock.calls[0][0]).toMatchObject({
      raw: "我們明天見個面",
      gateText: "我們明天見個面。",
    });
    expect(copied()).toEqual(["我們明天見個面！"]);
  });

  it("an Esc racing a re-press cancels the old dictation, not the new one's key-up", async () => {
    await key(true);
    segment(1, "0", "第一句", true);
    await key(false); // settling
    // The press is queued; the Esc lands before it runs.
    fire("voicetyping://ptt", { down: true });
    fire("voicetyping://cancel", { fromTrigger: false });
    await tick();
    expect(calls("start_voice_typing")).toHaveLength(2);

    segment(2, "0", "第二句", true);
    await key(false);
    expect(calls("stop_voice_typing")).toEqual([{ tail: true }, { tail: true }]);
    finish(2, "0", "第二句話");
    await tick();
    expect(inserted()).toEqual(["第二句話"]);
  });

  it("a delivery reaching the clipboard never disarms Esc for the dictation after it", async () => {
    mocks.polish.on = true;
    mocks.polish.run.mockImplementation(slowPolish(2000));
    await key(true);
    await key(false);
    finish(1, "0", "第一句話");
    await tick(100);
    expect(last(phases())).toBe("polishing");

    await key(true); // the next dictation, while the first one polishes
    await tick(2000);
    expect(inserted()).toEqual(["第一句話。"]);
    expect(armed()).toEqual([true, true]);

    // …and Esc still cancels the new one.
    await escape();
    expect(last(phases())).toBe("cancelled");
    expect(calls("stop_voice_typing")).toEqual([{ tail: true }, { tail: false }]);
  });

  it("disarms Esc once the text is sent to the field", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "照常貼上");
    await tick();
    expect(inserted()).toEqual(["照常貼上"]);
    expect(armed()).toEqual([true, false]);
  });

  it("a new press drops a cancelled dictation still on offer and starts fresh", async () => {
    await key(true);
    segment(1, "0", "舊的", true);
    await escape();
    await key(false);
    await key(true); // during the offer, before the first one settled
    expect(calls("start_voice_typing")).toHaveLength(2);
    expect(mocks.log.info).toHaveBeenCalledWith("voice-typing: cancelled dictation discarded", {
      reason: "new press",
    });

    await undo(); // a stale click: nothing is on offer any more
    finish(1, "0", "舊的");
    segment(2, "0", "新的", true);
    await key(false);
    finish(2, "0", "新的");
    await tick(6000);
    expect(inserted()).toEqual(["新的"]);
    expect(copied()).toEqual([]);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it("a new press still recovers a cancel whose Undo was already asked", async () => {
    await key(true);
    segment(1, "0", "要回來的", true);
    await escape();
    await undo(); // before it settled
    await key(false);
    await key(true); // the restart settles it on the spot
    expect(copied()).toEqual(["要回來的"]);
    expect(inserted()).toEqual([]);
  });

  it("toggle mode: a tap after Esc starts a fresh dictation at once", async () => {
    mocks.settings.voiceTypingMode = "toggle";
    await key(true);
    await key(false);
    await escape();
    await key(true); // the cancelled one has not settled yet
    await key(false);
    expect(calls("start_voice_typing")).toHaveLength(2);
    expect(mocks.log.info).toHaveBeenCalledWith("voice-typing: cancelled dictation discarded", {
      reason: "new press",
    });
  });

  it("an Esc the Windows hook swallowed under the held trigger settles its silent release", async () => {
    await key(true);
    await escape(true);
    expect(phases()).toContain("cancelled");
    // The hook never reports this hold's release; the next press still works.
    await key(true);
    expect(calls("start_voice_typing")).toHaveLength(2);
  });

  it("toggle mode: the hook's Esc under the held stop tap re-arms the next tap", async () => {
    mocks.settings.voiceTypingMode = "toggle";
    await key(true);
    await key(false);
    await key(true); // the stop tap, still held…
    await escape(true); // …when Esc cancels it; its release is never reported
    finish(1, "0", "切換取消");
    await tick();
    expect(inserted()).toEqual([]);
    expect(copied()).toEqual([]);
    await key(true);
    expect(calls("start_voice_typing")).toHaveLength(2);
  });

  it("the hook's Esc with nothing to cancel is the plain stop it used to be", async () => {
    let failStart = () => {};
    backend.startFailure = {
      gate: new Promise<void>((resolve) => {
        failStart = resolve;
      }),
      error: "mic busy",
    };
    await key(true);
    failStart();
    await tick();
    expect(phases()).toContain("error");
    // The hold is still down as far as the host knows, and the hook silenced
    // its release: the Esc must count as that release.
    backend.startFailure = null;
    await escape(true);
    await key(true);
    expect(calls("start_voice_typing")).toHaveLength(2);
  });

  it("an Esc during a start that fails leaves the error, not an Undo", async () => {
    let failStart = () => {};
    backend.startFailure = {
      gate: new Promise<void>((resolve) => {
        failStart = resolve;
      }),
      error: "mic busy",
    };
    fire("voicetyping://ptt", { down: true });
    await tick();
    await escape();
    failStart();
    await tick();
    expect(phases()).toContain("error");
    expect(phases()).not.toContain("cancelled");
    expect(last(armed())).toBe(false);
  });

  it("an Esc while the mic is still opening cuts it once it has", async () => {
    let opened = () => {};
    backend.startGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    fire("voicetyping://ptt", { down: true });
    await tick();
    await escape();
    expect(calls("stop_voice_typing")).toEqual([]);
    opened();
    await tick();
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
    expect(phases()).toContain("cancelled");
    await key(false);
    expect(calls("stop_voice_typing")).toHaveLength(1);
  });

  it("an idle Esc does nothing", async () => {
    await escape();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(phases()).toEqual([]);
  });

  /** Regression: Rust keeps Esc armed across a webview reload or a rebuilt
   *  main window, and the new host's shortcut call registered it again for a
   *  dictation it knew nothing about — Esc then did nothing in any app. */
  it("a fresh host hands Esc back before it applies the shortcut", async () => {
    const boot = bootCalls.map((c) => c[0]);
    expect(boot.indexOf("set_voice_typing_cancel_armed")).toBeLessThan(
      boot.indexOf("set_voice_typing_shortcut"),
    );
    expect(bootCalls.filter((c) => c[0] === "set_voice_typing_cancel_armed")).toEqual([
      ["set_voice_typing_cancel_armed", { armed: false }],
    ]);
  });

  /** Regression: the Esc marked the dictation cancelled the moment it
   *  arrived, so the stop tap queued AHEAD of it (behind a slow mic open)
   *  read "cancelled" and started a fresh recording instead of stopping. */
  it("toggle mode: a stop tap queued before an Esc still stops, and the Esc cancels", async () => {
    mocks.settings.voiceTypingMode = "toggle";
    let opened = () => {};
    backend.startGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    await key(true); // the mic is still opening…
    await key(false);
    fire("voicetyping://ptt", { down: true }); // …the stop tap queues behind it,
    fire("voicetyping://cancel", { fromTrigger: false }); // then the Esc
    opened();
    await tick();
    expect(calls("start_voice_typing")).toHaveLength(1);
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
    expect(last(phases())).toBe("cancelled");
    expect(phases()).not.toContain("stop");

    await undo();
    finish(1, "0", "停下來再取消");
    await tick();
    expect(copied()).toEqual(["停下來再取消"]);
    expect(inserted()).toEqual([]);
  });

  it("the hosted cap does not override a cancel", async () => {
    await key(true);
    await escape();
    await tick(600_000);
    expect(phases()).not.toContain("limit");
    expect(calls("stop_voice_typing")).toEqual([{ tail: false }]);
  });
});

async function copyAction(): Promise<void> {
  fire("voicetyping://done-action", { action: "copy" });
  await tick();
}

describe("voice-typing host: Copy on the confirmation", () => {
  it("copies the inserted text, says so, and keeps the overlay up to say it", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "沒有地方可以貼");
    await tick();
    expect(dones()).toEqual([{ message: "ok", text: "沒有地方可以貼" }]);

    await tick(2000);
    await copyAction();
    expect(copied()).toEqual(["沒有地方可以貼"]);
    expect(last(dones())).toEqual({ message: "copied", text: "沒有地方可以貼" });
    // The hide the insert scheduled gives way to a fresh one from the click.
    await tick(1000);
    expect(mocks.hide).not.toHaveBeenCalled();
    await tick(1900);
    expect(mocks.hide).toHaveBeenCalledTimes(1);
  });

  it("ignores a click that arrives after the next press", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "上一句");
    await tick();
    await key(true);
    await copyAction();
    expect(copied()).toEqual([]);
    expect(dones()).toEqual([{ message: "ok", text: "上一句" }]);
  });

  it("copies the newest dictation, never an older one", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "第一句");
    await tick();
    await key(true);
    await key(false);
    finish(2, "0", "第二句");
    await tick();
    await copyAction();
    expect(copied()).toEqual(["第二句"]);
  });

  it("has nothing to copy before a dictation was inserted, or after an empty one", async () => {
    await copyAction();
    await key(true);
    await key(false);
    finish(1, "0", "");
    await tick();
    expect(dones()).toEqual([{ message: "empty", text: "" }]);
    await copyAction();
    expect(copied()).toEqual([]);
    expect(phases()).not.toContain("copied");
  });

  it("does not confirm, or hold the overlay, when the copy fails", async () => {
    await key(true);
    await key(false);
    finish(1, "0", "複製不了");
    await tick();
    mocks.invoke.mockImplementationOnce(async () => {
      throw new Error("clipboard is held by another process");
    });
    await copyAction();
    expect(copied()).toEqual(["複製不了"]);
    expect(mocks.log.error).toHaveBeenCalledWith("voice-typing: copy failed", expect.anything());
    expect(dones()).toEqual([{ message: "ok", text: "複製不了" }]);
    await tick(2900);
    expect(mocks.hide).toHaveBeenCalledTimes(1);
  });
});
