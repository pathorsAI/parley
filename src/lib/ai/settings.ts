import type { Settings } from "../types";
import { PROVIDER_BY_ID } from "./providers";

/** Whether the active provider has a usable API key configured. */
export function hasProviderKey(settings: Settings): boolean {
  const field = PROVIDER_BY_ID[settings.provider].apiKeyField;
  return !!settings[field].trim();
}
