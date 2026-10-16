import { describe, expect, it } from "vitest";
import { isProviderListed, type ProviderListingContext } from "./providerListing";
import { STT_PROVIDERS } from "./transcription/providers";
import { PROVIDERS } from "./ai/providers";

// The pickers in Settings › Transcription, Settings › AI provider and the
// onboarding account step (one STT and one LLM picker) all list providers
// through this one rule. Pinned per edition × session, as the exact id lists
// each picker shows.
const CONTEXTS: Record<string, ProviderListingContext> = {
  "cloud build, signed in": { cloudEnabled: true, signedIn: true },
  "cloud build, signed out": { cloudEnabled: true, signedIn: false },
  "OSS build, signed in": { cloudEnabled: false, signedIn: true },
  "OSS build, signed out": { cloudEnabled: false, signedIn: false },
};

const sttIds = (ctx: ProviderListingContext) =>
  STT_PROVIDERS.filter((p) => isProviderListed(p, ctx)).map((p) => p.id);
const llmIds = (ctx: ProviderListingContext) =>
  PROVIDERS.filter((p) => isProviderListed(p, ctx)).map((p) => p.id);

const ALL_STT = ["soniox", "deepgram", "assemblyai", "openai", "gemini", "parley", "local"];
const BYOK_STT = ALL_STT.filter((id) => id !== "parley");
const ALL_LLM = ["anthropic", "openai", "gemini", "groq", "qwen", "kimi", "ollama", "openrouter", "parley", "custom"];
const BYOK_LLM = ALL_LLM.filter((id) => id !== "parley");

describe("isProviderListed", () => {
  it("offers hosted Parley only in the cloud build with a session (STT)", () => {
    expect(sttIds(CONTEXTS["cloud build, signed in"])).toEqual(ALL_STT);
    expect(sttIds(CONTEXTS["cloud build, signed out"])).toEqual(BYOK_STT);
    expect(sttIds(CONTEXTS["OSS build, signed in"])).toEqual(BYOK_STT);
    expect(sttIds(CONTEXTS["OSS build, signed out"])).toEqual(BYOK_STT);
  });

  it("offers hosted Parley only in the cloud build with a session (LLM)", () => {
    expect(llmIds(CONTEXTS["cloud build, signed in"])).toEqual(ALL_LLM);
    expect(llmIds(CONTEXTS["cloud build, signed out"])).toEqual(BYOK_LLM);
    expect(llmIds(CONTEXTS["OSS build, signed in"])).toEqual(BYOK_LLM);
    expect(llmIds(CONTEXTS["OSS build, signed out"])).toEqual(BYOK_LLM);
  });
});
