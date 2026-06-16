import type { Settings } from "../types";
import { PROVIDER_BY_ID } from "./providers";

/** Whether the active provider has a usable API key configured. */
export function hasProviderKey(settings: Settings): boolean {
  const info = PROVIDER_BY_ID[settings.provider];
  // Local providers (Ollama) run without a key.
  if (info.requiresKey === false) return true;
  return !!settings[info.apiKeyField].trim();
}
