import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings } from "../types";
import { STT_BY_ID, STT_PROVIDERS, sttApiKey, sttBatchUrl, sttLabel, sttModel, sttRelayUrl } from "./providers";
import { DEFAULT_LOCAL_STT_MODEL, LOCAL_STT_API_KEY } from "./localModels";
import { translate, type TranslationKey } from "../../i18n/messages";

const base = useStore.getState().settings;
const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });

describe("local STT provider", () => {
  it("is registered keyless, without diarization, with upload support", () => {
    const local = STT_BY_ID.local;
    expect(STT_PROVIDERS.some((p) => p.id === "local")).toBe(true);
    expect(local.apiKeyField).toBeNull();
    expect(local.diarization).toBe(false);
    expect(local.supportsFileUpload).toBe(true);
  });

  it("sttApiKey returns the sentinel so the existing key gates pass", () => {
    expect(sttApiKey(settingsFor({ transcriptionProvider: "local" }), "local")).toBe(LOCAL_STT_API_KEY);
    expect(LOCAL_STT_API_KEY.trim()).not.toBe("");
  });

  it("sends the selected model id, and no relay or batch URL", () => {
    const s = settingsFor({ transcriptionProvider: "local", localSttModel: "breeze-asr-25-q5_0" });
    expect(sttModel(s, "local")).toBe("breeze-asr-25-q5_0");
    expect(sttRelayUrl("local", "meeting")).toBeUndefined();
    expect(sttBatchUrl("local")).toBeUndefined();
  });

  it("other providers keep sending no model and their own trimmed key", () => {
    const s = settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: " k \n" });
    expect(sttModel(s, "soniox")).toBeNull();
    expect(sttApiKey(s, "soniox")).toBe("k");
  });

  it("defaults the setting to the recommended model", () => {
    expect(base.localSttModel).toBe(DEFAULT_LOCAL_STT_MODEL);
  });

  it("has a translated label; brand providers keep their brand name", () => {
    const zh = sttLabel((k: TranslationKey) => translate("zh-TW", k), STT_BY_ID.local);
    const en = sttLabel((k: TranslationKey) => translate("en", k), STT_BY_ID.local);
    expect(en).toBe("Local (whisper.cpp)");
    expect(zh).toContain("whisper.cpp");
    expect(zh).not.toBe(en);
    expect(sttLabel((k) => k, STT_BY_ID.soniox)).toBe("Soniox");
  });
});
