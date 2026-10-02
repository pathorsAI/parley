import { describe, it, expect } from "vitest";
import { createRunRegistry } from "./runRegistry";

describe("runRegistry", () => {
  it("tracks stages in flight per recording and forgets them on remove", () => {
    const r = createRunRegistry();
    r.add("A", "findings", 1);
    r.add("A", "delivery", 1);
    r.add("B", "brief", 1);
    expect([...r.stagesFor("A")].sort()).toEqual(["delivery", "findings"]);
    expect([...r.stagesFor("B")]).toEqual(["brief"]);

    r.remove("A", "findings", 1);
    expect([...r.stagesFor("A")]).toEqual(["delivery"]);
    r.remove("A", "delivery", 1);
    expect(r.stagesFor("A").size).toBe(0);
  });

  it("removing only drops the flight with the matching token", () => {
    const r = createRunRegistry();
    r.add("A", "findings", 1);
    r.add("A", "findings", 2);
    r.remove("A", "findings", 1);
    expect([...r.stagesFor("A")]).toEqual(["findings"]);
  });

  it("an upload session that saved as an entry is found under the entry id", () => {
    const r = createRunRegistry();
    // The upload's replay session is "upload-1"; its first save filed it as "entry-9".
    r.add("upload-1", "actions", 1);
    r.recordSession("upload-1", { entryId: "entry-9", readOnly: false });
    expect(r.canonical("upload-1")).toBe("entry-9");
    expect([...r.stagesFor("entry-9")]).toEqual(["actions"]);
    // ...and never under some other recording.
    expect(r.stagesFor("entry-10").size).toBe(0);
  });

  it("ignores flights older than the max age, so a hung request can't pin a stage forever", () => {
    let t = 0;
    const r = createRunRegistry(() => t);
    r.add("A", "brief", 1);
    t = 1000;
    expect(r.stagesFor("A", 5000).has("brief")).toBe(true);
    t = 10_000;
    expect(r.stagesFor("A", 5000).has("brief")).toBe(false);
  });

  it("targetOf defaults to unsaved and reports a read-only session", () => {
    const r = createRunRegistry();
    expect(r.targetOf("X")).toEqual({ entryId: null, readOnly: false });
    r.recordSession("org-1", { entryId: null, readOnly: true });
    expect(r.targetOf("org-1")).toEqual({ entryId: null, readOnly: true });
    expect(r.canonical("org-1")).toBe("org-1");
  });
});
