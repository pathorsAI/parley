import { beforeEach, describe, expect, it, vi } from "vitest";

// The sweep's tombstone handling, end to end against a fake cloud: which ids it
// pushes, what a 410 does, and that overlapping sweeps share one run. Every
// native / network seam is stubbed; the bookkeeping (./syncState) is real, over a
// Map-backed localStorage.

const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});
// The audio read goes through the webview asset channel (fetch(convertFileSrc)).
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })),
);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: vi.fn(async (cmd: string, args: { id: string }) => {
    if (cmd !== "read_history_entry") throw new Error(`unexpected invoke ${cmd}`);
    return { meta: { id: args.id }, audioPath: audioIds.has(args.id) ? `/a/${args.id}.ogg` : null };
  }),
}));
vi.mock("../tauriEvents", () => ({ isTauri: () => true }));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../history/history", () => ({
  buildSummary: (m: { id: string }) => ({ id: m.id }),
  listHistory: vi.fn(async () => localEntries),
  deleteHistoryEntry: vi.fn(async () => {}),
}));
vi.mock("../onboarding/sample", () => ({
  isSampleEntry: (e: { id: string }) => e.id.startsWith("sample-"),
}));
vi.mock("./client", () => {
  class CloudError extends Error {
    constructor(
      message: string,
      readonly code: string | null,
      readonly status: number,
    ) {
      super(message);
      this.name = "CloudError";
    }
  }
  return {
    CLOUD_URL: "https://cloud.test",
    CloudError,
    cloudToken: () => "token",
    syncEnabled: () => true,
    isAuthError: (e: unknown) => e instanceof Error && /\bauth\b/.test(e.message),
    cloudFetch: vi.fn(async (path: string, init?: RequestInit) => fakeCloud(path, init, CloudError)),
  };
});

// ── The fake cloud ───────────────────────────────────────────────────────────
interface Row {
  id: string;
  updatedAt: number;
}
let localEntries: { id: string; createdAt: number; title: string }[] = [];
const audioIds = new Set<string>();
let cloudRows: Row[] = [];
/** undefined = an older server that doesn't report tombstones at all. */
let tombstones: string[] | undefined;
/** Ids the server answers 410 for (on PUT audio and POST meta). */
let goneOnServer = new Set<string>();
let calls: string[] = [];
let listGate: Promise<void> = Promise.resolve();

async function fakeCloud(
  path: string,
  init: RequestInit | undefined,
  CloudError: new (m: string, c: string | null, s: number) => Error,
): Promise<Response> {
  const method = init?.method ?? "GET";
  calls.push(`${method} ${path}`);
  if (method === "GET" && path === "/recordings") {
    await listGate;
    const body = tombstones === undefined ? { recordings: cloudRows } : { recordings: cloudRows, tombstones };
    return new Response(JSON.stringify(body));
  }
  const m = /^\/recordings\/([^/]+)(\/audio|\/share)?$/.exec(path);
  if (!m) throw new Error(`unexpected ${method} ${path}`);
  const [, id, sub] = m;
  if ((method === "PUT" && sub === "/audio") || (method === "POST" && !sub)) {
    if (goneOnServer.has(id)) throw new CloudError(`cloud ${method} ${path} → 410`, null, 410);
    return new Response(JSON.stringify({ updatedAt: 1000 }));
  }
  if (method === "DELETE") return new Response("{}");
  if (method === "POST" && sub === "/share") {
    return new Response(JSON.stringify({ recording: { id: `org-${id}` } }));
  }
  throw new Error(`unexpected ${method} ${path}`);
}

const local = (id: string) => ({ id, createdAt: 1, title: id });
const pushesOf = (id: string) => calls.filter((c) => c.endsWith(`/recordings/${id}`) || c.includes(`/recordings/${id}/audio`));

const sync = await import("./sync");
const { markCloudGone, markDirty, readSyncIndex } = await import("./syncState");

beforeEach(() => {
  backing.clear();
  audioIds.clear();
  localEntries = [];
  cloudRows = [];
  tombstones = undefined;
  goneOnServer = new Set();
  calls = [];
  listGate = Promise.resolve();
});

