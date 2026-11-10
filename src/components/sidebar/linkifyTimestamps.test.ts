import { describe, expect, it } from "vitest";
import { linkifyTimestamps } from "./ReportContent";

describe("linkifyTimestamps", () => {
  it("links [m:ss], including past the hour in minutes", () => {
    expect(linkifyTimestamps("decided [6:52] and [65:14]")).toBe("decided [6:52](#t=412) and [65:14](#t=3914)");
  });
  it("links [h:mm:ss]", () => {
    expect(linkifyTimestamps("at [1:05:14]")).toBe("at [1:05:14](#t=3914)");
  });
  it("links a range at its start", () => {
    expect(linkifyTimestamps("[6:52–7:10]")).toBe("[6:52](#t=412)");
  });
  it("links full-width brackets", () => {
    expect(linkifyTimestamps("結論【12:39】")).toBe("結論[12:39](#t=759)");
  });
  it("leaves an existing link alone", () => {
    expect(linkifyTimestamps("[6:52](https://x)")).toBe("[6:52](https://x)");
  });
});

describe("linkifyTimestamps, model drift", () => {
  it("links escaped brackets and hyphen ranges", () => {
    expect(linkifyTimestamps("見 \\[9:28-9:39\\] 與 [19:51-20:00]")).toBe("見 [9:28](#t=568) 與 [19:51](#t=1191)");
  });
});

describe("linkifyTimestamps, parentheses", () => {
  it("drops parentheses that only hold timestamps, so every citation reads bare", () => {
    expect(linkifyTimestamps("流程圖（[3:18]）。")).toBe("流程圖 [3:18](#t=198)。");
    expect(linkifyTimestamps("概念（[17:54]、[30:36]）。")).toBe("概念 [17:54](#t=1074) [30:36](#t=1836)。");
    expect(linkifyTimestamps("people ([9:28-9:39], [19:51-20:00])."))
      .toBe("people [9:28](#t=568) [19:51](#t=1191).");
  });
  it("keeps parentheses that say more than a time", () => {
    expect(linkifyTimestamps("（見 [3:18]）")).toBe("（見 [3:18](#t=198)）");
  });
});
