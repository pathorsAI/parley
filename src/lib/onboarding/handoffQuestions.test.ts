import { describe, it, expect } from "vitest";
import { handoffQuestions } from "./handoffQuestions";

describe("handoffQuestions", () => {
  it("asks generic questions about any recording, naming it for MCP", () => {
    const zh = handoffQuestions({ id: "rec-1", title: "週會" }, "zh-TW");
    expect(zh.questions).toEqual([
      "這場會議談了什麼、結論是什麼？五句以內。",
      "雙方各自答應了哪些事？附負責人與時間。",
      "我漏問、或下次應該追問的是什麼？",
    ]);
    expect(zh.mcpQuestions).toEqual([
      "用 Parley 找出「週會」這場，列出雙方答應的事和期限。",
      "讀「週會」的逐字稿，指出有風險或前後矛盾的地方，引用原句。",
      "把「週會」的重點和後續行動寫回 Parley 的分析。",
    ]);
    const en = handoffQuestions({ id: "rec-1", title: "Weekly sync" }, "en");
    expect(en.questions).toHaveLength(3);
    expect(en.mcpQuestions[0]).toBe(
      "Use Parley to find “Weekly sync” and list what each side committed to, with deadlines."
    );
  });

  it("asks the sample's own questions verbatim", () => {
    const zh = handoffQuestions({ id: "sample-hongsheng-zh-TW-v1", title: "範例" }, "zh-TW");
    expect(zh.questions).toEqual([
      "林經理對價格的疑慮是什麼？下次見面我該怎麼回？",
      "這場我答應了哪些事、期限是什麼？有沒有對方問了但我沒回答的問題？",
      "他們去年導入失敗的原因，對我準備下週三的 demo 有什麼提醒？",
    ]);
    expect(zh.mcpQuestions).toEqual([
      "用 Parley 找出與泓昇科技的那場通話，列出我答應的事和期限，還有我沒回答的問題。",
      "讀一下泓昇科技那場的逐字稿，林經理對價格的疑慮是什麼？幫我擬三句下次可以回的話。",
      "把泓昇科技那場的重點和風險寫回 Parley 的分析，並標記會議類型為銷售通話。",
    ]);
    const en = handoffQuestions({ id: "sample-hongsheng-en-v1", title: "Sample" }, "en");
    expect(en.questions).toEqual([
      "What is Mr. Lin's concern about price, and how should I answer it next time?",
      "What did I commit to in this call, with what deadlines? Did he ask anything I didn't answer?",
      "Given why last year's vendor failed, what should my demo next Wednesday address?",
    ]);
    expect(en.mcpQuestions).toEqual([
      "Use Parley to find the call with Hongsheng Technology and list what I committed to, the deadlines, and the questions I left unanswered.",
      "Read the Hongsheng Technology transcript in Parley. What is Mr. Lin's price objection? Draft three replies I could use next time.",
      "Write the key points and risks of the Hongsheng call back into Parley's analysis and mark the meeting kind as a sales call.",
    ]);
  });
});
