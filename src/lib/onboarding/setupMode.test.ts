import { describe, it, expect } from "vitest";
import {
  cloudRoutePatch,
  effectiveSetupMode,
  localRoutePatch,
  onHostedProviders,
  resolveSetupMode,
} from "./setupMode";

describe("resolveSetupMode", () => {
  it("is always local without the cloud edition", () => {
    expect(resolveSetupMode({ setupMode: "cloud", transcriptionProvider: "parley" }, false)).toBe("local");
    expect(resolveSetupMode({}, false)).toBe("local");
  });

  it("keeps a saved route", () => {
    expect(resolveSetupMode({ setupMode: "cloud", transcriptionProvider: "soniox" }, true)).toBe("cloud");
    expect(resolveSetupMode({ setupMode: "local", transcriptionProvider: "parley" }, true)).toBe("local");
  });

  it("derives a missing route from the transcription provider: hosted is cloud, the rest local", () => {
    expect(resolveSetupMode({ transcriptionProvider: "parley" }, true)).toBe("cloud");
    expect(resolveSetupMode({ transcriptionProvider: "soniox" }, true)).toBe("local");
    expect(resolveSetupMode({ transcriptionProvider: "local" }, true)).toBe("local");
    expect(resolveSetupMode({}, true)).toBe("local");
    expect(resolveSetupMode({ setupMode: "hybrid" }, true)).toBe("local");
  });
});

describe("effectiveSetupMode", () => {
  it("only the cloud edition can be on the cloud route", () => {
    expect(effectiveSetupMode("cloud", true)).toBe("cloud");
    expect(effectiveSetupMode("cloud", false)).toBe("local");
    expect(effectiveSetupMode("local", true)).toBe("local");
  });
});

describe("route patches", () => {
  it("cloud puts both lanes and transcription on Parley's hosted models", () => {
    const patch = cloudRoutePatch();
    expect(patch).toEqual({
      setupMode: "cloud",
      transcriptionProvider: "parley",
      llmProviders: { realtime: "parley", deep: "parley" },
    });
    expect(onHostedProviders({ transcriptionProvider: "parley", llmProviders: { realtime: "parley", deep: "parley" } })).toBe(
      true,
    );
  });

  it("local moves everything hosted off Parley", () => {
    expect(
      localRoutePatch({ transcriptionProvider: "parley", llmProviders: { realtime: "parley", deep: "parley" } }),
    ).toEqual({
      setupMode: "local",
      transcriptionProvider: "soniox",
      llmProviders: { realtime: "groq", deep: "groq" },
    });
  });

  it("local leaves the user's own choices alone, lane by lane", () => {
    expect(
      localRoutePatch({ transcriptionProvider: "deepgram", llmProviders: { realtime: "parley", deep: "anthropic" } }),
    ).toEqual({ setupMode: "local", llmProviders: { realtime: "groq", deep: "anthropic" } });
    expect(
      localRoutePatch({ transcriptionProvider: "local", llmProviders: { realtime: "openai", deep: "openai" } }),
    ).toEqual({ setupMode: "local" });
  });

  it("a half-hosted setup is not on the hosted pair", () => {
    expect(onHostedProviders({ transcriptionProvider: "parley", llmProviders: { realtime: "groq", deep: "parley" } })).toBe(
      false,
    );
    expect(onHostedProviders({ transcriptionProvider: "soniox", llmProviders: { realtime: "parley", deep: "parley" } })).toBe(
      false,
    );
  });
});
