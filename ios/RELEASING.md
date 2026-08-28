# Parley iOS — release checklist

Parley iOS is the cloud companion for face-to-face meetings. It records the
phone microphone, streams it through the hosted Parley relay, and syncs the
Ogg recording plus transcript to the same account as the desktop app. Since 1.1
it also ships a voice-typing keyboard extension. It does not capture phone calls
or other apps' audio.

Already configured for the Pathors Apple team (`SXHVCQXJHZ`):

- Bundle IDs: `com.pathors.parley.ios`, `com.pathors.parley.ios.keyboard`
- App Group: `group.com.pathors.parley.ios` (the app ↔ keyboard transcript handoff)
- App Store Connect app: `Parley` (`6795031201`)
- Sign in with Apple capability and hosted Better Auth Apple provider
- Hosted login page: `https://api.parley.tw/sign-in`

## Release build

**Preferred: tag and let CI do it.**

```bash
# bump CFBundleVersion in ios/App/project.yml first — see below
git tag ios-v1.1 && git push origin ios-v1.1
```

[`ios-release.yml`](../.github/workflows/ios-release.yml) archives, exports, and
uploads to TestFlight. It refuses to build if the tag disagrees with
`CFBundleShortVersionString`, and keeps the `.ipa` and dSYMs as run artifacts —
a TestFlight crash report is unreadable without the dSYMs from the exact archive
that produced the build.

It authenticates with the `APPLE_API_KEY_CONTENT` / `APPLE_API_KEY` /
`APPLE_API_ISSUER` secrets, the same App Store Connect API key the desktop
workflow notarizes with. The key creates this run's provisioning profiles and
authenticates the TestFlight upload; it is deliberately **not** passed to
`xcodebuild` — see below.

**Signing on the runner is not Xcode-managed, and this is the part that will
confuse you.** A runner's keychain is empty, so Xcode's cloud signing is
supposed to fetch an identity. It does — but only a *development* one, and then
`-exportArchive` fails with:

```
error: exportArchive Cloud signing permission error
error: exportArchive No profiles for 'com.pathors.parley.ios' were found
```

That message reads like a permissions problem and is not one. This document
used to claim the API key's role was too narrow; it isn't. Probing the API with
the current key returns `200` on `/v1/users`, which a Developer-role key cannot
read at all, and it mints certificates and profiles without complaint. The
actual cause was that **the team held no iOS Distribution certificate** — only
`DEVELOPMENT` certificates and the macOS `DEVELOPER_ID_APPLICATION_G2` the
desktop app notarizes with — so cloud signing had nothing to find.

There is one now, and it is long-lived:

| secret | what it is |
| --- | --- |
| `APPLE_IOS_DIST_P12` | base64 of the `Apple Distribution: … (SXHVCQXJHZ)` identity, expires 2027-08-19 |
| `APPLE_IOS_DIST_P12_PASSWORD` | its passphrase |

[`.github/scripts/asc_signing.py install`](../.github/scripts/asc_signing.py)
imports that into a throwaway keychain, creates an `IOS_APP_STORE` profile per
bundle id against it, installs those profiles into both directories Xcode reads
them from, and writes the two files the build signs with. `cleanup` deletes the
profiles and the keychain and **never touches a certificate**.

Profiles are per-run on purpose: creating them is silent and free, and a fresh
one can never be stale against the certificate or the bundle ids' capabilities.

### Both xcodebuild steps sign manually, and neither may mint anything

The archive is given a generated `.xcconfig`; the export is given a generated
`ExportOptions.plist`. Neither gets `-allowProvisioningUpdates` and neither gets
the API key, so **no step can create a certificate or a profile**, and a signing
setup that has drifted fails at once instead of silently repairing itself.

Two bundle ids need two different profiles, and a build setting passed on the
`xcodebuild` command line applies to every target at once — a single
`PROVISIONING_PROFILE_SPECIFIER=` would give the keyboard extension the app's
profile. The generated xcconfig looks the profile up per target instead:

```
PARLEY_CI_PROFILE_com_pathors_parley_ios          = parley-ci com.pathors.parley.ios
PARLEY_CI_PROFILE_com_pathors_parley_ios_keyboard = parley-ci com.pathors.parley.ios.keyboard

CODE_SIGN_STYLE = Manual
CODE_SIGN_IDENTITY = Apple Distribution
PROVISIONING_PROFILE_SPECIFIER = $(PARLEY_CI_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:identifier))
```

