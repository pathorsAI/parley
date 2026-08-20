# Releasing Parley for Android

Google Play equivalent of `../ios/RELEASING.md`. One-time setup first, then the
per-release loop.

The store-facing content — listing copy in both locales, the Data safety answer
sheet, review notes, and the graphics checklist — lives in
[`AppStore/`](AppStore/README.md), mirroring `../ios/AppStore/`. This file stays
the process; that folder is what gets pasted into Play Console.

The GitHub secrets the release workflow expects (§2 and §7 give the exact
commands):

| Secret                            | Needed for               | Status                          |
| --------------------------------- | ------------------------ | ------------------------------- |
| `PLAY_UPLOAD_KEYSTORE_BASE64`     | signing the bundle       | **set** — keystore created (§2) |
| `PLAY_UPLOAD_KEYSTORE_PASSWORD`   | signing the bundle       | **set**                         |
| `PLAY_UPLOAD_KEY_ALIAS`           | signing the bundle       | **set** — `parley-upload`       |
| `PLAY_UPLOAD_KEY_PASSWORD`        | signing the bundle       | **set**                         |
| _(no secret)_                     | uploading to Play        | keyless via WIF — **set** (§7)  |

Play publishing carries no secret at all. It authenticates with GitHub's OIDC
token through Workload Identity Federation, configured by two repository
*variables* (not secrets — they identify, they do not authorize):
`PLAY_WIF_PROVIDER` and `PLAY_PUBLISHER_SERVICE_ACCOUNT`.

The upload keystore itself is not in this repo and never will be. It lives in
Pathors' private secret store alongside the Apple signing keys, together with a
note recording its alias and fingerprint. Ask Jack if you need it; the recovery
path if it is ever lost is an upload-key reset from Play Console, not a new app
listing (see §2).

## One-time setup

### 1. Google Play developer account

- Register at https://play.google.com/console (one-time US$25 fee). Register as
  an **organization** (Pathors) rather than personal — personal accounts must
  show a physical address publicly and (since 2024) new personal accounts need
  20 testers for 14 days before production access. Organization accounts need a
  D-U-N-S number and verification (company registration docs, ~1–2 weeks).
- Developer name shown on the store: `Pathors`.
- **Status**: the Pathors account exists — developer account ID
  **`6541030546953107772`** — and organization identity verification **cleared
  on 2026-08-17**, along with the app itself (`com.pathors.parley`, app ID
  `4972589806984548870`). The Play Developer API is therefore no longer blocked;
  §7 is simply outstanding work.

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

### 7. Play publishing (keyless, via Workload Identity Federation)

Identity verification cleared on 2026-08-17 and the Google Cloud side is **done**
(2026-08-20). What is left is two clicks in the Play Console that have no API —
see the end of this section.

**There is no service-account key, and there will not be one.** The `pathors.com`
organization enforces `iam.disableServiceAccountKeyCreation`, so
`gcloud iam service-accounts keys create` fails with
`FAILED_PRECONDITION: Key creation is not allowed on this service account`. That
policy is Google's default for new organizations and it is a good one: a Play
publishing key sitting in a GitHub secret is a long-lived credential that can
ship code to users. Rather than granting the project an exception, the release
authenticates with the OIDC token GitHub mints for each run, which Google
exchanges for a credential that expires on its own.

What exists in Google Cloud:

| | |
| --- | --- |
| project | `pathors-play` (474482934105) — dedicated; a Play account links exactly one project and moving it later is a pain |
| API | `androidpublisher`, plus `sts` and `iamcredentials` for the exchange |
| service account | `parley-play-publisher@pathors-play.iam.gserviceaccount.com`, **no project-level IAM roles** — everything it may do is granted in the Play Console |
| pool / provider | `github` / `pathorsai`, issuer `token.actions.githubusercontent.com`, attribute condition `assertion.repository_owner=='pathorsAI'` |
| impersonation | `roles/iam.workloadIdentityUser` for `attribute.repository/pathorsAI/parley` — that repository and no other |

