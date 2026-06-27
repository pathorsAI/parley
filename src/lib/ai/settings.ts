import type { Settings } from "../types";
import { PROVIDER_BY_ID } from "./providers";
import { cloudToken } from "../cloud/client";

/** Whether the active provider has a usable API key configured. */
export function hasProviderKey(settings: Settings): boolean {
  const info = PROVIDER_BY_ID[settings.provider];
  // Hosted "parley" provider: signed-in (a session token) IS the gate — there's
  // no API key; auth rides as the bearer token.
  if (info.id === "parley") return cloudToken() != null;
  // Local providers (Ollama) run without a key.
  if (info.requiresKey === false) return true;
  return !!settings[info.apiKeyField].trim();
}
