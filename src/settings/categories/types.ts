import type { Settings } from "../../lib/types";

/** Apply a settings edit (the store broadcasts it to the other windows). */
export type Patch = (p: Partial<Settings>) => void;

/** What every panel that edits settings gets. */
export interface SettingsPanelProps {
  settings: Settings;
  patch: Patch;
}

/** Which providers a picker may list (the hosted ones need the cloud + a sign-in). */
export interface ProviderListing {
  cloudEnabled: boolean;
  signedIn: boolean;
}
