import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import type { HistoryEntry } from "../history/types";
import type { LocalSttHardware, LocalSttModel } from "../transcription/localModels";
import type { McpServerInfo } from "../mcp/connect";
import type { McpActivityInfo } from "../mcp/activity";
import type { DiarizeModelStatus } from "../speakers/diarize";
import type { HitRect } from "../voiceTyping/hitRegions";

/**
 * The Tauri command contract, written once: one typed function per command
 * the frontend calls, named after the command (`stop_meeting` →
 * `stopMeeting`). Each takes exactly the argument object the command's Rust
 * signature reads (Tauri maps camelCase keys to its snake_case parameters) and
 * resolves to what it returns. Nothing outside src/lib/ipc calls `invoke`
 * directly (enforced by ipc/boundary.test.ts); call sites read
 * `ipc.stopMeeting()`.
 *
 * The functions pass their arguments through untouched — same object, same
 * arity (a command without arguments is invoked without any) — so the wire
 * payload is exactly what the call site built. Rust signatures live in
 * src-tauri/src/*.rs (`#[tauri::command]`); a `Result<T, String>` rejects with
 * the error string.
 */

// ── Shapes the commands exchange (serde camelCase unless noted) ─────────────

/** `check_permissions` (permissions.rs `Permissions`). */
export interface Permissions {
  /** macOS AVAuthorizationStatus-style: "authorized" | "denied" | "notDetermined" | … */
  microphone: string;
  /** unknown | granted | denied | unsupported (macOS < 14.2). Windows reports
   *  granted when there is a default output device to loop back, else unknown. */
  systemAudio: string;
}

/** `app_identity` (permissions.rs `AppIdentity`). */
export interface AppIdentity {
  bundleIdentifier: string;
  executablePath: string;
  runningFromAppBundle: boolean;
  likelyDevBinary: boolean;
}

/** `set_voice_typing_shortcut` / `voice_typing_hotkey_status` (hotkey.rs). */
export interface HotkeyStatus {
  authorized: boolean;
  active: boolean;
  shortcut: string;
  /** How the trigger is wired: "combo" (OS global shortcut) | "tap-active"
   *  (HID tap, can swallow the key) | "tap-listen" (HID tap can only observe
   *  the key — matters for fn, whose native 🌐 action still fires) | "hook"
   *  (Windows low-level keyboard hook, observes only) | "none". */
  mode: string;
}

/** `insert_text` (voice_typing.rs `PasteResult`). */
export interface PasteResult {
  /** False when the text was left on the clipboard instead of pasted. */
  pasted: boolean;
  /** The text is still on the clipboard: the default, and what any insert
   *  whose clipboard restore could not be set up leaves behind. */
  copied: boolean;
  /** The app frontmost at paste time (macOS bundle id, Windows exe name). */
  appBundleId: string | null;
}

/** `clear_cache` kind (cache.rs `CacheKind`, lowercase). */
export type CacheKind = "transcription" | "diarization" | "analysis" | "all";

/** `cache_sizes` (cache.rs `CacheSizes`), bytes on disk. */
export interface CacheSizes {
  transcription: number;
  diarization: number;
  playback: number;
}

/** `read_history_entry` (history.rs `HistoryRead`). */
export interface HistoryReadResult {
  meta: HistoryEntry;
  audioPath: string | null;
}

/** `read_transcript_file` (history.rs `TranscriptFile`). */
export interface TranscriptFile {
  text: string;
  modifiedMs: number | null;
}

/** One segment `transcribe_file` returns (replay.rs `ReplaySegment`). */
export interface TranscribedSegment {
  id: string;
  speaker: number;
  text: string;
  startMs: number;
  endMs: number;
}

/** `transcribe_file` (replay.rs `TranscriptionResult`). */
export interface TranscriptionResult {
  segments: TranscribedSegment[];
  durationMs: number;
  /** True when served from the on-disk cache (no provider call → don't bill it). */
  cached: boolean;
  /** Acoustically measured articulation rate (syllables/sec); 0 if unmeasurable. */
  speechRateHz: number;
}

/** A segment span `diarize_audio` slices (diarize.rs `SegSpan`). */
export interface SegSpan {
  id: string;
  startMs: number;
  endMs: number;
}

/** One segment's speaker assignment from `diarize_audio` (diarize.rs `SegSpeaker`). */
export interface SegSpeaker {
  id: string;
  /** 1-based speaker number (cluster + 1). */
  speaker: number;
  /** Cosine margin to the next-nearest cluster; 0 for inherited short segments. */
  confidence: number;
}

/** `set_tray_labels` (tray.rs `TrayLabels`). */
export interface TrayLabels {
  open: string;
  startVoiceTyping: string;
  stopVoiceTyping: string;
  quit: string;
}

// ── Meeting capture (commands.rs) ───────────────────────────────────────────

