# Releasing Parley for Android

Google Play equivalent of `../ios/RELEASING.md`. One-time setup first, then the
per-release loop.

The GitHub secrets the release workflow expects, all of which only Jack can
create (§2 and §7 give the exact commands):

| Secret                            | Needed for               | Status                          |
| --------------------------------- | ------------------------ | ------------------------------- |
| `PLAY_UPLOAD_KEYSTORE_BASE64`     | signing the bundle       | create with `keytool` (§2)      |
| `PLAY_UPLOAD_KEYSTORE_PASSWORD`   | signing the bundle       | create with `keytool` (§2)      |
| `PLAY_UPLOAD_KEY_ALIAS`           | signing the bundle       | create with `keytool` (§2)      |
| `PLAY_UPLOAD_KEY_PASSWORD`        | signing the bundle       | create with `keytool` (§2)      |
| `PLAY_SERVICE_ACCOUNT_JSON`       | uploading to Play        | blocked on verification (§7)    |

## One-time setup

### 1. Google Play developer account

- Register at https://play.google.com/console (one-time US$25 fee). Register as
  an **organization** (Pathors) rather than personal — personal accounts must
  show a physical address publicly and (since 2024) new personal accounts need
  20 testers for 14 days before production access. Organization accounts need a
  D-U-N-S number and verification (company registration docs, ~1–2 weeks).
- Developer name shown on the store: `Pathors`.
- **Status**: the Pathors account exists — developer account ID
  **`6541030546953107772`** — and is **pending organization identity
  verification**. Until that clears, the Play Developer API cannot be enabled,
  which means no service account and therefore no automated upload
  (see §7 below). Everything else on this page can be set up now.

### 2. Signing setup

Play App Signing is mandatory for new apps: Google holds the *app signing key*,
you hold an *upload key* used only to sign what you send them. If the upload key
ever leaks it can be rotated from the Play Console (Release → Setup → App
signing) — unlike the pre-App-Signing days, this is recoverable.

**Jack runs this himself** (the passwords must not pass through anyone else, and
nothing here belongs in the repo):

```bash
cd ~/  # anywhere outside the repo
keytool -genkeypair -v \
  -keystore parley-upload.keystore \
  -alias parley-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Pathors, O=Pathors, C=TW"
```

`keytool` prompts for the keystore password and then the key password; use the
same value for both (Gradle supports them differing, but nothing gains from it).
Store both in 1Password next to the Apple signing secrets, along with the
keystore file itself — **losing it means never shipping an update under this
upload key again**, and recovering requires a Play support ticket.

#### Local builds

`app/build.gradle.kts` reads four settings, taking environment variables first
and `android/local.properties` second (that file is gitignored, as is
`*.keystore`):

| Environment variable              | `local.properties` key            |
| --------------------------------- | --------------------------------- |
| `PARLEY_UPLOAD_KEYSTORE`          | `parley.upload.keystore`          |
| `PARLEY_UPLOAD_KEYSTORE_PASSWORD` | `parley.upload.keystore.password` |
| `PARLEY_UPLOAD_KEY_ALIAS`         | `parley.upload.key.alias`         |
| `PARLEY_UPLOAD_KEY_PASSWORD`      | `parley.upload.key.password`      |

```properties
# android/local.properties — never committed
parley.upload.keystore=/Users/you/parley-upload.keystore
parley.upload.keystore.password=…
parley.upload.key.alias=parley-upload
parley.upload.key.password=…
```

Parley is open source, so **the build must work with none of this set**, and it
does: without a usable keystore the release signing config is simply not
created, `assembleRelease`/`bundleRelease` emit an *unsigned*
`app-release-unsigned.apk` / `app-release.aab`, and Gradle logs a warning
explaining why. Only release tasks print the warning — `assembleDebug` is
silent. Nothing throws at configuration time.

#### CI secrets

The release workflow (`.github/workflows/android-release.yml`) reads these four
repository secrets. Run these from the repo root, once:

```bash
# The keystore is binary, so it travels as base64. macOS `base64` does not wrap
# by default; on Linux use `base64 -w0`.
base64 -i ~/parley-upload.keystore | gh secret set PLAY_UPLOAD_KEYSTORE_BASE64

gh secret set PLAY_UPLOAD_KEYSTORE_PASSWORD   # paste the keystore password
gh secret set PLAY_UPLOAD_KEY_ALIAS           # parley-upload
gh secret set PLAY_UPLOAD_KEY_PASSWORD        # paste the key password
```

Verify with `gh secret list`. To confirm the round trip before relying on it:

```bash
gh secret list | grep PLAY_UPLOAD
base64 -i ~/parley-upload.keystore | base64 --decode | cmp - ~/parley-upload.keystore && echo "base64 round-trips"
```

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

