# Releasing Parley for Android

Google Play equivalent of `../ios/RELEASING.md`. One-time setup first, then the
per-release loop.

## One-time setup

### 1. Google Play developer account

- Register at https://play.google.com/console (one-time US$25 fee). Register as
  an **organization** (Pathors) rather than personal — personal accounts must
  show a physical address publicly and (since 2024) new personal accounts need
  20 testers for 14 days before production access. Organization accounts need a
  D-U-N-S number and verification (company registration docs, ~1–2 weeks).
- Developer name shown on the store: `Pathors`.

### 2. Upload keystore + Play App Signing

Play App Signing is mandatory for new apps: Google holds the *app signing key*,
you hold an *upload key* used only to sign what you send them.

```bash
keytool -genkeypair -v \
  -keystore parley-upload.keystore \
  -alias parley-upload -keyalg RSA -keysize 4096 -validity 10000
```

- Keep `parley-upload.keystore` + passwords out of git (the `android/.gitignore`
  already excludes `*.keystore`). Store them wherever the iOS signing secrets
  live; add `PLAY_UPLOAD_KEYSTORE_*` secrets to GitHub if/when CI is added.
- If the upload key ever leaks, it can be rotated from the Play Console
  (Release → Setup → App signing) — unlike the pre-App-Signing days, this is
  recoverable.

Wire it into `app/build.gradle.kts` via a `signingConfigs` block that reads
`local.properties`/env vars (never hardcode passwords).

### 3. Create the app in Play Console

- App name **Parley**, default language, App or Game → App, Free.
- Package name is fixed forever once the first bundle is uploaded:
  **`com.pathors.parley`**.

### 4. Store listing (Grow → Store presence)

- Title (≤30 chars), short description (≤80), full description (≤4000) —
  reuse copy from `../ios/AppStore/` metadata, adapted.
- Graphics: app icon 512×512 PNG, feature graphic 1024×500, ≥2 phone
  screenshots (16:9–9:16, ≥1080px). Reuse the iOS screenshot pipeline
  (`../ios/AppStore/capture-screenshots.sh`) as inspiration; an emulator +
  `adb exec-out screencap` gives clean frames.
- Category: Productivity. Contact email: contact@pathors.com. Privacy policy
  URL: same one used for the iOS listing (required — mic + account data).

### 5. Policy declarations (App content page — the part that actually blocks releases)

- **Data safety form** (Play's version of Apple's privacy label — mirror
  `../ios/AppStore/privacy-label.md`): collects Audio (voice recordings) and
  Account info (email); data encrypted in transit; account deletion available
  (`DELETE /me`). Declare recordings are uploaded to `api.parley.tw`.
- **Account deletion**: Play requires a web URL for account deletion when the
  app supports account creation. Point at the sign-in page's account settings
  or a small hosted page that walks through in-app deletion.
- **Microphone**: RECORD_AUDIO is not a "sensitive" runtime-review permission
  like SMS/location, no special declaration needed — but the data-safety form
  must match reality or the app gets rejected/removed.
- **Foreground service** (`microphone` type): Play asks for a video
  demonstrating the in-use feature during review of the declaration form
  (Policy → App content → Foreground service permissions). A 30-second screen
  recording of a live meeting transcription suffices.
- Content rating questionnaire (IARC), ads declaration (none), target audience
  (18+/general, not child-directed), News app: no, COVID app: no.

### 6. Testing tracks

Recommended path for the first release:

1. **Internal testing** (up to 100 testers, live in minutes, no review):
   upload the first `.aab` here, add your own Google account as tester.
2. **Closed testing** if/when there are external testers.
3. **Production** once verified. First production rollout of a new app goes
   through full review (typically 1–7 days; first-ever review of a new
   developer account can take longer).

## Per-release loop

1. Bump `versionCode` (must strictly increase; integer) and `versionName` in
   `app/build.gradle.kts`.
2. Build the bundle (Play requires `.aab`, not `.apk`):

   ```bash
   cd android && ./gradlew bundleRelease
   # → app/build/outputs/bundle/release/app-release.aab
   ```

3. Sanity-check the release build locally (minified!):

   ```bash
   ./gradlew installRelease   # or bundletool build-apks + install
   ```

   Verify: sign-in deep link, live meeting, file import, upload queue drain.
4. Play Console → Release → (track) → Create new release → upload the `.aab`,
   release notes (en + zh-TW), review, roll out.
5. Tag the repo `android-vX.Y.Z` to match the iOS `ios-vX.Y` convention.

## Review gotchas specific to this app

- **Sign-in wall**: like iOS review, provide a demo account
  (see `../ios/AppStore/review-notes.md`) in "App access" so reviewers can get
  past login. Keep it current — an expired demo account is the #1 avoidable
  rejection.
- **Recording consent**: the listing/description should not suggest covert
  recording; frame it as meeting notes with participants' knowledge (same
  framing that passed App Store review).
- **Broken deep link**: test `parley://auth-callback` on the *release* build —
  minification or a missing intent-filter change is the classic
  works-in-debug-only failure.
