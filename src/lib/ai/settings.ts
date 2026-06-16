import type { Settings } from "../types";

/** Whether the active provider has a usable API key configured. */
export function hasProviderKey(settings: Settings): boolean {
  const key =
    settings.provider === "anthropic"
      ? settings.anthropicApiKey
      : settings.provider === "groq"
      ? settings.groqApiKey
      : settings.openrouterApiKey;
  return !!key.trim();
}
