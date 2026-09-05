import { describe, expect, it } from "vitest";
import { createNavHistory, type NavStatus } from "./history";
import { locationKey, type Location } from "./location";

/**
 * The back/forward contract, proven against a fake applier — the real one needs
 * a store, a window and a recording on disk, none of which the rules below
 * depend on.
 */

const home: Location = { kind: "home" };
const all: Location = { kind: "library", selection: { kind: "personal", node: { kind: "all" } } };
const voice: Location = { kind: "library", selection: { kind: "voice" } };
const folder = (id: string): Location => ({
  kind: "library",
  selection: { kind: "personal", node: { kind: "folder", folderId: id } },
});
const entry = (id: string): Location => ({ kind: "entry", id });

/**
 * A stand-in for the app: every location applies unless it is named in
 * `gone` (deleted recording) or `refuse` is on (a meeting owns the window).
 * Records what it was asked to do so a test can see the skipped ones.
 */
function fakeApp(opts: { gone?: string[]; refuse?: boolean } = {}) {
  const gone = new Set(opts.gone ?? []);
  const tried: string[] = [];
  return {
    tried,
    gone,
    refuse: !!opts.refuse,
    apply: async function (location: Location): Promise<NavStatus> {
      tried.push(locationKey(location));
      if (this.refuse) return "refused";
      if (location.kind === "entry" && gone.has(location.id)) return "unavailable";
      return "applied";
    },
  };
}

/** The stack under test, wired to a fake app. */
function setup(opts: { gone?: string[]; refuse?: boolean; limit?: number } = {}) {
  const app = fakeApp(opts);
  const history = createNavHistory({
    apply: (l) => app.apply(l),
    limit: opts.limit,
  });
  return { app, history };
}

describe("nav history", () => {
  it("walks back and forward through the places it recorded", async () => {
    const { history } = setup();
    history.record(home);
    history.record(all);
    history.record(folder("f1"));

    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(false);

    expect(await history.back()).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(all);
    expect(await history.back()).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(home);

    // The bottom of the stack is the bottom: back again is a no-op, not a wrap.
    expect(await history.back()).toEqual({ moved: false, skipped: 0 });
    expect(history.current()).toEqual(home);

    expect(await history.forward()).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(all);
    await history.forward();
    expect(history.current()).toEqual(folder("f1"));
    expect(await history.forward()).toEqual({ moved: false, skipped: 0 });
  });

  it("starts out with nowhere to go", async () => {
    const { history } = setup();
    expect(history.current()).toBeNull();
    expect(history.canGoBack()).toBe(false);
    expect(await history.back()).toEqual({ moved: false, skipped: 0 });

    history.record(home);
    // One entry is where you ARE, not somewhere you can go back to.
    expect(history.canGoBack()).toBe(false);
  });

  it("truncates the forward branch when you go somewhere new", async () => {
    const { history } = setup();
    history.record(home);
    history.record(all);
    history.record(folder("f1"));
    await history.back();
    await history.back();
    expect(history.canGoForward()).toBe(true);

    history.record(voice);
    expect(history.canGoForward()).toBe(false);
    expect(history.entries().map(locationKey)).toEqual([home, voice].map(locationKey));
  });

  it("ignores a re-visit of the place it is already on", () => {
    const { history } = setup();
    history.record(home);
    history.record(all);
    history.record({ kind: "library", selection: { kind: "personal", node: { kind: "all" } } });
    expect(history.entries()).toHaveLength(2);
  });

  it("drops the oldest entries past the cap", async () => {
    const { history } = setup({ limit: 3 });
    history.record(folder("a"));
    history.record(folder("b"));
    history.record(folder("c"));
    history.record(folder("d"));

    expect(history.entries().map(locationKey)).toEqual(
      [folder("b"), folder("c"), folder("d")].map(locationKey)
    );
    expect(history.current()).toEqual(folder("d"));
    await history.back();
    await history.back();
    expect(history.current()).toEqual(folder("b"));
    expect(history.canGoBack()).toBe(false);
  });

  it("skips a recording that was deleted, and forgets it", async () => {
    const { app, history } = setup({ gone: ["rec-2"] });
    history.record(home);
    history.record(entry("rec-2"));
    history.record(folder("f1"));

    // Back walks past the deleted recording to the next real place.
    expect(await history.back()).toEqual({ moved: true, skipped: 1 });
    expect(history.current()).toEqual(home);
    expect(app.tried).toEqual([locationKey(entry("rec-2")), locationKey(home)]);

    // And it is out of the stack, so going forward again doesn't retry it.
    app.tried.length = 0;
    expect(await history.forward()).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(folder("f1"));
    expect(app.tried).toEqual([locationKey(folder("f1"))]);
  });

  it("does not wedge when everything behind it is gone", async () => {
    const { history } = setup({ gone: ["a", "b"] });
    history.record(entry("a"));
    history.record(entry("b"));
    history.record(home);

    expect(await history.back()).toEqual({ moved: false, skipped: 2 });
    // Still standing where it was, with a stack that no longer holds the dead.
    expect(history.current()).toEqual(home);
    expect(history.entries()).toEqual([home]);
    expect(history.canGoBack()).toBe(false);
  });

  it("leaves the stack alone when the app refuses to move", async () => {
    const { app, history } = setup();
    history.record(home);
    history.record(entry("rec-1"));
    history.record(folder("f1"));

    // A meeting starts: navigation is declined, not impossible.
    app.refuse = true;
    expect(await history.back()).toEqual({ moved: false, skipped: 0 });
    expect(history.current()).toEqual(folder("f1"));
    expect(history.entries()).toHaveLength(3);

    // The meeting ends and the same press works, with nothing lost.
    app.refuse = false;
    expect(await history.back()).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(entry("rec-1"));
  });

  it("ignores a second traversal while one is still applying", async () => {
    const { history } = setup();
    history.record(home);
    history.record(all);
    history.record(folder("f1"));

    // Holding ⌘[ down: two presses land before the first load resolves.
    const first = history.back();
    const second = history.back();
    expect(await second).toEqual({ moved: false, skipped: 0 });
    expect(await first).toEqual({ moved: true, skipped: 0 });
    expect(history.current()).toEqual(all);
  });
});
