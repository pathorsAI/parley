import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("../platform", () => ({ isTauri: () => mocks.tauri }));

import {
  BREEZE_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_STT_MODEL,
  anyLocalBusy,
  autoLocalModelChoice,
  downloadGate,
  fetchLocalSttHardware,
  formatRam,
  localFailureCode,
  presentAccel,
  presentFit,
  presentLoad,
  type LocalSttFit,
  type LocalSttHardware,
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

const GIB = 2 ** 30;
const hardware = (over: Partial<LocalSttHardware> = {}): LocalSttHardware => ({
  totalRamBytes: 8 * GIB,
  availableRamBytes: 4 * GIB,
  freeDiskBytes: 50_000_000_000,
  accel: "metal",
  cpuCores: 8,
  os: "macos",
  arch: "aarch64",
  recommendedId: DEFAULT_LOCAL_STT_MODEL,
  ...over,
});
const fit = (level: LocalSttFit["level"], ...reasons: LocalSttFit["reasons"]): LocalSttFit => ({ level, reasons });

describe("formatRam", () => {
  it("shows binary sizes the way an OS labels memory", () => {
    expect(formatRam(8 * GIB)).toBe("8 GB");
    expect(formatRam(7.7 * GIB)).toBe("7.7 GB");
    expect(formatRam(16 * GIB)).toBe("16 GB");
    expect(formatRam(24.4 * GIB)).toBe("24 GB");
    expect(formatRam(0)).toBe("—");
  });

  it("rounds a requirement up and a capacity down when asked", () => {
    // Breeze on a GPU: 1.08 GB of weights + 1 GiB against a 2 GiB card.
    const need = 1_080_732_091 + GIB;
    expect(formatRam(need)).toBe("2 GB");
    expect(formatRam(need, "up")).toBe("2.1 GB");
    expect(formatRam(2 * GIB, "down")).toBe("2 GB");
    expect(formatRam(1.99 * GIB, "down")).toBe("1.9 GB");
    // Exact values do not move.
    expect(formatRam(2.5 * GIB, "up")).toBe("2.5 GB");
    expect(formatRam(12 * GIB, "up")).toBe("12 GB");
    expect(formatRam(12.2 * GIB, "up")).toBe("13 GB");
  });
});

describe("downloadGate", () => {
  it("blocks only on disk, asks first on low RAM, and never blocks an unknown fit", () => {
    expect(downloadGate(fit("unsupported", "disk_low", "ram_low"))).toBe("blocked");
    expect(downloadGate(fit("unsupported", "ram_low"))).toBe("confirm");
    expect(downloadGate(fit("unsupported", "ram_low", "ram_tight"))).toBe("confirm");
    expect(downloadGate(fit("slow", "cpu_only"))).toBe("ok");
    expect(downloadGate(fit("slow", "ram_tight"))).toBe("ok");
    expect(downloadGate(fit("good"))).toBe("ok");
    expect(downloadGate(null)).toBe("ok");
    expect(downloadGate(undefined)).toBe("ok");
  });
});

describe("presentFit", () => {
  for (const lang of ["zh-TW", "en"] as const) {
    const t = (k: TranslationKey, vars?: Record<string, string>) => translate(lang, k, vars);

    it(`renders every reason with its numbers in ${lang}`, () => {
      const hw = hardware({ totalRamBytes: 4 * GIB, availableRamBytes: 1.5 * GIB, freeDiskBytes: 300_000_000 });
      const cases: [LocalSttFit, string[]][] = [
        [fit("unsupported", "disk_low"), ["1.09 GB", "300 MB"]],
        [fit("unsupported", "ram_low"), ["8 GB", "4 GB"]],
        [fit("slow", "ram_tight"), ["1.5 GB"]],
        [fit("slow", "vram_low"), ["2.1 GB", "2 GB", "GeForce GTX 1050"]],
        [fit("slow", "cpu_only"), []],
      ];
      const pc = { ...hw, accel: "vulkan" as const, gpuName: "GeForce GTX 1050", gpuVramBytes: 2 * GIB };
      for (const [f, numbers] of cases) {
        const p = presentFit(
          model({
            fit: f,
            minRamBytes: 8 * GIB,
            diskNeededBytes: 1_086_000_000,
            vramNeededBytes: 1_080_000_000 + GIB,
          }),
          pc,
          (k) => translate(lang, k),
        );
        expect(p?.reason).not.toBeNull();
        const line = t(p!.reason!.key, p!.reason!.vars);
        expect(line).not.toMatch(/[{}]/);
        for (const n of numbers) expect(line).toContain(n);
      }
    });
  }

  it("picks badge and tone by level, and the disk badge over the memory one", () => {
    const t = (k: TranslationKey) => k;
    const hw = hardware();
    expect(presentFit(model({ fit: fit("good") }), hw, t)).toEqual({
      tone: "success",
      badge: "localStt.fit.good",
      reason: null,
    });
    expect(presentFit(model({ fit: fit("slow", "cpu_only") }), hw, t)).toMatchObject({
      tone: "warning",
      badge: "localStt.fit.slow",
      reason: { key: "localStt.fit.reason.cpuOnly" },
    });
    expect(presentFit(model({ fit: fit("unsupported", "ram_low") }), hw, t)).toMatchObject({
      tone: "danger",
      badge: "localStt.fit.noMemory",
    });
    expect(presentFit(model({ fit: fit("unsupported", "disk_low", "ram_low") }), hw, t)).toMatchObject({
      tone: "danger",
      badge: "localStt.fit.noDisk",
      reason: { key: "localStt.fit.reason.diskLow" },
    });
  });

  it("says this Mac on macOS and this computer elsewhere", () => {
    const t = (k: TranslationKey) => translate("en", k);
    const m = model({ fit: fit("unsupported", "ram_low"), minRamBytes: 8 * GIB });
    expect(presentFit(m, hardware({ os: "macos" }), t)?.reason?.vars.device).toBe("this Mac");
    expect(presentFit(m, hardware({ os: "windows" }), t)?.reason?.vars.device).toBe("this computer");
  });

  it("shows nothing when the fit is unknown", () => {
    expect(presentFit(model({ fit: null }), hardware(), (k) => k)).toBeNull();
    expect(presentFit(model(), null, (k) => k)).toBeNull();
  });
});

describe("autoLocalModelChoice", () => {
  const SMALL = "whisper-small-q5_1";
  const catalog = (over: Record<string, Partial<LocalSttModel>> = {}) => [
    model({ fit: fit("good"), ...over[DEFAULT_LOCAL_STT_MODEL] }),
    model({ id: SMALL, sizeBytes: 190_000_000, fit: fit("good"), ...over[SMALL] }),
    model({ id: BREEZE_LOCAL_STT_MODEL, family: "breeze", sizeBytes: 1_080_000_000, fit: fit("good"), ...over[BREEZE_LOCAL_STT_MODEL] }),
  ];
  const base = {
    current: DEFAULT_LOCAL_STT_MODEL,
    chosen: false,
    models: catalog(),
    hardware: hardware(),
    language: "en",
  };

  it("follows the backend recommendation for a user who never chose", () => {
    expect(autoLocalModelChoice(base)).toBeNull(); // already on it
    expect(autoLocalModelChoice({ ...base, hardware: hardware({ recommendedId: SMALL }) })).toBe(SMALL);
  });

  it("prefers Breeze for zh-TW only when it runs well", () => {
    expect(autoLocalModelChoice({ ...base, language: "zh-TW" })).toBe(BREEZE_LOCAL_STT_MODEL);
    expect(
      autoLocalModelChoice({
        ...base,
        language: "zh-TW",
        models: catalog({ [BREEZE_LOCAL_STT_MODEL]: { fit: fit("slow", "cpu_only") } }),
        hardware: hardware({ recommendedId: SMALL }),
      }),
    ).toBe(SMALL);
  });

  it("never overrides an explicit choice or a downloaded model", () => {
    const hw = hardware({ recommendedId: SMALL });
    expect(autoLocalModelChoice({ ...base, hardware: hw, chosen: true })).toBeNull();
    expect(
      autoLocalModelChoice({
        ...base,
        hardware: hw,
        models: catalog({ [DEFAULT_LOCAL_STT_MODEL]: { installed: true } }),
      }),
    ).toBeNull();
  });

  it("does nothing without hardware, a catalog, or a recommendation", () => {
    expect(autoLocalModelChoice({ ...base, hardware: null })).toBeNull();
    expect(autoLocalModelChoice({ ...base, models: null })).toBeNull();
    expect(autoLocalModelChoice({ ...base, hardware: hardware({ recommendedId: null }) })).toBeNull();
    expect(autoLocalModelChoice({ ...base, hardware: hardware({ recommendedId: "not-in-catalog" }) })).toBeNull();
  });
});

describe("localFailureCode", () => {
  it("splits the backend's local error messages like local_stt::failure_code", () => {
    expect(
      localFailureCode(
        "Local transcription: not enough memory to load model 'x'. Choose a smaller model in Settings › Transcription.",
      ),
    ).toBe("local-memory");
    expect(
      localFailureCode("Local transcription model 'x' is not downloaded. Download it in Settings › Transcription."),
    ).toBe("local-missing");
    expect(localFailureCode("Local transcription model 'x' failed to load: boom")).toBe("local");
  });
});

describe("fetchLocalSttHardware", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.tauri = true;
  });

  it("calls local_stt_hardware, and is null outside Tauri", async () => {
    mocks.invoke.mockResolvedValueOnce(hardware());
    await expect(fetchLocalSttHardware()).resolves.toEqual(hardware());
    expect(mocks.invoke).toHaveBeenCalledWith("local_stt_hardware");
    mocks.tauri = false;
    await expect(fetchLocalSttHardware()).resolves.toBeNull();
  });
});

