# Parley iOS App Store submission packet

This folder is the version-controlled source for the App Store Connect entry.
It does **not** contain reviewer credentials or screenshots of real meeting
content. Enter the supplied copy in App Store Connect, then keep the Connect
record in sync whenever product data practices change.

## Submission order

1. In **Distribution**, create iOS version `1.0` and select build `1.0 (3)`
   after it finishes processing.
2. Apply [`metadata/zh-Hant.md`](metadata/zh-Hant.md) to the primary locale.
3. Apply [`privacy-label.md`](privacy-label.md) in **App Privacy**, including
   the privacy-policy URL. Publish the label before submission.
4. Add a non-expiring reviewer account to App Review Information. Store its
   credentials in the approved secret manager, never this repository.
5. Follow [`review-notes.md`](review-notes.md), then capture and upload the
   five real-app frames in [`screenshots/README.md`](screenshots/README.md).
6. Re-run the device test list in `ios/RELEASING.md`, select the build, and
   submit only when every state is verified.

## Why this is a packet, not an automation

App Store Connect fields and reviewer credentials are external state. The copy
is maintained here for reviewability; the final save/publish action stays in
App Store Connect so the team can verify the rendered product page and data
label before it becomes public.