export const startMeeting = (args: {
  provider: string;
  apiKey: string;
  diarization?: boolean;
  inputDevice?: string | null;
  relayUrl?: string | null;
  model?: string | null;
  languageHints?: string[] | null;
  vocabulary?: string[] | null;
  /** This meeting's id (store.liveMeetingId): its history entry's id and its
   *  crash journal's name. Echoed on `meeting://recording-*`. */
  meetingId?: string | null;
}) => invoke<void>("start_meeting", args);
/** `keepMs` cuts the saved recording to its first `keepMs` (the silence
 *  guard's trailing-silence trim); omitted, the whole recording is kept. */
export const stopMeeting = (args: { keepMs?: number | null } = {}) => invoke<void>("stop_meeting", args);
export const cancelMeeting = () => invoke<void>("cancel_meeting");
export const setMeetingPaused = (args: { paused: boolean }) => invoke<void>("set_meeting_paused", args);
export const meetingActive = () => invoke<boolean>("meeting_active");
/** The meeting the backend is recording right now, or null. */
export interface BackendMeeting {
  meetingId: string;
  startedAtMs: number;
}
export const activeMeeting = () => invoke<BackendMeeting | null>("active_meeting");
/** The meeting's entry is saved (or deliberately not kept): drop its crash journal. */
export const finishMeetingJournal = (args: { meetingId: string }) => invoke<void>("finish_meeting_journal", args);
/** A crashed meeting's journal, repaired into a temp recording to save. */
export interface RecoveredRecording {
  meetingId: string;
  path: string;
  durationMs: number;
  startedAtMs: number;
}
export const recoverMeetingJournals = () => invoke<RecoveredRecording[]>("recover_meeting_journals");
export const discardRecording = (args: { path: string }) => invoke<void>("discard_recording", args);
export const exportRecording = (args: { src: string; dst: string }) => invoke<void>("export_recording", args);
export const listInputDevices = () => invoke<string[]>("list_input_devices");
export const startMicTest = (args: { inputDevice?: string | null }) => invoke<void>("start_mic_test", args);
export const stopMicTest = () => invoke<void>("stop_mic_test");
/** One Claude Code memory file (ai_memory.rs): `label` is "global" or the project folder. */
export interface MemoryFile {
  label: string;
  text: string;
}
export const readClaudeMemory = () => invoke<MemoryFile[]>("read_claude_memory");

// ── Uploaded recordings & playback (replay.rs, playback.rs) ─────────────────

export const transcribeFile = (args: {
  path: string;
  provider: string;
  apiKey: string;
  model?: string | null;
  languageHints: string[];
  vocabulary?: string[] | null;
  diarization: boolean;
  batchUrl?: string | null;
}) => invoke<TranscriptionResult>("transcribe_file", args);
export const measureAudioSpeechRate = (args: { path: string }) => invoke<number>("measure_audio_speech_rate", args);
export const preparePlaybackFallback = (args: { audioPath: string }) =>
  invoke<string>("prepare_playback_fallback", args);

// ── On-device transcription (local_stt.rs) ──────────────────────────────────

export const localSttModels = () => invoke<LocalSttModel[]>("local_stt_models");
export const localSttHardware = () => invoke<LocalSttHardware>("local_stt_hardware");
export const localSttDownload = (args: { modelId: string }) => invoke<void>("local_stt_download", args);
export const localSttCancel = (args: { modelId: string }) => invoke<void>("local_stt_cancel", args);
export const localSttDelete = (args: { modelId: string }) => invoke<void>("local_stt_delete", args);

// ── Speaker diarization (diarize.rs) ────────────────────────────────────────

export const diarizeAudio = (args: { audioPath: string; segments: SegSpan[]; numSpeakers?: number | null }) =>
  invoke<SegSpeaker[]>("diarize_audio", args);
export const diarizeModelStatus = () => invoke<DiarizeModelStatus>("diarize_model_status");
export const downloadDiarizeModel = () => invoke<void>("download_diarize_model");

// ── History store (history.rs) ──────────────────────────────────────────────

export const listHistory = () => invoke<string[]>("list_history");
export const readHistoryEntry = (args: { id: string }) => invoke<HistoryReadResult>("read_history_entry", args);
export const saveHistoryEntry = (args: {
  id: string;
  summaryJson: string;
  metaJson: string;
  audioSourcePath?: string | null;
  compress: boolean;
}) => invoke<string>("save_history_entry", args);
export const saveRemoteHistoryEntry = (args: {
  id: string;
  summaryJson: string;
  metaJson: string;
  audioUrl?: string | null;
  token?: string | null;
}) => invoke<string>("save_remote_history_entry", args);
export const renameHistoryEntry = (args: { id: string; title: string }) => invoke<void>("rename_history_entry", args);
export const deleteHistoryEntry = (args: { id: string }) => invoke<void>("delete_history_entry", args);
export const downloadRemoteAudio = (args: { id: string; url: string; token: string }) =>
  invoke<string>("download_remote_audio", args);
export const readTranscriptFile = (args: { path: string }) => invoke<TranscriptFile>("read_transcript_file", args);
/** Raw audio body; the entry id travels in the `x-entry-id` header. */
export const writeSampleAudio = (body: InvokeArgs, options: InvokeOptions) =>
  invoke<void>("write_sample_audio", body, options);

// ── App-data JSON files (commands.rs) ───────────────────────────────────────