describe("vram_low", () => {
  it("is a slow note that blocks nothing, and names the card even without its name", () => {
    expect(downloadGate(fit("slow", "vram_low"))).toBe("ok");
    const t = (k: TranslationKey) => translate("en", k);
    const p = presentFit(
      model({ fit: fit("slow", "vram_low"), vramNeededBytes: 2.5 * GIB }),
      hardware({ accel: "vulkan", gpuVramBytes: GIB }),
      t,
    );
    expect(p).toMatchObject({ tone: "warning", badge: "localStt.fit.slow" });
    expect(p?.reason?.vars).toEqual({ need: "2.5 GB", have: "1 GB", gpu: "the GPU" });
  });
});

describe("presentLoad", () => {
  const line = (lang: "zh-TW" | "en", m: LocalSttModel, hw: LocalSttHardware | null) =>
    presentLoad(m, hw)
      .map((p) => translate(lang, p.key, p.vars))
      .join(" · ");

  it("always shows the load class and memory, fit or no fit", () => {
    const small = model({ loadClass: "light", ramNeededBytes: GIB, heavy: false });
    expect(line("en", small, hardware())).toBe("Light load · about 1 GB RAM");
    expect(line("zh-TW", small, hardware())).toBe("輕量負載 · 約需 1 GB 記憶體");
    // No hardware info: still shown.
    expect(line("en", small, null)).toBe("Light load · about 1 GB RAM");
    // A good fit on a GPU machine: still shown, without the GPU hint.
    const breeze = model({ loadClass: "heavy", ramNeededBytes: 3.5 * GIB, heavy: true, fit: fit("good") });
    expect(line("en", breeze, hardware({ accel: "vulkan" }))).toBe("Heavy load · about 3.5 GB RAM");
  });

  it("recommends a GPU for the large models only when decoding on the CPU", () => {
    const cpu = hardware({ accel: "cpu", cpuReason: "no_vulkan_driver" });
    const turbo = model({ loadClass: "medium", ramNeededBytes: 2.5 * GIB, heavy: true });
    const small = model({ loadClass: "light", ramNeededBytes: GIB, heavy: false });
    expect(line("en", turbo, cpu)).toBe("Medium load · about 2.5 GB RAM · a GPU is recommended");
    expect(line("zh-TW", turbo, cpu)).toBe("中等負載 · 約需 2.5 GB 記憶體 · 建議使用 GPU");
    expect(line("en", small, cpu)).toBe("Light load · about 1 GB RAM");
    for (const accel of ["metal", "vulkan"] as const) {
      expect(line("en", turbo, hardware({ accel }))).not.toContain("GPU");
    }
    // Unknown hardware: no claim about the GPU.
    expect(line("en", turbo, null)).not.toContain("GPU");
  });

  it("shows nothing for a backend that sends no load class", () => {
    expect(presentLoad(model(), hardware())).toEqual([]);
  });
});

