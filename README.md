# Parley

<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Parley Logo" width="80" height="80" />
</p>

<p align="center">
  <strong>A local-first AI coach for sales &amp; negotiation — a real-time copilot during the call, and deep retro, analysis &amp; opponent war-gaming after.</strong>
</p>

<p align="center">
  <a href="https://github.com/pathorsAI/parley/actions/workflows/release.yml"><img src="https://github.com/pathorsAI/parley/actions/workflows/release.yml/badge.svg" alt="Release Status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/built%20with-Tauri-blue.svg?style=flat&logo=tauri" alt="Tauri"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="Platform: macOS">
</p>

Parley is a native, local-first **AI coach for high-stakes conversations** — built first for **sales calls and negotiations**, though it works just as well for interviews, diligence calls, or any conversation you want to walk into prepared and walk out of having learned from. It's for the person in the seat: a rep, a founder, anyone closing a deal.

It runs in two complementary modes:

- **Live — during the call.** Captures your mic and the other party's audio, transcribes with speaker labels in real time, and runs your evaluation playbooks plus a grounded Q&A sidebar — so you get insight in the moment without losing the thread.
- **Retro — after the call.** Upload a recording and replay it: scrub to any moment and re-run the analysis *as of that point*, see a time-anchored timeline of what happened, war-game the other side's arguments, and get a candid debrief on what to do better next time.

> [!WARNING]
> **macOS only (for now).** Parley relies on a Core Audio process tap for system-audio capture. The underlying audio pipeline is abstracted behind an `AudioSource` trait, making other platforms theoretically possible, but only macOS is officially supported today.

---

## Table of Contents

- [Features](#-features)
- [Privacy & Data Flow](#-privacy--data-flow)
- [Installation](#-installation)
  - [Install](#install)
  - [Build from source](#build-from-source)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎯 Features

### 🎙️ Live — during the call

- **Dual-source capture** — both your mic and the other party's system audio, tagged `me` / `them`.
- **Real-time transcription** — live, diarized transcription with editable speaker names.
- **Evaluation playbooks** — AI cards that watch for negotiation risk, sales qualification gaps, red flags, unanswered questions, or your own rubric — auto-rerun as the call unfolds.
- **Live Q&A** — ask the transcript questions and get grounded, streamed answers.
- **Auto-checked agenda** — checklist items tick off as the AI detects they're covered.

### 🔁 Retro — after the call

- **Upload &amp; replay a recording** — batch-transcribe a recorded call, then play it back with a draggable timeline.
- **Scrub &amp; re-evaluate at any moment** — the transcript is masked to the playhead, so you can simulate *"what should I have done right here?"* and re-run the analysis as of that point.
- **Time-anchored retro timeline** — markers across the recording for the other side's moves and your own missed moments; click to jump.
- **Opponent war-gaming** — auto-detect the other party's key arguments, surface the premise you shouldn't concede, and get multiple response angles with their predicted reactions — then war-game a branch on demand.
- **Post-call debrief** — outcome, what fell short, how to improve, and key-moment counterfactuals.
- **LLM speaker re-attribution** — re-tag who said each line by conversational context when audio diarization gets it wrong.

### 🧩 Yours, and private

- **Bring your own providers** — pick your transcription vendor and LLM (Claude, OpenAI, Gemini, Groq, Ollama, OpenRouter, and more).
- **Local-first** — audio and transcripts go straight to the providers you configure; no Pathors AI proxy in between.
- **Built-in MCP server** — connect Claude (or any MCP client) to the live meeting while the app is open: read the transcript, manage agenda TODOs, and read/add/overwrite/edit the timeline analysis, plus manage evaluation/agenda templates.
- **Voice typing** — system-wide push-to-talk dictation in any app: hold your key, speak, release, and the text auto-pastes where your cursor is (see [Voice Typing](#-voice-typing)).
- **Traditional Chinese** — on-the-fly conversion of transcribed text.
- **Native macOS UI** — clean, custom window chrome.

---

## 🔒 Privacy & Data Flow

Conversation content is sensitive. Parley runs straight from your machine:
* **Direct connections** — Audio and transcripts go straight to the providers you configure — no Pathors AI proxy in between.
* **Local storage** — Transcripts and templates stay in your local app directory.
* **No telemetry** — Nothing tracked, collected, or uploaded.

---

## 📥 Installation

### Install

Download the latest Universal macOS build from the [**Releases page**](https://github.com/pathorsAI/parley/releases/latest), open the `.dmg`, and drag **Parley** into your Applications folder.

Parley is currently unsigned, so on first launch macOS Gatekeeper may block it. Right-click the app and choose **Open**, then confirm. Paste your API keys in the **Settings** panel inside the app.

### Build from source

**Prerequisites**

- **Rust** (stable toolchain) — for the Tauri backend
- **Bun** (or Node.js) — for building the frontend
- A **transcription provider** API key (e.g. Soniox, Deepgram, AssemblyAI) — for transcription (live and uploaded recordings)
- An **LLM provider** API key (Anthropic, OpenAI, OpenRouter, …) — for evaluations, Q&A, retro analysis, and war-gaming

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/pathorsAI/parley.git
   cd parley
   bun install
   ```

2. Run the application in development mode:
   ```bash
   bun run tauri dev
   ```

3. Paste your API keys in the **Settings** panel inside the app on first launch.

---


## 🎙️ Voice Typing

Beyond meetings, Parley doubles as a **system-wide push-to-talk dictation tool** that works in any app. It doesn't use macOS Dictation — it runs its own microphone capture and realtime STT pipeline, so the output uses whichever transcription provider you configured in Settings.

Hold your push-to-talk key anywhere, speak, and release to transcribe. On release, Parley copies the text to the clipboard and auto-pastes it into the frontmost app (clipboard stays the fallback when Accessibility isn't granted).

Pick the trigger in **Settings → Voice typing**:

- **`Option+Space`** — the default; needs no extra permission.
- **Any recorded combo** — click the recorder and press the shortcut you want (e.g. `⌃⌥Space`, `⌘⇧D`, or an F-key). Also permission-free.
- **A single hold-to-talk key** — `fn`/Globe or a right-side `⌘`/`⌥`/`⌃`. These need Input Monitoring (grant it, then relaunch).

Auto-paste needs Accessibility; Parley requests it when you enable voice typing.

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to report bugs, suggest features, and submit pull requests.

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Pathors AI.
