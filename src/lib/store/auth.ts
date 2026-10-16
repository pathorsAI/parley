// The Parley Cloud sign-in (persisted with the settings).

import type { CloudAuth } from "../cloud/types";
import { FALLBACK_STT_PROVIDER, sttRequiresAccount } from "../transcription/registry";
import type { SliceCreator } from "./types";

export interface AuthSlice {
  /** Parley Cloud sign-in (Google). Persisted so you stay signed in. null = signed out. */
  cloudAuth: CloudAuth | null;
  setCloudAuth: (auth: CloudAuth | null) => void;
}

export const createAuthSlice: SliceCreator<AuthSlice> = (set) => ({
  cloudAuth: null,

  setCloudAuth: (cloudAuth) =>
    set((s) => {
      // Signing out (or an expired session): a stale account-only STT
      // selection (hosted "parley") can no longer authenticate. Fall back to a
      // BYOK default so the next meeting fails loud (or works) instead of
      // silently starting a mock stream, and so the Settings picker doesn't
      // render blank.
      if (!cloudAuth && sttRequiresAccount(s.settings.transcriptionProvider)) {
        return { cloudAuth, settings: { ...s.settings, transcriptionProvider: FALLBACK_STT_PROVIDER } };
      }
      return { cloudAuth };
    }),
});