describe("presentAccel", () => {
  for (const lang of ["zh-TW", "en"] as const) {
    const t = (k: TranslationKey) => translate(lang, k);
    const text = (hw: LocalSttHardware) => {
      const a = presentAccel(hw, t)!;
      return translate(lang, a.text.key, a.text.vars);
    };

    it(`names the GPU or says why it is CPU only, in ${lang}`, () => {
      expect(presentAccel(hardware({ accel: "vulkan", gpuName: "NVIDIA GeForce RTX 4060" }), t)?.tone).toBe("gpu");
      expect(text(hardware({ accel: "vulkan", gpuName: "NVIDIA GeForce RTX 4060" }))).toContain(
        "NVIDIA GeForce RTX 4060",
      );
      expect(text(hardware({ accel: "metal", gpuName: "Apple M4 GPU" }))).toContain("Apple M4 GPU");
      // A GPU without a name still reads as a sentence.
      expect(text(hardware({ accel: "metal" }))).toMatch(/GPU$/);
      const noDriver = hardware({ accel: "cpu", cpuReason: "no_vulkan_driver", gpuName: "Intel(R) UHD Graphics" });
      expect(presentAccel(noDriver, t)?.tone).toBe("cpu");
      expect(text(noDriver)).toContain("Vulkan");
      expect(text(noDriver)).toContain("Intel(R) UHD Graphics");
      const keys = (["no_gpu", "unsupported_platform", undefined] as const).map(
        (cpuReason) => presentAccel(hardware({ accel: "cpu", cpuReason }), t)?.text.key,
      );
      expect(keys).toEqual(["localStt.accel.cpu.noGpu", "localStt.accel.cpu.platform", "localStt.accel.cpu"]);
      for (const cpuReason of ["no_gpu", "unsupported_platform", "no_vulkan_driver", undefined] as const) {
        expect(text(hardware({ accel: "cpu", cpuReason }))).not.toMatch(/[{}]/);
      }
    });
  }

  it("is absent without hardware info", () => {
    expect(presentAccel(null, (k) => k)).toBeNull();
  });
});
