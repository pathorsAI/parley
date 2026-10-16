import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../platform", () => ({ isTauri: () => mocks.tauri }));

import {
  DEFAULT_LOCAL_STT_MODEL,
  anyLocalBusy,
  checkLocalModelReady,
  downloadPercent,
  formatModelSize,
  isLocalBusy,
  isLocalModelReady,
  localModelLabel,
  reduceLocalProgress,
  sortLocalModels,
  type LocalDownloads,
  type LocalSttModel,
} from "./localModels";
import { translate, type TranslationKey } from "../../i18n/messages";

const model = (over: Partial<LocalSttModel> = {}): LocalSttModel => ({
  id: DEFAULT_LOCAL_STT_MODEL,
  family: "whisper",
  sizeBytes: 574_000_000,
  installed: false,
  downloading: false,
  ...over,
});

describe("isLocalModelReady", () => {
  it("is ready only when the selected model is installed and not downloading", () => {
    expect(isLocalModelReady([model({ installed: true })], DEFAULT_LOCAL_STT_MODEL)).toBe(true);
    expect(isLocalModelReady([model()], DEFAULT_LOCAL_STT_MODEL)).toBe(false);
    expect(isLocalModelReady([model({ installed: true, downloading: true })], DEFAULT_LOCAL_STT_MODEL)).toBe(false);
  });

  it("fails closed on an unknown catalog or an id missing from it", () => {
    expect(isLocalModelReady(null, DEFAULT_LOCAL_STT_MODEL)).toBe(false);
    expect(isLocalModelReady([], DEFAULT_LOCAL_STT_MODEL)).toBe(false);
    expect(isLocalModelReady([model({ installed: true })], "breeze-asr-25-q5_0")).toBe(false);
  });
});

