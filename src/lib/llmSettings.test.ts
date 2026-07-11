import { describe, expect, it } from "vitest";
import { migrateLlmSettings } from "./store";
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
});