`PRODUCT_BUNDLE_IDENTIFIER` is per-target and `:identifier` rewrites its dots to
underscores, so each target resolves the indirection to its own profile.

It has to be an xcconfig rather than command-line settings for a second reason:
`project.yml` commits `CODE_SIGN_STYLE: Automatic` as a *target* setting — which
is what you want archiving on your own Mac — and a target setting outranks a
command-line one. `xcodebuild -xcconfig` outranks both (`man xcodebuild`: *"will
override all other settings, including settings passed individually on the
command line"*), so CI overrides the developer default without the developer
default being wrong.

### "Created via API" certificates, and the cap

Before that, the archive step ran with `-allowProvisioningUpdates` and the API
key. On every fresh runner Xcode's cloud signing minted a new `DEVELOPMENT`
certificate named **`Created via API`** and left it behind. They accumulate, and
a team may hold only so many at once. On 2026-08-28 the eleventh one filled the
cap and every run started failing at *Archive* with:

```
error: Choose a certificate to revoke. Your account has reached the maximum
       number of certificates.
error: No profiles for 'com.pathors.parley.ios' were found
```

The second line is a consequence of the first, not a separate problem, and
neither mentions the certificate the run itself created.

If this ever recurs, list the team's certificates and revoke the CI-minted
development ones — never the `Apple Distribution` one in `APPLE_IOS_DIST_P12`,
and never the `DEVELOPER_ID_APPLICATION_G2` the desktop app notarizes with:

```bash
# from a machine holding the App Store Connect API key; auth as asc_signing.py does
GET    /v1/certificates?limit=200      # look for certificateType DEVELOPMENT
                                       #   whose displayName is "Created via API"
DELETE /v1/certificates/{id}           # one call per certificate
```

The archive no longer creates them, so the cap should now only move when a human
moves it.

<details>
<summary>How that identity was created, and how to replace it</summary>

The private key was generated on a developer's Mac and has never left it. Only
the CSR travelled — a CSR carries a public key and a subject line and nothing
else — and the certificate that came back is public by construction, so the
whole exchange can happen in a workflow log on a public repository without
leaking anything. Generating the key on a runner and shipping it out as a build
artifact would have published the signing key to anyone who can read the repo.

To replace it (expiry, or a lost key):

```bash
mkdir -p ~/.parley-signing && cd ~/.parley-signing
openssl genrsa -out distribution.key.pem 2048 && chmod 600 distribution.key.pem
openssl req -new -key distribution.key.pem -out distribution.csr.pem \
  -subj "/CN=Parley distribution/O=SXHVCQXJHZ/C=TW"
```

Hand `distribution.csr.pem` to `POST /v1/certificates` with
`certificateType: DISTRIBUTION` — from a machine that has the App Store Connect
API key, which for this repo means a temporary workflow, since the key exists
only as a secret. Save the returned certificate as `distribution.cert.pem`, then:

```bash
PASS="$(openssl rand -base64 24 | tr -d '\n')"
openssl pkcs12 -export -legacy -inkey distribution.key.pem \
  -in distribution.cert.pem -name "Parley distribution" \
  -out distribution.p12 -passout "pass:$PASS"

security import distribution.p12 -k ~/Library/Keychains/login.keychain-db \
  -P "$PASS" -T /usr/bin/codesign          # this Mac can now sign by hand

base64 -i distribution.p12 | tr -d '\n' | \
  gh secret set APPLE_IOS_DIST_P12 --repo pathorsAI/parley
printf '%s' "$PASS" | \
  gh secret set APPLE_IOS_DIST_P12_PASSWORD --repo pathorsAI/parley
```

`-legacy` is not optional. Without it OpenSSL 3 writes PKCS#12 with AES-256 and
PBKDF2, which `security import` cannot read and reports as a bare exit 1.

Apple caps how many distribution certificates a team may hold at once, so
revoke the old one only after the replacement is proven — and note that
revoking invalidates every profile referencing it, including any on a
colleague's machine.
</details>

Exporting **by hand from a Mac** needs none of the CI machinery: Xcode signed in
to the team, or the `security import` above, puts the identity in the local
keychain. That is how 1.0 through 1.3 actually shipped.

**Build numbers.** Every upload needs a `CFBundleVersion` App Store Connect has
not seen. `xcodegen generate` writes `App/Parley/Info.plist` from
`App/project.yml`, so bump it in **`project.yml`** — editing the plist alone is
overwritten on the next generate — and commit the regenerated plist with it.
Both targets carry the number and both must move together. To re-upload without
a commit, run the workflow manually with the `build_number` input.

**Building by hand is still a first-class path**, and it is how 1.0 through 1.3
actually shipped. A Mac with the team's Apple ID signed into Xcode already holds
the distribution identity in its keychain, so none of the certificate machinery
above applies: archive, export, upload. Reach for this whenever CI is in the way
rather than waiting on it.

<details>
<summary>Building and uploading by hand</summary>

Archive and export an `.ipa`, signing through the Xcode account rather than an
API key:

```bash
cd ios/App
xcodegen generate
xcodebuild -project Parley.xcodeproj -scheme Parley -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/Parley.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/Parley.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates
```

`ExportOptions.plist` declares no `destination`, so that second command only
writes `build/export/Parley.ipa` — it does **not** upload, whatever the export
log's talk of App Store Connect suggests. Uploading needs a copy of the plist
with `destination` set to `upload`:

```bash
sed 's|<key>uploadSymbols</key>|<key>destination</key><string>upload</string><key>uploadSymbols</key>|' \
  ExportOptions.plist > /tmp/UploadOptions.plist
xcodebuild -exportArchive -archivePath build/Parley.xcarchive \
  -exportOptionsPlist /tmp/UploadOptions.plist -exportPath build/upload \
  -allowProvisioningUpdates
```

That re-signs and uploads in one step, ending in `Upload succeeded`. The build
then processes in App Store Connect for a few minutes to a few hours before it
can be attached to a version.

Keep `build/Parley.xcarchive` until the release is out. It holds the dSYMs, and
a hand-built upload has no CI run holding them for you.
</details>

## Store metadata

The canonical submission copy, privacy answers, review notes, and screenshots
live in [`AppStore/`](AppStore/README.md), which has the ordered Connect
checklist. Do not duplicate field values here and do not copy reviewer
credentials into the repository.

Two things in that checklist are easy to skip and expensive to skip:

- **English (U.S.) is the primary locale.** It is what every region without its
  own localization sees. Connect restricts when primary language can change, so
  it goes first.
- **Screenshots are per-locale**, `AppStore/screenshots/en-US/` and
  `zh-Hant/`, 1320×2868 (the 6.9-inch slot). Regenerate with
  [`AppStore/capture-screenshots.sh`](AppStore/capture-screenshots.sh) whenever
  the UI moves; it fails rather than shipping a blank or mis-sized frame.

## Before submission

Run on a real device, not only the simulator. Nothing below is covered by the
unit tests.

**Account and recording**

- [ ] Hosted email/password, Google, and Apple sign-in end-to-end.
- [ ] Microphone permission denial, and recovery after granting it in Settings.
- [ ] Background and lock-screen recording survives; a phone call interrupts and
      resumes cleanly.
- [ ] Network dropped mid-recording → the finished recording queues, and
      Settings → Sync retries it successfully.
- [ ] Personal folders, organization share/move, and account deletion.

**Voice keyboard (new in 1.1)**

- [ ] Adding the keyboard in Settings → General → Keyboard, then enabling Full
      Access.
- [ ] **With Full Access off**, the keyboard still shows the explanation and a
      working key row (globe, space, return, delete) — never a dead rectangle.
      This is what guideline 4.4.1 review looks at.
- [ ] Mic button → Parley records → the transcript types into the field you
      started from, in a third-party app (Notes, Messages, Mail).
- [ ] The Action Button intent starts dictation without bringing Parley forward.
- [ ] A session left running stops itself at the 120-second cap.

**Localization**

- [ ] The app in both languages, switched via Settings → Parley → Language: no
      English leaking into the Chinese build, no clipped or wrapped rows.
- [ ] The keyboard's name in the system keyboard list is localized.

**Public surfaces**

- [ ] `https://parley.tw/privacy/` and `https://parley.tw/support/` load over
      HTTPS, and the support page covers iOS in both languages.

**Then**

- [ ] Assign the processed TestFlight build and submit only after the above.
