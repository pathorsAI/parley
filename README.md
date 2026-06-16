# Parley

<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Parley Logo" width="80" height="80" />
</p>

<p align="center">
  <strong>A native, local-first meeting copilot for real-time transcription, Q&A, and auto-checklists.</strong>
</p>

<p align="center">
  <a href="https://github.com/pathorsAI/parley/actions/workflows/release.yml"><img src="https://github.com/pathorsAI/parley/actions/workflows/release.yml/badge.svg" alt="Release Status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/built%20with-Tauri-blue.svg?style=flat&logo=tauri" alt="Tauri"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="Platform: macOS">
</p>

Parley is a native, real-time meeting copilot designed for interviews, negotiations, and discussions. It captures audio from both your microphone (you) and your system output (the other party), transcribes the conversation live with speaker diarization, and runs customizable AI evaluation checklists and a live Q&A sidebar—helping you stay focused on the conversation while getting instant insights in the background.

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

- **Dual-source capture** — Both your mic and system audio, tagged `me` / `them`.
- **Real-time transcription** — Live, diarized transcription with editable speaker names.
- **Bring your own providers** — Pick your transcription vendor and LLM (Claude, OpenAI, Gemini, Groq, Ollama, OpenRouter, and more).
- **Live Q&A** — Ask the transcript questions and get grounded, streamed answers.
- **Configurable playbooks** — Evaluation cards for negotiation risk, sales qualification, follow-ups, or your own rubric.
- **Auto-check TODOs** — Agenda items check off as the AI detects they're addressed.
- **Built-in MCP server** — Manage templates from external MCP clients while the app is open.
- **Traditional Chinese** — On-the-fly conversion of transcribed text.
- **Native macOS UI** — Clean, custom window chrome.

---

## 🔒 Privacy & Data Flow

Meeting content is sensitive. Parley runs straight from your machine:
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
- A **transcription provider** API key (e.g. Soniox, Deepgram, AssemblyAI) — for live transcription
- An **LLM provider** API key (Anthropic, OpenAI, OpenRouter, …) — for evaluations and Q&A

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

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to report bugs, suggest features, and submit pull requests.

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Pathors AI.
