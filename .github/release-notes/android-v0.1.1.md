Releases now go to Google Play straight from the tag. No change to the app itself.

- **Publishing is keyless.** The workflow authenticates to Play through GitHub's OIDC token and Workload Identity Federation, so no service-account key is stored anywhere.
- **A release that cannot reach Play fails** instead of reporting success with nothing published.
- **The Play track is configuration** (`PLAY_TRACK`), not code.

Play rejected this build on 2026-08-28 ("app opens but keeps stopping"); 0.1.2 fixes the cause.
