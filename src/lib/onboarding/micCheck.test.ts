import { describe, expect, it } from "vitest";
import {
  CheckTranscript,
  changedSpan,
  fixProductName,
  joinRuns,
  mergeTerms,
  profileFill,
  undoMicRun,
  withProductName,
} from "./micCheck";

const seg = (id: string, text: string, is_final: boolean, source = "mic-check") => ({ id, source, text, is_final });

describe("CheckTranscript", () => {
  it("folds finals in id order, then the tentative tail", () => {
    const t = new CheckTranscript();
    t.accept(seg("mic-check-1", "我主要用 Parley 整理客戶會議。", true));
    t.accept(seg("mic-check-0", "我是派斯科技的設計師 Jack，", true));
    t.accept(seg("mic-check-2", "謝謝", false));
    expect(t.text()).toBe("我是派斯科技的設計師 Jack，我主要用 Parley 整理客戶會議。謝謝");
  });

  it("replaces the tail and ignores other sources", () => {
    const t = new CheckTranscript();
    expect(t.accept(seg("voice-typing-0", "dictation", true, "voice-typing"))).toBe(false);
    t.accept(seg("mic-check-0", "I'm", false));
    t.accept(seg("mic-check-0", "I'm Jack", true));
    expect(t.text()).toBe("I'm Jack");
  });
});

describe("joinRuns", () => {
  it("spaces Latin runs and glues CJK ones", () => {
    expect(joinRuns(["I'm Jack", "from Pathors"])).toBe("I'm Jack from Pathors");
    expect(joinRuns(["我是", "Jack"])).toBe("我是Jack");
    expect(joinRuns(["  ", "我是 Jack"])).toBe("我是 Jack");
  });
});

describe("profileFill", () => {
  it("fills only the fields Settings doesn't have yet", () => {
    expect(
      profileFill({ userName: "", userCompany: "Acme", userRole: " " }, { name: "Jack", company: "Pathors", role: "設計師" }),
    ).toEqual({ userName: "Jack", userRole: "設計師" });
    expect(profileFill({ userName: "", userCompany: "", userRole: "" }, { name: "", company: "", role: "" })).toEqual({});
  });
});

describe("mergeTerms", () => {
  it("adds only terms the list doesn't have, by entry or by phrase", () => {
    const a = { id: "1", phrase: "派斯科技" };
    const b = { id: "2", phrase: "Jack" };
    expect(mergeTerms([a], [a, b])).toEqual([a, b]);
    expect(mergeTerms([a], [{ id: "3", phrase: "派斯科技" }])).toEqual([a]);
    expect(mergeTerms([], [b, b])).toEqual([b]);
  });
});

describe("changedSpan", () => {
  it("is what's left once the shared start and end are removed", () => {
    expect(changedSpan("常和東昇談專案", "常和東森談專案")).toEqual({ from: "昇", to: "森" });
    expect(changedSpan("台灣大哥談", "台灣大哥大談")).toEqual({ from: "", to: "大" });
    expect(changedSpan("same", "same")).toEqual({ from: "", to: "" });
  });
});

describe("the product's name in the check", () => {
  it("rewrites the ways a recognizer mishears Parley", () => {
    expect(fixProductName("I use parlay to write up meetings")).toBe("I use Parley to write up meetings");
    expect(fixProductName("I use Par Lay to take notes")).toBe("I use Parley to take notes");
    expect(fixProductName("I use parley daily")).toBe("I use Parley daily");
  });

  it("rewrites Chinese sound-alikes, spaced the way the script writes it", () => {
    expect(fixProductName("我主要用帕雷來整理會議")).toBe("我主要用 Parley 來整理會議");
    expect(fixProductName("我主要用 帕利 來整理會議")).toBe("我主要用 Parley 來整理會議");
  });

  it("leaves a correct transcript, and names that only sound close, alone", () => {
    expect(fixProductName("我主要用 Parley 來整理會議")).toBe("我主要用 Parley 來整理會議");
    expect(fixProductName("I'm Harley from the parlor")).toBe("I'm Harley from the parlor");
    expect(fixProductName("Parleys")).toBe("Parleys");
  });

  it("tells the recognizer the name first, once", () => {
    expect(withProductName(["派斯科技", "Parley", "Jack"])).toEqual(["Parley", "派斯科技", "Jack"]);
  });
});

describe("testing again replaces the previous check", () => {
  const run = { lines: ["派斯科技設計師 Jack，用 Parley 整理客戶會議"], profile: { userName: "Jack" }, created: [], terms: [] };

  it("takes the previous check's line back out and keeps the rest of the background", () => {
    const patch = undoMicRun(
      { userBackground: "- 常和東森談外撥專案\n- 派斯科技設計師 Jack，用 Parley 整理客戶會議", userName: "Jack", userCompany: "", userRole: "" },
      run,
    );
    expect(patch.userBackground).toBe("- 常和東森談外撥專案");
    expect(patch.userName).toBe("");
  });

  it("leaves a profile field the user has changed since", () => {
    const patch = undoMicRun({ userBackground: "", userName: "Jack Lin", userCompany: "", userRole: "" }, run);
    expect(patch.userName).toBeUndefined();
  });
});
