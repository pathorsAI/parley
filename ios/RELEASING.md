# Parley iOS — release checklist

Parley iOS is the cloud companion for face-to-face meetings. It records the
phone microphone, streams it through the hosted Parley relay, and syncs the
Ogg recording plus transcript to the same account as the desktop app. It does
not capture phone calls or other apps' audio.

## Release build

Prerequisites already configured for the Pathors Apple team (`SXHVCQXJHZ`):

- Bundle ID: `com.pathors.parley.ios`
- App Store Connect app: `Parley` (`6795031201`)
- Sign in with Apple capability and hosted Better Auth Apple provider
- Hosted login page: `https://api.parley.tw/sign-in`

Each upload needs a new build number. Update `CFBundleVersion` in
`App/Parley/Info.plist`, then generate and archive:

```bash
cd ios/App
xcodegen generate
xcodebuild -project Parley.xcodeproj -scheme Parley \
  -destination 'generic/platform=iOS' \
  -archivePath build/Parley.xcarchive archive
xcodebuild -exportArchive -archivePath build/Parley.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates
```

With an Xcode account signed in, the export uploads directly to App Store
Connect. CI should use an App Store Connect API key with
`-authenticationKeyPath`, `-authenticationKeyID`, and
`-authenticationKeyIssuerID` instead of a GUI account.

## Store metadata

The canonical submission copy, privacy answers, review notes, and screenshot
brief live in [`AppStore/`](AppStore/README.md). Keep this checklist concise;
do not copy reviewer credentials into the repository.

- **Support URL:** `https://parley.tw/support/`
- **Privacy Policy URL:** `https://parley.tw/privacy/`
- **Copyright:** `© 2026 Pathors AI`
- **Screenshots:** upload 1–10 iPhone 6.5-inch PNG/JPEG screenshots without
  alpha. Use an actual app session that shows live transcription, recording
  library, and settings; do not use mocked desktop UI.
- **App Privacy:** declare contact info (email), user content (audio recordings
  and transcripts), and identifiers/account data. Mark the information as used
  for app functionality; do not mark it as used for tracking.

## Review notes

Provide a working review account on the hosted email/password sign-in page and
include this note:

> Parley is a microphone-based, in-person meeting recorder. It does not record
> phone calls or other app audio. The microphone starts only after the user taps
> Start Recording and confirms they have consent from participants. Audio is
> sent to the signed-in account's hosted transcription relay, and the completed
> recording plus transcript sync to that account. Account deletion is available
> in Settings → Account.

## Before submission

- [ ] Test hosted email/password, Google, and Apple login end-to-end on device.
- [ ] Test microphone permission denial, background/lock-screen recording, an
      interrupted network, and later queued-upload retry.
- [ ] Verify personal folders, organization share/move, and account deletion.
- [ ] Confirm the public privacy and support URLs load over HTTPS.
- [ ] Assign the processed TestFlight build and submit only after the above.
