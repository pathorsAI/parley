import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY_SCORE,
  scoreMatch,
  searchTargets,
  targetKey,
  targetLabel,
  type QuickSwitchLabels,
  type QuickTarget,
} from "./quickSwitch";

/**
 * The #332 contract: what you type ranks the places you can go, and typing
 * nothing still shows you the tree in the order the tree has.
 */

const labels: QuickSwitchLabels = {
  all: "所有錄音",
  home: "首頁",
  unassigned: "還沒歸檔",
  voice: "語音輸入",
};

/** Score, asserting the match exists — keeps the comparisons below readable. */
function must(query: string, text: string): number {
  const score = scoreMatch(query, text);
  expect(score, `expected "${query}" to match "${text}"`).not.toBeNull();
  return score as number;
}

describe("scoreMatch", () => {
  it("returns null when a character is missing or out of order", () => {
    expect(scoreMatch("zzz", "Sales Meeting")).toBeNull();
    // Subsequence, so ORDER matters: the "g" comes before the "m" here.
    expect(scoreMatch("gm", "Meeting")).toBeNull();
  });

  it("treats an empty query as 'everything matches'", () => {
    expect(scoreMatch("", "anything")).toBe(EMPTY_QUERY_SCORE);
    expect(scoreMatch("   ", "anything")).toBe(EMPTY_QUERY_SCORE);
  });

  it("ignores case", () => {
    expect(must("MEET", "meeting")).toBe(must("meet", "MEETING"));
  });

  it("ranks exact above prefix above mid-string", () => {
    const exact = must("meet", "Meet");
    const prefix = must("meet", "Meeting");
    const middle = must("meet", "Team Meet");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(middle);
  });

  it("rewards characters that land at the start of a word", () => {
    expect(must("sm", "Sales Meeting")).toBeGreaterThan(must("sm", "Assembly"));
    // Separators count as word breaks too, not just spaces.
    expect(must("ab", "alpha-beta")).toBeGreaterThan(must("ab", "xalphaxbeta"));
  });

  it("prefers a contiguous run over a scattered one", () => {
    expect(must("abc", "xabc")).toBeGreaterThan(must("abc", "xaxbxc"));
  });

  it("prefers a match that starts earlier in the text", () => {
    expect(must("acme", "Acme Corp")).toBeGreaterThan(must("acme", "The Acme Corp"));
  });

  it("strips whitespace from the query but not from the text", () => {
    expect(scoreMatch("lib scr", "LibraryScreen")).not.toBeNull();
    expect(scoreMatch("sales meeting", "Sales Meeting")).not.toBeNull();
  });

  it("matches a CJK name on a subsequence", () => {
    expect(scoreMatch("和車", "和運租車")).not.toBeNull();
    expect(scoreMatch("台科", "台數科")).not.toBeNull();
    expect(scoreMatch("車和", "和運租車")).toBeNull();
  });
});

