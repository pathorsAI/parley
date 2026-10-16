import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../nav/settings", () => ({ openSettings: vi.fn() }));

import { LOCAL_FAILURE_TOAST_KEY, createSlowToastGate, isLocalFailureCode } from "./localAlerts";
import { translate } from "../../i18n/messages";

describe("createSlowToastGate", () => {
  it("lets one toast through per app run", () => {
    const gate = createSlowToastGate();
    expect(gate("local")).toBe(true);
    expect(gate("local")).toBe(false);
    expect(gate("local")).toBe(false);
  });

  it("stays quiet when the provider is no longer local, without using up the toast", () => {
    const gate = createSlowToastGate();
    expect(gate("soniox")).toBe(false);
    expect(gate("parley")).toBe(false);
    expect(gate("local")).toBe(true);
  });
});

describe("local failure codes", () => {
  it("recognizes exactly the backend's local codes", () => {
    expect(isLocalFailureCode("local")).toBe(true);
    expect(isLocalFailureCode("local-memory")).toBe(true);
    expect(isLocalFailureCode("local-missing")).toBe(true);
    expect(isLocalFailureCode("connect")).toBe(false);
    expect(isLocalFailureCode("constructor")).toBe(false);
  });

  it("has its own message per code in both languages, not the generic connect one", () => {
    for (const lang of ["zh-TW", "en"] as const) {
      const connect = translate(lang, "meeting.error.connect");
      const texts = Object.values(LOCAL_FAILURE_TOAST_KEY).map((k) => translate(lang, k));
      expect(new Set(texts).size).toBe(texts.length);
      for (const text of texts) {
        expect(text).not.toBe(connect);
        expect(text).not.toMatch(/^localStt\./);
      }
    }
  });
});
