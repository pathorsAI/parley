# In-app announcements

The "What's New" sheet each app shows once after an update. One JSON file per
announcement, shared by every platform: the iPhone app reads this folder today
(bundled as a resource, see `ios/App/project.yml`), and Android and the desktop
app are meant to read the same files, so a release's copy is written once.

## Schema

```jsonc
{
  "id": "2026-10-polish-wave",          // unique, stable; start with the month it ships
  "ships": { "ios": "1.22", "android": null, "desktop": null },
  "audience": "keyboard",               // optional: "all" (default) | "keyboard"
  "hero": "keyboard-wave",              // optional: id in each platform's native hero registry
  "cta": { "ios": null },               // optional per-platform deep link
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
- **`hero`** — looked up in each platform's own registry of native views (iOS:
  `ios/App/Parley/WhatsNewHero.swift`). Unknown or absent draws no hero; the
  sheet is complete without one.
- **`cta`** — a deep link the button opens instead of just closing the sheet.
  `null` or absent closes it.
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

`ios/ParleyKit/Tests/ParleyKitTests/AnnouncementCatalogTests.swift` reads every
file here and enforces the schema, both languages, and the Bopomofo rule.