export const readDictionary = () => invoke<string>("read_dictionary");
export const writeDictionary = (args: { contents: string }) => invoke<void>("write_dictionary", args);
export const readFolders = () => invoke<string>("read_folders");
export const writeFolders = (args: { json: string }) => invoke<void>("write_folders", args);
export const readTemplates = () => invoke<string>("read_templates");
export const writeTemplates = (args: { json: string }) => invoke<void>("write_templates", args);
export const getTemplatesPath = () => invoke<string>("get_templates_path");
export const writeSession = (args: { json: string }) => invoke<void>("write_session", args);
export const readSessionCommands = () => invoke<string>("read_session_commands");
export const appendSessionCommandResult = (args: { json: string }) =>
  invoke<void>("append_session_command_result", args);
export const readLogTail = (args: { maxBytes: number }) => invoke<string>("read_log_tail", args);
export const startOauthLoopback = () => invoke<number>("start_oauth_loopback");

// ── Usage log (usage.rs) ────────────────────────────────────────────────────

export const appendUsageEvent = (args: { line: string }) => invoke<void>("append_usage_event", args);
export const readUsageEvents = () => invoke<string>("read_usage_events");

// ── Caches (cache.rs) ───────────────────────────────────────────────────────

export const cacheSizes = () => invoke<CacheSizes>("cache_sizes");
export const clearCache = (args: { kind: CacheKind }) => invoke<void>("clear_cache", args);

// ── MCP server (mcp.rs) ─────────────────────────────────────────────────────

export const getMcpServerInfo = () => invoke<McpServerInfo>("get_mcp_server_info");
export const getMcpActivity = () => invoke<McpActivityInfo>("get_mcp_activity");

// ── Voice typing (voice_typing.rs, hotkey.rs, ax_observe.rs) ────────────────

export const startVoiceTyping = (args: {
  provider: string;
  apiKey: string;
  languageHints?: string[] | null;
  vocabulary?: string[] | null;
  inputDevice?: string | null;
  relayUrl?: string | null;
  model?: string | null;
  maxDurationSecs?: number | null;
}) => invoke<void>("start_voice_typing", args);
export const stopVoiceTyping = (args: { tail?: boolean | null }) => invoke<void>("stop_voice_typing", args);
export const insertText = (args: { text: string; restoreClipboard: boolean }) =>
  invoke<PasteResult>("insert_text", args);
export const copyToClipboard = (args: { text: string }) => invoke<void>("copy_to_clipboard", args);
export const observePastedField = (args: { insertedText: string }) => invoke<boolean>("observe_pasted_field", args);
export const presentVoiceOverlay = () => invoke<void>("present_voice_overlay");
export const dismissVoiceOverlay = () => invoke<void>("dismiss_voice_overlay");
export const setVoiceOverlayHitRects = (args: { rects: HitRect[]; page: number; seq: number }) =>
  invoke<void>("set_voice_overlay_hit_rects", args);
export const setVoiceTypingShortcut = (args: { shortcut: string }) =>
  invoke<HotkeyStatus>("set_voice_typing_shortcut", args);
export const voiceTypingHotkeyStatus = () => invoke<HotkeyStatus>("voice_typing_hotkey_status");
export const setVoiceTypingCancelArmed = (args: { armed: boolean }) =>
  invoke<void>("set_voice_typing_cancel_armed", args);
export const ensureFnListener = () => invoke<boolean>("ensure_fn_listener");
export const requestInputMonitoring = () => invoke<boolean>("request_input_monitoring");
export const accessibilityStatus = (args: { prompt: boolean }) => invoke<boolean>("accessibility_status", args);
export const appendVoiceHistory = (args: { line: string }) => invoke<void>("append_voice_history", args);
export const readVoiceHistory = () => invoke<string>("read_voice_history");
export const writeVoiceHistory = (args: { content: string }) => invoke<void>("write_voice_history", args);

// ── OS permissions (permissions.rs) ─────────────────────────────────────────

export const checkPermissions = () => invoke<Permissions>("check_permissions");
export const requestMicrophone = () => invoke<void>("request_microphone");
export const probeSystemAudio = () => invoke<string>("probe_system_audio");
/** pane: "microphone" | "system-audio" | "input-monitoring" | "accessibility" | "keyboard" */
export const openPrivacySettings = (args: { pane: string }) => invoke<void>("open_privacy_settings", args);
export const appIdentity = () => invoke<AppIdentity>("app_identity");

// ── Tray & launch at login (tray.rs, autostart.rs) ──────────────────────────

export const setTrayLabels = (args: { labels: TrayLabels }) => invoke<void>("set_tray_labels", args);
export const trayActive = () => invoke<boolean>("tray_active");
export const launchAtLoginStatus = () => invoke<boolean>("launch_at_login_status");
export const setLaunchAtLogin = (args: { enabled: boolean }) => invoke<boolean>("set_launch_at_login", args);
export const markShowOnNextLaunch = () => invoke<void>("mark_show_on_next_launch");
export const clearShowOnNextLaunch = () => invoke<void>("clear_show_on_next_launch");