describe("entriesToPush", () => {
  it("pushes missing and dirty entries, never the sample or anything tombstoned", () => {
    const idx = {
      clean: { cloudUpdatedAt: 1, dirty: false },
      dirty: { cloudUpdatedAt: 1, dirty: true },
      flagged: { cloudGone: true as const, dirty: true },
      back: { cloudGone: true as const, dirty: true },
    };
    const picked = sync.entriesToPush(
      ["missing", "clean", "dirty", "listedGone", "flagged", "back", "sample-x"].map(local),
      new Set(["clean", "dirty", "back"]),
      new Set(["listedGone"]),
      idx,
    );
    // "back": flagged earlier but the cloud lists it live again → normal rules.
    expect(picked.map((e) => e.id)).toEqual(["missing", "dirty", "back"]);
  });

  it("with no tombstones and no flags it is today's rule", () => {
    const picked = sync.entriesToPush([local("a"), local("b")], new Set(["b"]), new Set(), {});
    expect(picked.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("pushUnsyncedToCloud", () => {
  it("older server (no tombstones): a missing entry is still pushed, audio first", async () => {
    localEntries = [local("a")];
    audioIds.add("a");
    expect(await sync.pushUnsyncedToCloud()).toBe(1);
    expect(pushesOf("a")).toEqual(["PUT /recordings/a/audio", "POST /recordings/a"]);
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 1000, dirty: false });
  });

  it("a listed tombstone is flagged and never uploaded, on this sweep or the next", async () => {
    localEntries = [local("gone"), local("new")];
    audioIds.add("gone");
    tombstones = ["gone", "not-on-this-device"];
    expect(await sync.pushUnsyncedToCloud()).toBe(1);
    expect(pushesOf("gone")).toEqual([]);
    expect(readSyncIndex().gone).toEqual({ cloudGone: true });
    // Non-local tombstones aren't recorded — nothing here to stop pushing.
    expect(readSyncIndex()["not-on-this-device"]).toBeUndefined();

    // Even a server that stops reporting it can't trigger a re-push now.
    tombstones = undefined;
    cloudRows = [{ id: "new", updatedAt: 1000 }];
    calls = [];
    expect(await sync.pushUnsyncedToCloud()).toBe(0);
    expect(pushesOf("gone")).toEqual([]);
  });

  it("410 on the audio upload: no meta POST, flagged, no throw, not counted", async () => {
    localEntries = [local("a")];
    audioIds.add("a");
    goneOnServer.add("a");
    expect(await sync.pushUnsyncedToCloud()).toBe(0);
    expect(pushesOf("a")).toEqual(["PUT /recordings/a/audio"]);
    expect(readSyncIndex().a?.cloudGone).toBe(true);

    calls = [];
    await sync.pushUnsyncedToCloud();
    expect(pushesOf("a")).toEqual([]);
  });

  it("410 on the meta POST flags it too", async () => {
    localEntries = [local("a")];
    goneOnServer.add("a");
    expect(await sync.pushUnsyncedToCloud()).toBe(0);
    expect(pushesOf("a")).toEqual(["POST /recordings/a"]);
    expect(readSyncIndex().a?.cloudGone).toBe(true);
  });

  it("an id the cloud lists live again is unflagged and synced normally", async () => {
    localEntries = [local("a")];
    markCloudGone(["a"]);
    markDirty("a");
    cloudRows = [{ id: "a", updatedAt: 5 }];
    tombstones = [];
    expect(await sync.pushUnsyncedToCloud()).toBe(1);
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 1000, dirty: false });
  });

  it("overlapping sweeps share one run, so nothing is pushed twice", async () => {
    localEntries = [local("a"), local("b")];
    audioIds.add("a");
    let open!: () => void;
    listGate = new Promise((r) => (open = r));
    const first = sync.pushUnsyncedToCloud();
    const second = sync.pushUnsyncedToCloud();
    expect(second).toBe(first);
    open();
    expect(await Promise.all([first, second])).toEqual([2, 2]);
    expect(calls.filter((c) => c === "GET /recordings")).toHaveLength(1);
    expect(pushesOf("a")).toEqual(["PUT /recordings/a/audio", "POST /recordings/a"]);
    expect(pushesOf("b")).toEqual(["POST /recordings/b"]);

    // Once it settles, the next call starts a fresh sweep.
    calls = [];
    cloudRows = [{ id: "a", updatedAt: 1000 }, { id: "b", updatedAt: 1000 }];
    await sync.pushUnsyncedToCloud();
    expect(calls).toEqual(["GET /recordings"]);
  });
});

describe("pushLocalEntry", () => {
  it("skips a gone entry before reading or uploading anything", async () => {
    markCloudGone(["a"]);
    audioIds.add("a");
    expect(await sync.pushLocalEntry("a")).toBe("gone");
    expect(calls).toEqual([]);
  });
});

describe("listMergedHistory", () => {
  it("a tombstoned local entry is a local card and never seeds a baseline", async () => {
    localEntries = [local("gone"), local("ok")];
    cloudRows = [{ id: "ok", updatedAt: 7 }];
    tombstones = ["gone"];
    const cards = await sync.listMergedHistory();
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(byId.gone.sync).toBe("local");
    expect(byId.gone.cloudUpdatedAt).toBeUndefined();
    expect(byId.ok.sync).toBe("synced");
    // Flag kept (the id is local, so prune keeps it); no cloud version recorded.
    expect(readSyncIndex().gone).toEqual({ cloudGone: true });
  });
});

describe("explicit actions on a gone recording", () => {
  it("share fails with CloudGoneError instead of silently doing nothing", async () => {
    markCloudGone(["a"]);
    await expect(sync.shareRecordingToOrg("a", "org1")).rejects.toBeInstanceOf(sync.CloudGoneError);
    expect(calls).toEqual([]);
  });

  it("share fails when the push it forces comes back 410", async () => {
    localEntries = [local("a")];
    goneOnServer.add("a");
    const err = await sync.shareRecordingToOrg("a", "org1").catch((e: unknown) => e);
    expect(sync.isCloudGoneError(err)).toBe(true);
    expect(calls).not.toContain("POST /recordings/a/share");
  });

  it("move fails before deleting anything", async () => {
    markCloudGone(["a"]);
    await expect(sync.moveRecordingToOrg("a", "org1")).rejects.toBeInstanceOf(sync.CloudGoneError);
    expect(calls).toEqual([]);
  });

  it("our own cloud delete flags the id, so a leftover local copy is never re-pushed", async () => {
    await sync.deleteCloudRecording("a");
    expect(readSyncIndex().a).toEqual({ cloudGone: true });
  });
});
