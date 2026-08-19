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
workflow notarizes with.

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
read at all. The actual cause is that **the team holds no iOS Distribution
certificate** — only two `DEVELOPMENT` certificates and the macOS
`DEVELOPER_ID_APPLICATION_G2` the desktop app notarizes with — and no
provisioning profiles.

So [`.github/scripts/asc_signing.py`](../.github/scripts/asc_signing.py) mints
one per run: private key and CSR on the runner, an Apple Distribution
certificate and two `IOS_APP_STORE` profiles from the App Store Connect API,
installed into a throwaway keychain. An `always()` step revokes the certificate
and deletes the profiles afterwards, because the private key dies with the
runner and a certificate nobody can use still counts against Apple's per-team
cap. It only ever deletes ids it recorded itself, so a certificate a human
created is never touched.

Exporting **by hand from a Mac** needs none of this: Xcode signed in to the team
has the identity in its own keychain, which is why releases up to 1.2 were made
that way and never hit this.

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
