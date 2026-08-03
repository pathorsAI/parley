# Contributing to Parley

Thank you for your interest in contributing to Parley! We welcome community contributions to help improve the project.

## Language

**English is the working language of this repository.** Issues, pull requests, commit messages, code comments, and release notes are all written in English so that anyone can read the history and join in.

This applies to the repository only. The application itself ships in both Traditional Chinese and English — see `src/i18n/messages.ts`, where every user-facing string must have a `zh-TW` and an `en` entry. Never hard-code display text in a component.

## How to Contribute

### Reporting Bugs
* Search existing issues to see if the bug has already been reported.
* If not, open a new issue. Include details about your macOS version, Tauri app version, and steps to reproduce the bug.

### Suggesting Enhancements
* Open an issue explaining the feature you would like to see and why it would be useful.

### Submitting Pull Requests
1. Fork the repository and create your branch from `main`.
2. Ensure the project builds and runs locally (`bun run tauri dev`).
3. Check your work: `bunx tsc --noEmit` and `bunx vitest run` must both pass.
4. Commit your changes with clear, descriptive commit messages.
5. Submit your pull request.

### Commit messages

Prefix the subject with the kind of change, then say what changed in plain English:

```
[fix] LevelMeter leaked a listener when cleanup beat listen() resolving
[feature] link a recording to a company after the fact
[refactor] scenario becomes per-meeting state instead of a global setting
[chore] bump onnxruntime to 1.20
[docs] document the release process
```

Use `[fix]`, `[feature]`, `[refactor]`, `[chore]`, or `[docs]`. Explain *why* in the body when the reason isn't obvious from the diff.

### A note on bounties

We don't pay bounties, per-fix donations, or pay-on-merge arrangements, and we won't merge pull requests that attach payment terms. Contributions are welcome on the usual volunteer terms.

## Local Development

See the setup instructions in the main [README.md](README.md).
