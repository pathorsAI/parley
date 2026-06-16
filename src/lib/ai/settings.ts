import type { Settings } from "../types";

/** Whether the active provider has a usable API key configured. */
export function hasProviderKey(settings: Settings): boolean {
  return settings.provider === "anthropic"
    ? !!settings.anthropicApiKey.trim()
    : !!settings.openrouterApiKey.trim();
}
