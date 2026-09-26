import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ALL_HINT_IDS,
  DEFAULT_GETTING_STARTED,
  PERSIST_VERSION,
  migratePersistedState,
  mergePersistedState,
  useStore,
} from "./store";
import type { Settings } from "./types";

// The persist `migrate` + `merge` pair: what a user's saved localStorage turns
// into when a new build starts. Exercised directly as pure functions — the
// node test environment has no localStorage for zustand to hydrate from.

afterEach(() => vi.useRealTimers());

type Persisted = { settings: Partial<Settings>; cloudAuth?: unknown };
const current = () => useStore.getState();

describe("persist version", () => {
  it("is 4", () => {
    expect(PERSIST_VERSION).toBe(4);
  });
});

describe("migratePersistedState v3 → v4", () => {
  it("an existing onboarded user never sees the checklist or hints", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const out = migratePersistedState({ settings: { onboarded: true, userName: "Ann" } }, 3) as Persisted;
    expect(out.settings.gettingStarted).toEqual({ ...DEFAULT_GETTING_STARTED, dismissedAt: 1_700_000_000_000 });
    expect(out.settings.hintsSeen).toHaveLength(5);
    expect(new Set(out.settings.hintsSeen)).toEqual(new Set(ALL_HINT_IDS));
    expect(out.settings.userName).toBe("Ann");
  });

  it("a user who never finished the wizard gets the defaults", () => {
    for (const onboarded of [false, undefined]) {
      const persisted = { settings: { onboarded, userName: "Bo" } };
      const out = migratePersistedState(persisted, 3) as Persisted;
      expect(out.settings.gettingStarted).toBeUndefined();
      expect(out.settings.hintsSeen).toBeUndefined();

      const merged = mergePersistedState(out, current());
      expect(merged.settings.gettingStarted).toEqual(DEFAULT_GETTING_STARTED);
      expect(merged.settings.hintsSeen).toEqual([]);
      expect(merged.settings.userName).toBe("Bo");
    }
  });

  it("survives the full migrate → merge path for an onboarded user", () => {
    const out = migratePersistedState({ settings: { onboarded: true } }, 3);
    const merged = mergePersistedState(out, current());
    expect(merged.settings.gettingStarted.dismissedAt).toEqual(expect.any(Number));
    expect(merged.settings.hintsSeen).toHaveLength(5);
  });

  it("tolerates a v3 payload with no settings", () => {
    expect(() => migratePersistedState(undefined, 3)).not.toThrow();
    const merged = mergePersistedState(migratePersistedState({}, 3), current());
    expect(merged.settings.gettingStarted).toEqual(DEFAULT_GETTING_STARTED);
  });

  it("drops pre-v3 state, as zustand did before a migrate existed", () => {
    expect(migratePersistedState({ settings: { onboarded: true } }, 2)).toBeUndefined();
  });
});

describe("mergePersistedState backfill", () => {
  it("fills gettingStarted + hintsSeen when missing", () => {
    const merged = mergePersistedState({ settings: { onboarded: true } }, current());
    expect(merged.settings.gettingStarted).toEqual(DEFAULT_GETTING_STARTED);
    expect(merged.settings.hintsSeen).toEqual([]);
  });

  it("fills missing checklist keys and keeps the saved ones", () => {
    const merged = mergePersistedState(
      { settings: { gettingStarted: { recorded: true, dismissedAt: 42 } as never } },
      current(),
    );
    expect(merged.settings.gettingStarted).toEqual({ ...DEFAULT_GETTING_STARTED, recorded: true, dismissedAt: 42 });
  });

  it("falls back to defaults for a malformed shape", () => {
    const merged = mergePersistedState(
      { settings: { gettingStarted: "nope" as never, hintsSeen: "nope" as never } },
      current(),
    );
    expect(merged.settings.gettingStarted).toEqual(DEFAULT_GETTING_STARTED);
    expect(merged.settings.hintsSeen).toEqual([]);
  });

  it("keeps saved hints", () => {
    const merged = mergePersistedState({ settings: { hintsSeen: ["replay.seek"] } }, current());
    expect(merged.settings.hintsSeen).toEqual(["replay.seek"]);
  });

  it("handles nothing persisted at all", () => {
    const merged = mergePersistedState(undefined, current());
    expect(merged.settings.gettingStarted).toEqual(DEFAULT_GETTING_STARTED);
    expect(merged.settings.hintsSeen).toEqual([]);
  });
});