and in GitHub, as repository variables rather than secrets, because neither
value authorizes anything on its own:

```
PLAY_WIF_PROVIDER              projects/474482934105/locations/global/workloadIdentityPools/github/providers/pathorsai
PLAY_PUBLISHER_SERVICE_ACCOUNT parley-play-publisher@pathors-play.iam.gserviceaccount.com
```

To rebuild all of that from nothing — after `gcloud auth login` as the Play
account owner:

```bash
./android/scripts/create-play-service-account.sh
```

It is idempotent, so it is also the way to repair a piece of it.

**`android-release.yml` fails when Play publishing is not configured.** It used
to skip the upload silently, which was defensible while the Play API was
genuinely unreachable and is not any more: a release run that reports success
without publishing is the worst kind of green — the tag is used up, the GitHub
release exists, and nobody finds out until someone asks where the build went.
The check runs immediately after checkout, so a misconfigured release costs
seconds and leaves no half-made release behind.

#### Granting the service account access (done 2026-08-20)

**There is no "API access" page and no "Release manager" role any more.** Older
guides — including earlier versions of this one — send you to
`Setup → API access`, which now redirects to the app list. Google folded service
accounts into ordinary user management, and roles into individual permissions.

The current path is **Users and permissions → Invite new user**, with the
service account's email as the user:

1. Play Console → **使用者和權限 / Users and permissions** → **邀請新的使用者 /
   Invite new user**
2. Email: `parley-play-publisher@pathors-play.iam.gserviceaccount.com`
3. **App permissions** tab (not Account permissions — account permissions apply
   to every app in the developer account) → add **Parley** → grant:
   - 查看應用程式資訊 (唯讀) / View app information — the read access every
     other permission is layered on
   - 將應用程式發布至測試群組 / Release to testing tracks
   - 發布正式版… / Release to production
4. **Invite user**

No Cloud-project link is involved anywhere in this flow.

Permissions can take minutes to propagate. A `403 The caller does not have
permission` on the first run is usually just that, not a misconfiguration.

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
   uploads it to the Play **internal** track. When Play publishing is not
   configured the run **fails** rather than publishing a half-release (§7). `workflow_dispatch` re-runs an existing tag without
   needing a new commit, matching `ios-release.yml`, and takes a
   `skip_play_upload` input for the first-bundle case.
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
5. **Which track a tag ships to is configuration, not code.** The repository
   variable `PLAY_TRACK` (default `internal`) decides; a `workflow_dispatch`
   run can override it with the `track` input for one run. Moving the whole
   pipeline to production is therefore one variable, with no commit and no
   release cut to change it.

   `PLAY_USER_FRACTION` (e.g. `0.1`) turns a production release into a staged
   rollout — worth having, because it is the only undo Play offers once a build
   is live.

   **`PLAY_TRACK` stays `internal` until the app has actually launched.** Play
   refuses a production release while the store listing, content rating, data
   safety and target-audience forms are outstanding, so pointing at production
   early would fail every release until someone finished them. As of 2026-08-20
   the app dashboard reads *已完成 6 項，共 11 項*; the five outstanding ones are
   登入詳細資料, 內容分級, 目標對象, 資料安全性, and the app category/contact
   details. They are declarations about the app, not build config — nobody can
   automate them, and the prepared answers are in `AppStore/`.

   The first bundle for the package was uploaded by hand on 2026-08-18
   (`0.1.0 (1)`, internal track), so the API can take over from `versionCode`
   2 onward. Play rejects a `versionCode` it has already seen, which is why
   `android-v0.1.0` could never have been published over the API.
6. Keep the R8 `mapping.txt`. Every workflow run attaches it as an artifact and
   the Play upload step sends it along, so crash reports deobfuscate; a stack
   trace from a build whose mapping was lost is unreadable.

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
