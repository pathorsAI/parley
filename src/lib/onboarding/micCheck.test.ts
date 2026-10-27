import { describe, expect, it } from "vitest";
import { CheckTranscript, changedSpan, joinRuns, mergeTerms, profileFill } from "./micCheck";

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
