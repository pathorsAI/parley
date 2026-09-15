import { describe, expect, it, vi } from "vitest";

// The readiness gate asks the cloud client for a session token to judge the
// hosted provider; nothing here goes near it.
vi.mock("./cloud/client", () => ({ cloudToken: () => null }));

import { migrateLlmSettings } from "./store";
import {
  hasProviderKey,
  isProviderReady,
  missingProviderRequirement,
  providerGateKey,
} from "./ai/settings";
import type { Settings } from "./types";

/** #131: legacy single-provider settings must map onto the workload lanes. */
describe("migrateLlmSettings", () => {
  it("maps a legacy provider + {ask,eval} models onto realtime/deep", () => {
    const legacy = {
      provider: "openai",
      models: { openai: { ask: "gpt-4.1", eval: "gpt-5.5" } },
      reasoningEffort: { ask: "low", eval: "medium" },
    } as unknown as Partial<Settings>;

    const out = migrateLlmSettings(legacy);
    expect(out.llmProviders).toEqual({ realtime: "openai", deep: "openai" });
    // Realtime inherits the (faster) ask model; deep inherits eval.
    expect(out.models.openai).toEqual({ realtime: "gpt-4.1", deep: "gpt-5.5" });
    expect(out.reasoningEffort).toEqual({ realtime: "low", deep: "medium" });
  });

  it("passes an already-migrated shape through untouched", () => {
    const migrated: Partial<Settings> = {
      llmProviders: { realtime: "groq", deep: "anthropic" },
      models: {
        anthropic: { realtime: "claude-haiku-4-5", deep: "claude-opus-4-8" },
      } as Settings["models"],
      reasoningEffort: { realtime: "high", deep: "low" },
    };

    const out = migrateLlmSettings(migrated);
    expect(out.llmProviders).toEqual({ realtime: "groq", deep: "anthropic" });
    expect(out.models.anthropic).toEqual({ realtime: "claude-haiku-4-5", deep: "claude-opus-4-8" });
    expect(out.reasoningEffort).toEqual({ realtime: "high", deep: "low" });
  });

  it("falls back to defaults for empty persisted state and unknown providers", () => {
    const out = migrateLlmSettings({});
    expect(out.llmProviders).toEqual({ realtime: "groq", deep: "groq" });
    expect(out.models.groq.realtime).toBeTruthy();
    expect(out.models.groq.deep).toBeTruthy();

    // A provider key that no longer exists must not crash or leak in.
    const stray = migrateLlmSettings({
      models: { ghost: { ask: "a", eval: "b" } } as unknown as Settings["models"],
    });
    expect("ghost" in stray.models).toBe(false);
  });

  it("spreads a legacy string reasoningEffort across both lanes", () => {
    const out = migrateLlmSettings({ reasoningEffort: "high" } as unknown as Partial<Settings>);
    expect(out.reasoningEffort).toEqual({ realtime: "high", deep: "high" });
  });

  /**
   * The self-hosted "custom" provider is the only one whose model list is
   * empty, so its defaults are blank strings rather than ids. Settings written
   * before it existed carry no entry for it at all, and must still load.
   */
  it("gives the custom provider blank model defaults and keeps a saved pair", () => {
    expect(migrateLlmSettings({}).models.custom).toEqual({ realtime: "", deep: "" });

    const saved = migrateLlmSettings({
      llmProviders: { realtime: "custom", deep: "custom" },
      models: { custom: { realtime: "mistral-7b", deep: "llama-3.3-70b" } } as Settings["models"],
    });
    expect(saved.models.custom).toEqual({ realtime: "mistral-7b", deep: "llama-3.3-70b" });
  });
});

/**
 * The gate every pre-flight check in the app runs through. For "custom" it is
 * NOT about a key — the key is optional there — so it has to be satisfied by a
 * base URL plus a model id instead, or a lawyer pointing Parley at their own
 * server gets told to add an API key that does not exist.
 */
describe("missingProviderRequirement", () => {
  function customSettings(customBaseUrl: string, model: string, customApiKey = ""): Settings {
    return {
      llmProviders: { realtime: "custom", deep: "custom" },
      models: { custom: { realtime: model, deep: model } },
      customBaseUrl,
      customApiKey,
    } as unknown as Settings;
  }

  it("asks for the base URL first", () => {
    expect(missingProviderRequirement(customSettings("", "m"), "realtime")).toBe("baseUrl");
  });

  it("rejects a base URL that isn't http(s)", () => {
    expect(missingProviderRequirement(customSettings("localhost:8000", "m"), "deep")).toBe("baseUrl");
    expect(missingProviderRequirement(customSettings("ftp://box/v1", "m"), "deep")).toBe("baseUrl");
  });

  it("asks for a model id once the URL parses", () => {
    expect(missingProviderRequirement(customSettings("http://localhost:8000/v1", "  "), "deep")).toBe(
      "model"
    );
  });

  it("is satisfied with a URL and a model, and never needs the key", () => {
    const s = customSettings("http://localhost:8000/v1/", "my-model");
    expect(missingProviderRequirement(s, "realtime")).toBeNull();
    expect(isProviderReady(s, "deep")).toBe(true);
    expect(hasProviderKey(s, "deep")).toBe(true);
  });

  it("still asks hosted providers for their API key", () => {
    const groq = {
      llmProviders: { realtime: "groq", deep: "groq" },
      models: { groq: { realtime: "a", deep: "b" } },
      groqApiKey: "  ",
    } as unknown as Settings;
    expect(missingProviderRequirement(groq, "realtime")).toBe("apiKey");
  });
});

describe("providerGateKey", () => {
  it("names the blank field instead of the surface's 'add a key' copy", () => {
    expect(providerGateKey("baseUrl", "actionItems.noKey")).toBe("provider.missingBaseUrl");
    expect(providerGateKey("model", "actionItems.noKey")).toBe("provider.missingModel");
  });

  it("keeps each surface's own wording for a plain missing key", () => {
    expect(providerGateKey("apiKey", "actionItems.noKey")).toBe("actionItems.noKey");
  });

  it("shows no gate at all once the provider is ready", () => {
    expect(providerGateKey(null, "actionItems.noKey")).toBeNull();
  });
});
