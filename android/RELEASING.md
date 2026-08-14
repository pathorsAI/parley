# Releasing Parley for Android

Google Play equivalent of `../ios/RELEASING.md`. One-time setup first, then the
per-release loop.

The store-facing content — listing copy in both locales, the Data safety answer
sheet, review notes, and the graphics checklist — lives in
[`AppStore/`](AppStore/README.md), mirroring `../ios/AppStore/`. This file stays
the process; that folder is what gets pasted into Play Console.

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

- Title (≤30 chars), short description (≤80), full description (≤4000) — written
  for both locales in [`AppStore/listing-en.md`](AppStore/listing-en.md) and
  [`AppStore/listing-zh-TW.md`](AppStore/listing-zh-TW.md).
- Graphics: app icon 512×512 PNG, feature graphic 1024×500, ≥2 phone
  screenshots (≥1080px). The icon is exported at
  [`AppStore/assets/icon-512.png`](AppStore/assets/icon-512.png); the rest, with
  the emulator + `adb exec-out screencap` commands, is in
  [`AppStore/assets/README.md`](AppStore/assets/README.md).
- Category: Productivity. Contact email: contact@pathors.com. Privacy policy
  URL: same one used for the iOS listing (required — mic + account data).

### 5. Policy declarations (App content page — the part that actually blocks releases)

- **Data safety form** (Play's version of Apple's privacy label): the answers
  are filled in, with the code that proves each one, in
  [`AppStore/data-safety.md`](AppStore/data-safety.md) — collects Audio (voice
  recordings), account info (name, email, user id) and transcript content; all
  encrypted in transit; nothing shared; no analytics or crash SDK.
- **Account deletion**: Play requires a web URL for account deletion when the
  app supports account creation. **This is not solved yet.** `DELETE /me` is
  implemented on iOS but not in the Android app (`docs/api-cloud.md`, "Not
  implemented"), and `website/privacy/` currently says deletion happens in the
  iOS app's Settings — a route an Android-only user cannot reach. See
  [`AppStore/data-safety.md`](AppStore/data-safety.md).
- **Microphone**: RECORD_AUDIO is not a "sensitive" runtime-review permission
  like SMS/location, no special declaration needed — but the data-safety form
  must match reality or the app gets rejected/removed.
- **Foreground service** (`microphone` type): Play asks for a video
  demonstrating the in-use feature during review of the declaration form
  (Policy → App content → Foreground service permissions). The justification
  text and the shot list for that video are in
  [`AppStore/review-notes.md`](AppStore/review-notes.md).
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

- **Sign-in wall**: like iOS review, provide a demo account in "App access" so
  reviewers can get past login — which account, and the sign-in steps to paste
  alongside it, are in [`AppStore/review-notes.md`](AppStore/review-notes.md).
  Keep it current — an expired demo account is the #1 avoidable rejection.
- **Recording consent**: the listing/description should not suggest covert
  recording; frame it as meeting notes with participants' knowledge (same
  framing that passed App Store review).
- **Broken deep link**: test `parley://auth-callback` on the *release* build —
  minification or a missing intent-filter change is the classic
  works-in-debug-only failure.