### 7. Play service account (blocked on identity verification)

This is the only piece that cannot be done yet. The Play Developer API is gated
behind a verified account, so the service account below can only be created once
account `6541030546953107772` clears identity verification. The release workflow
already knows this: its Play upload step skips itself while
`PLAY_SERVICE_ACCOUNT_JSON` is unset, so nothing needs changing in CI when the
secret finally appears.

When verification clears:

1. Play Console → **Setup → API access**.
2. **Link a Google Cloud project** — create a fresh one (e.g. `pathors-play`)
   rather than reusing an app's project; a Play account links exactly one
   project and moving it later is a pain.
3. **Create service account** → this bounces to the Cloud Console IAM page.
   Name it `parley-play-publisher`, no project-level roles needed, then
   **Keys → Add key → Create new key → JSON** and download it.
4. Back in Play Console → API access the account appears under *Service
   accounts*. **Grant access** → give it the **Release manager** role (upload
   and release to testing tracks and production, but no access to payments or
   account settings), restrict it to the Parley app under *App permissions*,
   then **Invite user**.
5. Push the JSON into GitHub and delete the local copy:

   ```bash
   gh secret set PLAY_SERVICE_ACCOUNT_JSON < ~/Downloads/pathors-play-*.json
   rm ~/Downloads/pathors-play-*.json
   ```

6. Permissions take a few minutes to a few hours to propagate on a fresh
   account. A `403 The caller does not have permission` on the first run is
   usually just that, not a misconfiguration.

Note that the **first** bundle for a package cannot go through the API — Play
refuses until the app has a release created in the console. So the very first
internal-track release is a manual upload regardless; automation takes over from
the second one.

### 8. Dependency verification

`gradle/verification-metadata.xml` pins a sha256 for every resolved artifact, so
a compromised mirror fails the build instead of shipping. Two things about it
are easy to get wrong:

- **It is host-OS-sensitive.** `com.android.tools.build:aapt2` ships one jar per
  host (`-osx`, `-linux`, `-windows`) and Gradle only records the classifier it
  actually resolved, so a file regenerated on a Mac alone fails on the Linux CI
  runner. All three classifiers are listed in the committed file — keep it that
  way. After an AGP bump, regenerate and then re-add the other two by resolving
  them explicitly (a throwaway Gradle project with the same wrapper, a
  configuration depending on
  `com.android.tools.build:aapt2:<version>:linux@jar` and `:windows@jar`, run
  with `--write-verification-metadata sha256`), then paste those two
  `<artifact>` blocks into the `aapt2` component.

  Checking the fix does not need a Linux box: force all three classifiers to
  resolve locally (same trick, but run inside `android/` so the committed
  metadata is the one being enforced) and Gradle verifies each against the file.
  Corrupt a digit in the linux hash and the build fails — that is the proof the
  entry is live.

- **It must cover the release path.** Regenerating with only `assembleDebug`
  leaves out R8, lint and the bundle tooling, and `bundleRelease` then fails
  verification. Always regenerate with the full set:

  ```bash
  cd android
  ./gradlew assembleDebug assembleRelease bundleRelease \
    :parleykit:test :app:testDebugUnitTest \
    --write-verification-metadata sha256
  ```

## Per-release loop

1. Bump `versionCode` (must strictly increase; integer) and `versionName` in
   `app/build.gradle.kts`. CI asserts `versionName` matches the tag.
2. Tag and push — that is the whole release:

   ```bash
   git tag android-v0.1.0 && git push origin android-v0.1.0
   ```

   `.github/workflows/android-release.yml` runs the tests, builds and signs the
   bundle with the upload key, attaches the `.aab` to a GitHub Release, and
   uploads it to the Play **internal** track — that last step skipping itself
   until `PLAY_SERVICE_ACCOUNT_JSON` exists (§7). `workflow_dispatch` re-runs an
   existing tag without needing a new commit, matching `ios-release.yml`.
3. To build the bundle by hand instead (Play requires `.aab`, not `.apk`):

   ```bash
   cd android && ./gradlew bundleRelease
   # → app/build/outputs/bundle/release/app-release.aab
   ```

   With no upload key configured this produces an *unsigned* bundle and says so;
   Play will reject it.
4. Sanity-check the release build locally (minified!):

   ```bash
   ./gradlew installRelease   # or bundletool build-apks + install
   ```

   Verify: sign-in deep link, live meeting, file import, upload queue drain.
5. While the Play upload is still manual: Play Console → Release → (track) →
   Create new release → upload the `.aab` from the GitHub release, release notes
   (en + zh-TW), review, roll out.
6. Keep the R8 `mapping.txt`. Every workflow run attaches it as an artifact and
   the Play upload step sends it along, so crash reports deobfuscate; a stack
   trace from a build whose mapping was lost is unreadable.

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
