# Parley

Parley is a native realtime meeting copilot for interviews and negotiations. It listens to both your microphone (you) and your system audio (the other party), transcribes the conversation live with speaker diarization, and runs configurable AI evaluations and a live Q&A sidebar so you can see what matters in the moment — what hasn't been answered, what's been missed, and how the conversation is going — without breaking your focus.

> ⚠️ **macOS only (for now).** Parley relies on Core Audio for system-audio capture. The audio layer sits behind an `AudioSource` trait, so other platforms are possible, but only macOS is supported today.

## Features

- **Dual-source capture** — captures your microphone and system audio simultaneously, so every line is tagged as `me` or `them`.
- **Soniox realtime transcription** — low-latency streaming transcription with speaker diarization and editable speaker names.
- **Switchable AI provider** — analysis runs through either Anthropic Claude or OpenRouter; pick whichever you prefer in Settings.
- **Live Q&A sidebar** — ask questions about the ongoing conversation and get streamed answers grounded in the live transcript.
- **Configurable evaluations** — preset and custom evaluation cards that surface insights about the conversation, with automatic or manual rerun.
- **TODO checklist with AI auto-check** — track what you want to cover; items get checked off automatically as the AI detects they've been addressed.
- **Built-in MCP endpoint** — when the app is open, Parley exposes a local HTTP MCP endpoint for managing evaluation and TODO templates from external MCP clients.
- **Traditional Chinese conversion** — on-the-fly conversion of transcribed text to Traditional Chinese.
- **Custom titlebar** — a clean, native-feeling custom window chrome.

## Tech stack

- **Shell:** Tauri v2 (Rust) + React 19 + Vite + TypeScript + Tailwind v4
- **Transcription:** Soniox realtime websocket (two sessions — mic + system audio)
- **Audio capture (macOS):** Core Audio process tap for system output, `cpal` for the microphone (behind an `AudioSource` trait)
- **AI:** Vercel AI SDK with a switchable provider (Anthropic Claude / OpenRouter)
- **State:** Zustand

## Prerequisites

- **Rust** (stable toolchain) — for the Tauri backend
- **Bun** (or Node.js) — for the frontend toolchain
- A **Soniox API key** — for realtime transcription
- An **Anthropic** or **OpenRouter** API key — for AI analysis

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the platform tooling you'll need.

## Setup & run

```bash
bun install
bun run tauri dev      # runs Vite + the Tauri shell
```

## Release

Releases are built by GitHub Actions when a `vX.Y.Z` tag is pushed. The workflow builds the macOS Tauri bundle and uploads the installer assets to a GitHub Release.

From a clean worktree:

```bash
bun run release patch --message "Describe what changed in this release"
```

You can also pass an explicit version or a notes file:

```bash
bun run release 0.2.0 --notes-file ./release-notes.md
```

The script updates `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, writes `.github/release-notes/vX.Y.Z.md`, commits those changes, creates the tag, and pushes the branch and tag.

## MCP

Parley starts its template MCP service inside the desktop app. Open Parley, then connect an HTTP-capable MCP client to the endpoint shown in **Settings → MCP Server**. The default endpoint is:

```text
http://127.0.0.1:3011/mcp
```

The endpoint reads and writes the same `templates.json` file used by the app, so evaluation and TODO templates stay synchronized.

## Configuration

API keys are entered in the in-app **Settings** window — there's no need to set anything up before first launch. Open Settings, paste your Soniox key and your Anthropic or OpenRouter key, and choose your AI provider.

For development you can optionally provide default keys via `VITE_*` environment variables; see [`.env.example`](.env.example). Note that Vite inlines `VITE_*` values into the frontend bundle, so never put a production secret there.

## Project layout

```
src/                  React frontend
  components/          UI (TitleBar, MeetingView, sidebar: Ask + Evaluations + Todos)
  lib/                 store (zustand), types, evaluation presets, AI layer
src-tauri/            Rust backend
  src/audio/           mic + system-audio capture (AudioSource trait)
  src/transcription/   Soniox realtime client
```

## Acknowledgements

Built with [Claude Code](https://claude.com/claude-code).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Pathors AI.