describe("targetKey", () => {
  it("gives every kind its own namespace", () => {
    const keys = [
      targetKey({ kind: "home" }),
      targetKey({ kind: "folder", id: "x", name: "X", count: 0 }),
      targetKey({ kind: "unassigned", count: 0 }),
      targetKey({ kind: "voice" }),
      targetKey({ kind: "org", orgId: "x", orgName: "X" }),
      targetKey({ kind: "orgFolder", orgId: "o", orgName: "O", id: "x", name: "X" }),
      targetKey({ kind: "recording", id: "x", title: "X", createdAt: 1, folderId: null }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("targetLabel", () => {
  it("takes the fixed nodes' names from the caller's dictionary", () => {
    expect(targetLabel({ kind: "home" }, labels)).toBe("首頁");
    expect(targetLabel({ kind: "all", count: 18 }, labels)).toBe("所有錄音");
    expect(targetLabel({ kind: "unassigned", count: 3 }, labels)).toBe("還沒歸檔");
    expect(targetLabel({ kind: "voice" }, labels)).toBe("語音輸入");
  });
});

// The shape of a real tree: home, two folders, unassigned, voice, one org with
// a folder, then three recordings newest-first.
const HOME: QuickTarget = { kind: "home" };
const ACME: QuickTarget = { kind: "folder", id: "f-acme", name: "Acme", count: 2 };
const HEYUN: QuickTarget = { kind: "folder", id: "f-heyun", name: "和運租車", count: 8 };
const UNASSIGNED: QuickTarget = { kind: "unassigned", count: 7 };
const VOICE: QuickTarget = { kind: "voice" };
const ORG: QuickTarget = { kind: "org", orgId: "o1", orgName: "Pathors" };
const ORG_FOLDER: QuickTarget = {
  kind: "orgFolder",
  orgId: "o1",
  orgName: "Pathors",
  id: "of-1",
  name: "Sales Meeting",
};
const REC_NEW: QuickTarget = {
  kind: "recording",
  id: "r3",
  title: "和運租車 kickoff",
  createdAt: 300,
  folderId: "f-heyun",
};
const REC_MID: QuickTarget = {
  kind: "recording",
  id: "r2",
  title: "Acme pricing call",
  createdAt: 200,
  folderId: "f-acme",
};
const REC_OLD: QuickTarget = {
  kind: "recording",
  id: "r1",
  title: "Assembly standup",
  createdAt: 100,
  folderId: null,
};

const TREE: QuickTarget[] = [
  HOME,
  ACME,
  HEYUN,
  UNASSIGNED,
  VOICE,
  ORG,
  ORG_FOLDER,
  REC_NEW,
  REC_MID,
  REC_OLD,
];

describe("searchTargets", () => {
  it("lists the whole tree in its natural order for an empty query", () => {
    // Navigation first, exactly as handed in; then the recordings, newest first.
    expect(searchTargets(TREE, "", labels).map((t) => targetKey(t))).toEqual([
      "home",
      "folder:f-acme",
      "folder:f-heyun",
      "unassigned",
      "voice",
      "org:o1",
      "orgFolder:o1:of-1",
      "recording:r3",
      "recording:r2",
      "recording:r1",
    ]);
  });

  it("honours the limit", () => {
    expect(searchTargets(TREE, "", labels, 3).map((t) => targetKey(t))).toEqual([
      "home",
      "folder:f-acme",
      "folder:f-heyun",
    ]);
    expect(searchTargets(TREE, "", labels, 0)).toEqual([]);
    // The default cap is 30, which this tree is comfortably inside.
    expect(searchTargets(TREE, "", labels)).toHaveLength(TREE.length);
  });

  it("drops everything that doesn't match", () => {
    expect(searchTargets(TREE, "zzzz", labels)).toEqual([]);
  });

  it("puts the folder ahead of the recordings that live in it", () => {
    const keys = searchTargets(TREE, "acme", labels).map((t) => targetKey(t));
    expect(keys[0]).toBe("folder:f-acme");
    expect(keys).toContain("recording:r2");
  });

  it("ranks a word-start match above an incidental one", () => {
    const keys = searchTargets(TREE, "sm", labels).map((t) => targetKey(t));
    // "Sales Meeting" (both letters start a word) beats "Assembly".
    expect(keys.indexOf("orgFolder:o1:of-1")).toBeLessThan(keys.indexOf("recording:r1"));
  });

  it("finds a CJK folder and its recording from a subsequence", () => {
    const keys = searchTargets(TREE, "和車", labels).map((t) => targetKey(t));
    expect(keys).toEqual(["folder:f-heyun", "recording:r3"]);
  });

  it("matches the fixed nodes through the supplied labels", () => {
    expect(searchTargets(TREE, "語音", labels).map((t) => targetKey(t))).toEqual(["voice"]);
    expect(searchTargets(TREE, "首頁", labels).map((t) => targetKey(t))).toEqual(["home"]);
  });
});