describe("checkLocalModelReady", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.tauri = true;
  });

  it("asks the backend catalog", async () => {
    mocks.invoke.mockResolvedValue([model({ installed: true })]);
    await expect(checkLocalModelReady(DEFAULT_LOCAL_STT_MODEL)).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("local_stt_models");
  });

  it("treats a failed catalog call as not ready", async () => {
    mocks.invoke.mockRejectedValue("boom");
    await expect(checkLocalModelReady(DEFAULT_LOCAL_STT_MODEL)).resolves.toBe(false);
  });

  it("is never ready outside Tauri", async () => {
    mocks.tauri = false;
    await expect(checkLocalModelReady(DEFAULT_LOCAL_STT_MODEL)).resolves.toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("reduceLocalProgress", () => {
  const id = "breeze-asr-25-q5_0";
  const ev = (stage: "downloading" | "verifying" | "done" | "error" | "cancelled", extra = {}) => ({
    modelId: id,
    stage,
    received: 0,
    total: 0,
    ...extra,
  });

  it("tracks bytes while downloading", () => {
    const s = reduceLocalProgress({}, ev("downloading", { received: 50, total: 200 }));
    expect(s[id]).toEqual({ status: "downloading", received: 50, total: 200 });
  });

  it("moves to verifying, then clears on done", () => {
    let s: LocalDownloads = reduceLocalProgress({}, ev("downloading", { received: 200, total: 200 }));
    s = reduceLocalProgress(s, ev("verifying"));
    expect(s[id]).toEqual({ status: "verifying" });
    s = reduceLocalProgress(s, ev("done"));
    expect(s[id]).toBeUndefined();
  });

  it("keeps the error message, and cancelled sticks for a retry", () => {
    expect(reduceLocalProgress({}, ev("error", { message: "checksum mismatch" }))[id]).toEqual({
      status: "error",
      message: "checksum mismatch",
    });
    expect(reduceLocalProgress({}, ev("error"))[id]).toEqual({ status: "error", message: "" });
    expect(reduceLocalProgress({}, ev("cancelled"))[id]).toEqual({ status: "cancelled" });
  });

  it("leaves other models and the input untouched", () => {
    const before: LocalDownloads = { other: { status: "verifying" } };
    const after = reduceLocalProgress(before, ev("downloading", { received: 1, total: 2 }));
    expect(after.other).toEqual({ status: "verifying" });
    expect(before[id]).toBeUndefined();
  });
});

describe("downloadPercent", () => {
  it("floors and clamps", () => {
    expect(downloadPercent(0, 100)).toBe(0);
    expect(downloadPercent(999, 1000)).toBe(99);
    expect(downloadPercent(1000, 1000)).toBe(100);
    expect(downloadPercent(2000, 1000)).toBe(100);
  });

  it("is 0 when the total is unknown", () => {
    expect(downloadPercent(500, 0)).toBe(0);
    expect(downloadPercent(Number.NaN, 10)).toBe(0);
  });
});

describe("isLocalBusy / anyLocalBusy", () => {
  it("counts in-flight UI state and the catalog's own flag", () => {
    expect(isLocalBusy([model()], { [DEFAULT_LOCAL_STT_MODEL]: { status: "verifying" } }, DEFAULT_LOCAL_STT_MODEL)).toBe(true);
    expect(isLocalBusy([model({ downloading: true })], {}, DEFAULT_LOCAL_STT_MODEL)).toBe(true);
    expect(isLocalBusy([model()], { [DEFAULT_LOCAL_STT_MODEL]: { status: "error", message: "x" } }, DEFAULT_LOCAL_STT_MODEL)).toBe(false);
  });

  it("anyLocalBusy sees a download of a model other than the selected one", () => {
    const models = [model({ installed: true }), model({ id: "whisper-small-q5_1" })];
    expect(anyLocalBusy(models, {})).toBe(false);
    expect(anyLocalBusy(models, { "whisper-small-q5_1": { status: "downloading", received: 1, total: 9 } })).toBe(true);
    expect(anyLocalBusy(null, { x: { status: "verifying" } })).toBe(true);
  });
});

describe("formatModelSize", () => {
  it("uses decimal MB below a gigabyte and GB above", () => {
    expect(formatModelSize(190_085_487)).toBe("190 MB");
    expect(formatModelSize(574_041_195)).toBe("574 MB");
    expect(formatModelSize(874_188_075)).toBe("874 MB");
    expect(formatModelSize(1_080_000_000)).toBe("1.08 GB");
    expect(formatModelSize(12_300_000_000)).toBe("12.3 GB");
  });

  it("never shows 0 MB and dashes unknown sizes", () => {
    expect(formatModelSize(1)).toBe("1 MB");
    expect(formatModelSize(0)).toBe("—");
  });
});

describe("localModelLabel", () => {
  const ids = ["whisper-small-q5_1", "whisper-large-v3-turbo-q5_0", "whisper-large-v3-turbo-q8_0", "breeze-asr-25-q5_0"];
  for (const lang of ["zh-TW", "en"] as const) {
    it(`names and describes every catalog model in ${lang}`, () => {
      const t = (k: TranslationKey) => translate(lang, k);
      for (const id of ids) {
        const { name, description } = localModelLabel(t, id);
        expect(name).not.toBe(id);
        expect(name).not.toMatch(/^localStt\./);
        expect(description).toBeTruthy();
        expect(description).not.toMatch(/^localStt\./);
      }
    });
  }

  it("falls back to the raw id for a model the frontend doesn't know", () => {
    expect(localModelLabel((k) => k, "future-model")).toEqual({ name: "future-model", description: null });
  });
});

describe("sortLocalModels", () => {
  it("puts the recommended default first, then smallest first", () => {
    const sorted = sortLocalModels([
      model({ id: "breeze-asr-25-q5_0", sizeBytes: 1_080_000_000 }),
      model({ id: "whisper-large-v3-turbo-q8_0", sizeBytes: 874_000_000 }),
      model({ id: "whisper-small-q5_1", sizeBytes: 190_000_000 }),
      model(),
    ]).map((m) => m.id);
    expect(sorted).toEqual([
      DEFAULT_LOCAL_STT_MODEL,
      "whisper-small-q5_1",
      "whisper-large-v3-turbo-q8_0",
      "breeze-asr-25-q5_0",
    ]);
  });
});
