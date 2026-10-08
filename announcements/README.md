# In-app announcements

The "What's New" sheet each app shows once after an update. One JSON file per
announcement, shared by every platform, so a release's copy is written once:

- **iPhone** bundles the folder as a resource (see `ios/App/project.yml`).
- **Android** copies it into the APK's assets at build time
  (`copyAnnouncementAssets` in `android/app/build.gradle.kts`) and shows it as a
  Material 3 bottom sheet (`android/app/src/main/kotlin/com/pathors/parley/ui/WhatsNewSheet.kt`).
- **Desktop** is meant to read the same files.

## Schema

```jsonc
{
  "id": "2026-10-polish-wave",          // unique, stable; start with the month it ships
  "ships": { "ios": "1.22", "android": null, "desktop": null },
  "audience": "keyboard",               // optional: "all" (default) | "keyboard"
  "hero": "keyboard-wave",              // optional: id in each platform's native hero registry
  "cta": { "ios": null, "android": null }, // optional per-platform deep link
  "copy": {
    "zh-Hant": { "badge": "", "title": "", "body": "", "also": "", "button": "" },
    "en":      { "badge": "", "title": "", "body": "", "also": "", "button": "" }
  }
}
```

- **`ships`** — the version it ships in, per platform. `null` means that
  platform never shows it. An entry can be committed before its release: it
  sits in the bundle doing nothing until the running version reaches it.
  Versions compare numerically by component (`1.9 < 1.10`, `1.22 == 1.22.0`).
- **`audience`** — `keyboard` means "has used the Parley keyboard on this
  device". A value a build does not know counts as unmet, never as everyone.
  On Android that is the voice-typing keyboard: the flag is set the first time
  it is shown (`ParleyInputMethodService.onStartInputView`), and a `keyboard`
  announcement waits until then.
- **`hero`** — looked up in each platform's own registry of native views (iOS:
  `ios/App/Parley/WhatsNewHero.swift`; Android has none yet). Unknown or absent
  draws no hero; the sheet is complete without one.
- **`cta`** — a deep link the button opens after closing the sheet, per
  platform (`ios`, `android`). `null` or absent just closes it. On Android an
  `https` link opens in a Custom Tab and anything else as a view intent.
- **`copy`** — `zh-Hant` and `en` are both required, and every field is
  non-empty. `badge` is the small line above the title, `also` is the one-line
  "also changed" footnote, `button` is the button's label.

## Rules

- **Fresh installs never see one.** Only someone updating from an earlier
  build does; a new install marks every bundled announcement as seen on its
  first launch.
- **One sheet, the newest.** If several are unseen (someone skipped releases),
  only the newest is shown and the older ones are retired with it.
- **Once.** Dismissing the sheet in any way marks it seen.
- **No Bopomofo characters** (U+3100–U+312F, U+31A0–U+31BF) anywhere in the
  copy. This copy is kept in sync with the App Store release notes, and App
  Store Connect's What's New field rejects them with a 409.

`ios/ParleyKit/Tests/ParleyKitTests/AnnouncementCatalogTests.swift` and
`android/parleykit/src/test/kotlin/com/pathors/parley/kit/AnnouncementCatalogTest.kt`
each read every file here and enforce the schema, both languages, and the
Bopomofo rule.
