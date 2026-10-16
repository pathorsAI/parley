import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings } from "../types";
import { accountGateBlock, transcriptionReady, type LocalGateInput } from "./accountGate";
import type { LocalSttModel } from "../transcription/localModels";

const base = useStore.getState().settings;
const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });
const SELECTED = "breeze-asr-25-q5_0";
const local = (over: Partial<LocalSttModel> = {}): LocalSttModel => ({
  id: SELECTED,
  family: "breeze",
  sizeBytes: 1_080_000_000,
  installed: false,
  downloading: false,
  ...over,
});
const noLocal: LocalGateInput = { models: null, downloads: {} };
const localSettings = settingsFor({ transcriptionProvider: "local", localSttModel: SELECTED });

describe("accountGateBlock — BYOK / hosted (unchanged behaviour)", () => {
  it("passes when signed in, or with a key for the selected provider", () => {
    expect(accountGateBlock(settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "" }), true, noLocal)).toBeNull();
    expect(accountGateBlock(settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: "k" }), false, noLocal)).toBeNull();
  });

  it("blocks for a credential otherwise", () => {
    expect(accountGateBlock(settingsFor({ transcriptionProvider: "deepgram", deepgramApiKey: "  " }), false, noLocal)).toBe(
      "credential",
    );
  });
});

describe("accountGateBlock — local", () => {
  it("blocks until the selected model is downloaded, even when signed in", () => {
    expect(accountGateBlock(localSettings, true, { models: [local()], downloads: {} })).toBe("localDownload");
    expect(accountGateBlock(localSettings, false, noLocal)).toBe("localDownload");
  });

  it("blocks while a download is in flight", () => {
    expect(
      accountGateBlock(localSettings, false, {
        models: [local()],
        downloads: { [SELECTED]: { status: "downloading", received: 10, total: 100 } },
      }),
    ).toBe("localDownloading");
    expect(
      accountGateBlock(localSettings, false, { models: [local()], downloads: { [SELECTED]: { status: "verifying" } } }),
    ).toBe("localDownloading");
  });

  it("still blocks after a failed or cancelled download", () => {
    expect(
      accountGateBlock(localSettings, false, {
        models: [local()],
        downloads: { [SELECTED]: { status: "error", message: "net" } },
      }),
    ).toBe("localDownload");
    expect(
      accountGateBlock(localSettings, false, { models: [local()], downloads: { [SELECTED]: { status: "cancelled" } } }),
    ).toBe("localDownload");
  });

  it("blocks while ANOTHER model is downloading, even if the selected one is installed", () => {
    const models = [local({ installed: true }), local({ id: "whisper-small-q5_1", family: "whisper" })];
    expect(
      accountGateBlock(localSettings, false, {
        models,
        downloads: { "whisper-small-q5_1": { status: "downloading", received: 1, total: 2 } },
      }),
    ).toBe("localDownloading");
  });

  it("passes once installed with nothing downloading", () => {
    const input = { models: [local({ installed: true })], downloads: {} };
    expect(accountGateBlock(localSettings, false, input)).toBeNull();
    expect(transcriptionReady(localSettings, false, input)).toBe(true);
  });

  it("a hardware warning never blocks an installed model", () => {
    for (const fit of [
      { level: "unsupported" as const, reasons: ["ram_low" as const] },
      { level: "slow" as const, reasons: ["cpu_only" as const, "ram_tight" as const] },
      { level: "unsupported" as const, reasons: ["disk_low" as const] },
    ]) {
      expect(
        accountGateBlock(localSettings, false, { models: [local({ installed: true, fit })], downloads: {} }),
      ).toBeNull();
    }
  });

  it("a good fit does not stand in for the download", () => {
    expect(
      accountGateBlock(localSettings, false, {
        models: [local({ fit: { level: "good", reasons: [] } })],
        downloads: {},
      }),
    ).toBe("localDownload");
  });

  it("a model installed but not selected doesn't count", () => {
    expect(
      accountGateBlock(localSettings, false, {
        models: [local(), local({ id: "whisper-small-q5_1", family: "whisper", installed: true })],
        downloads: {},
      }),
    ).toBe("localDownload");
  });
});
