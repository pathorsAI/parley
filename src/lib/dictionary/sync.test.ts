import { beforeEach, describe, expect, it, vi } from "vitest";

// Cross-window dictionary sync, against a fake file and a fake event bus. The
// bus delivers an emit to every listener — the sender's own included, as
// Tauri's does — so the "ignore my own broadcast" path is exercised for real.

type Handler = (e: { event: string; payload: unknown }) => void;

const fake = vi.hoisted(() => ({
  /** dictionary.json as the Rust side would read it. */
  file: "",
  reads: 0,
  /** When set, a read takes its snapshot immediately and resolves on this. */
  readGate: null as Promise<void> | null,
  /** When set, a write lands (and resolves) only once this resolves. */
  writeGate: null as Promise<void> | null,
  handlers: [] as { event: string; handler: Handler }[],
  focus: null as (() => void) | null,
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: { contents?: string }) => {
    if (cmd === "read_dictionary") {
      fake.reads += 1;
      const snapshot = fake.file;
      if (fake.readGate) await fake.readGate;
      return snapshot;
    }
    if (cmd === "write_dictionary") {
      if (fake.writeGate) await fake.writeGate;
      fake.file = args?.contents ?? "";
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
);
const emit = vi.hoisted(() =>
  vi.fn(async (event: string, payload: unknown) => {
    for (const h of fake.handlers.filter((x) => x.event === event)) h.handler({ event, payload });
  }),
);
const warn = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit,
  listen: vi.fn(async (event: string, handler: Handler) => {
    const entry = { event, handler };
    fake.handlers.push(entry);
    return () => {
      fake.handlers = fake.handlers.filter((x) => x !== entry);
    };
  }),
}));
vi.mock("../tauriEvents", () => ({ isTauri: () => true }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

const EVENT = "dictionary://updated";

function fileWith(...phrases: string[]): string {
  return JSON.stringify({
    entries: phrases.map((phrase, i) => ({
      id: `id-${phrase}`,
      phrase,
      variants: [],
      createdAt: i + 1,
      source: "manual",
    })),
    ignored: [],
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued promise chain (reads, the write chain, emits) run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Deliver a broadcast from somebody else (another window, or MCP). */
function foreignEvent(origin = "other-window"): void {
  for (const h of fake.handlers.filter((x) => x.event === EVENT)) {
    h.handler({ event: EVENT, payload: { origin } });
  }
}

/** A fresh module per test: the cache, `hydrated` and ORIGIN are module state. */
async function boot(file: string) {
  fake.file = file;
  const dict = await import("./index");
  await dict.initDictionary();
  await settle();
  return dict;
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockClear();
  emit.mockClear();
  warn.mockClear();
  fake.file = "";
  fake.reads = 0;
  fake.readGate = null;
  fake.writeGate = null;
  fake.handlers = [];
  fake.focus = null;
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === "focus") fake.focus = fn;
    }),
  });
});

describe("dictionary cross-window sync", () => {
  /** The overlay never takes focus, so this event is the only way an entry
   *  added elsewhere reaches the text it rewrites. */
  it("re-reads the file on a foreign broadcast", async () => {
    const dict = await boot(fileWith("Parley"));
    expect(dict.vocabularyTerms()).toEqual(["Parley"]);

    fake.file = fileWith("Parley", "派斯科技");
    foreignEvent("mcp");
    await settle();

    expect(dict.vocabularyTerms()).toEqual(["派斯科技", "Parley"]);
    expect(fake.reads).toBe(2);
  });

  it("does not re-read on its own broadcast", async () => {
    const dict = await boot(fileWith("Parley"));
    dict.addEntry({ phrase: "派斯科技", source: "manual" });
    await settle();

    // The write was announced with this window's origin…
    const announced = emit.mock.calls.find(([event]) => event === EVENT);
    expect(announced?.[1]).toEqual({ origin: expect.any(String) });
    // …and the window's own listener heard it without reading the file again.
    expect(fake.reads).toBe(1);
    expect(dict.vocabularyTerms()).toEqual(["派斯科技", "Parley"]);
  });

  /** A foreign event that lands while this window's write is still queued must
   *  not roll the cache back to the file without that write. */
  it("waits for its own pending write before re-reading", async () => {
    const dict = await boot(fileWith("Parley"));
    const write = deferred();
    fake.writeGate = write.promise;

    dict.addEntry({ phrase: "派斯科技", source: "manual" });
    foreignEvent();
    await settle();
    expect(fake.reads).toBe(1); // still queued behind the write
    expect(dict.vocabularyTerms()).toContain("派斯科技");

    write.resolve();
    await settle();
    expect(fake.reads).toBe(2);
    expect(dict.vocabularyTerms()).toContain("派斯科技");
  });

  it("drops a read that a local edit overtook", async () => {
    const dict = await boot(fileWith("Parley"));
    const read = deferred();
    fake.readGate = read.promise;

    foreignEvent(); // the read snapshots the file as it is now…
    await settle();
    dict.addEntry({ phrase: "派斯科技", source: "manual" }); // …then this lands
    fake.readGate = null;
    read.resolve();
    await settle();

    expect(dict.vocabularyTerms()).toContain("派斯科技");
  });

  /** write_config_file and the MCP server truncate, then write. */
  it("keeps the cache when a hydrated window reads an empty file", async () => {
    const dict = await boot(fileWith("Parley"));

    fake.file = "";
    foreignEvent();
    await settle();

    expect(dict.vocabularyTerms()).toEqual(["Parley"]);
    expect(warn).toHaveBeenCalledWith("dictionary: empty read ignored (a write was mid-flight)");
  });

  it("treats an empty file at boot as an empty, writable dictionary", async () => {
    const dict = await boot("");
    expect(dict.vocabularyTerms()).toEqual([]);

    dict.addEntry({ phrase: "Parley", source: "manual" });
    await settle();
    expect(JSON.parse(fake.file).entries).toHaveLength(1);
  });

  it("broadcasts from refreshDictionary only when the file changed", async () => {
    const dict = await boot(fileWith("Parley"));

    await dict.refreshDictionary();
    expect(emit).not.toHaveBeenCalled();

    fake.file = fileWith("Parley", "派斯科技");
    await dict.refreshDictionary();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(EVENT, { origin: expect.any(String) });
    expect(dict.vocabularyTerms()).toEqual(["派斯科技", "Parley"]);
  });

  it("refreshes on focus as a backstop", async () => {
    const dict = await boot(fileWith("Parley"));
    fake.file = fileWith("Parley", "派斯科技");

    fake.focus?.();
    await settle();

    expect(dict.vocabularyTerms()).toEqual(["派斯科技", "Parley"]);
    expect(emit).toHaveBeenCalledWith(EVENT, { origin: expect.any(String) });
  });

  /** DictionarySettings re-renders from this callback, own writes included. */
  it("calls an update listener on own and foreign broadcasts, fresh in both cases", async () => {
    const dict = await boot(fileWith("Parley"));
    const seen: string[][] = [];
    await dict.listenForDictionaryUpdated(() => seen.push(dict.vocabularyTerms()));

    dict.addEntry({ phrase: "派斯科技", source: "manual" });
    await settle();
    expect(seen).toEqual([["派斯科技", "Parley"]]);
    expect(fake.reads).toBe(1);

    fake.file = fileWith("Parley", "派斯科技", "Ming");
    foreignEvent();
    await settle();
    expect(seen[seen.length - 1]).toEqual(["Ming", "派斯科技", "Parley"]);
  });
});
