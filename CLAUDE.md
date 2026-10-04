# Parley — repository conventions

Parley is a public, Apache-2.0 desktop app for macOS and Windows (Tauri 2 + React 19 + TypeScript). Anyone should be able to read the history and contribute, so the repository is kept in one language regardless of who — or what — is writing.

## Write English in the repository

**Everything that lands in the repo or on GitHub is written in English:**

- commit messages
- pull request titles, descriptions, and review comments
- issue titles and bodies
- code comments and identifiers
- release notes (`.github/release-notes/*.md`) and anything published to the Releases page
- documentation (`README.md`, `CONTRIBUTING.md`, `docs/**`)

This holds even when the conversation that produced the change happened in another language — translate on the way in. A contributor who lands on issue #42 should not need a translator to pick it up.

## The app itself is bilingual

Repository English does *not* mean an English-only product. Every user-facing string lives in `src/i18n/messages.ts` and **must** have both a `zh-TW` and an `en` entry — the Traditional Chinese entry is first-class, not a translation afterthought. Never hard-code display text in a component, including in the secondary windows (settings, voice-typing, finding-solution, diagnostics).

The app defaults to `zh-TW`. Page titles and the language switcher itself are translated too.

## Commit messages

Prefix with the kind of change, then say what changed:

```
[fix] LevelMeter leaked a listener when cleanup beat listen() resolving
[feature] link a recording to a company after the fact
[refactor] scenario becomes per-meeting state instead of a global setting
```

Use `[fix]`, `[feature]`, `[refactor]`, `[chore]`, or `[docs]`. Explain *why* in the body when the diff doesn't make it obvious.

## Before opening a PR

`bunx tsc --noEmit` and `bunx vitest run` must both pass. Add an i18n key to both dictionaries whenever you add user-facing text.

## Every release has release notes

A release with an empty body is not done. Whoever cuts the tag writes the notes, in the same change that bumps the version:

| Release | Tag | Notes go in |
|---|---|---|
| Desktop | `v*.*.*` | `.github/release-notes/v<version>.md` — `bun run release … --message` / `--notes-file` writes it |
| Android | `android-v*` | `.github/release-notes/android-v<version>.md` for GitHub, **and** `android/play/whatsnew/` for Play |
| iOS | `ios-v*` | `## What's New — <version>` in `ios/AppStore/metadata/en-US.md` and `zh-Hant.md` (the store submission refuses to run without it); no GitHub release is made |

Say what a user notices first, then what changed underneath. A list of PR titles is not release notes, and neither is "Release v1.2.3". Both release workflows fail before building when the notes are missing or blank, so an empty release now costs a failed run rather than a silent gap on the Releases page.
