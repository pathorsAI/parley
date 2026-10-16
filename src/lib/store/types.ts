// Shared types of the one Parley store. The store is ONE zustand store (see
// ../store.ts) assembled from slice creators (one file per concern in this
// folder); `ParleyState` is the union of every slice, so a slice's actions can
// read and write any field the way the single object always could.

import type { LibraryNode } from "../library/scope";
import type { NavSlice } from "./nav";
import type { ReplaySlice } from "./replay";
import type { IngestSlice } from "./ingest";
import type { StudySlice } from "./study";
import type { MeetingSlice } from "./meeting";
import type { SegmentsSlice } from "./segments";
import type { CoachingSlice } from "./coaching";
import type { PrepSlice } from "./prep";
import type { SettingsSlice } from "./settings";
import type { AuthSlice } from "./auth";
import type { SpeakersSlice } from "./speakers";

/**
 * Which top-level screen is active. Since #195 these are ROUTES under a
 * persistent shell, not modes you enter and exit: the left tree is always on
 * screen (except while a meeting owns it).
 *
 * "library" (the recordings grid) used to be its own OS window, which meant two
 * sidebars and two answers to "where does this recording live". Settings is NOT
 * a route: it is its own OS window (lib/nav.ts → openSettingsWindow), so
 * tweaking a knob never navigates the shell away from what it was showing.
 */
export type AppMode = "home" | "live" | "study" | "library";

/** Left-nav panels of the Settings window (see settings/SettingsApp.tsx). */
export type SettingsCategory =
  | "basic"
  | "account"
  | "organizations"
  | "provider"
  | "transcription"
  // The phrase dictionary is NOT part of Settings state: it lives in its own
  // shared file (lib/dictionary) so the MCP server can edit it too. This is
  // only the nav id for its panel.
  | "dictionary"
  | "voiceTyping"
  | "permissions"
  | "evaluations"
  | "todos"
  | "mcp"
  | "usage";

/** Which node of the one tree the library route is showing. */
export type LibrarySelection =
  | { kind: "personal"; node: LibraryNode }
  | { kind: "org"; id: string; name: string; folderId: string | null }
  | { kind: "voice" };

/** Lifecycle status of an async pass (analysis, delivery assessment, action items). */
export type AsyncTaskStatus = "idle" | "running" | "done" | "error";

/** Health of the live meeting's link to the transcription service, as the
 *  backend reports it on `meeting://transcription` (see tauriEvents). */
export type TranscriptionLink = "live" | "reconnecting";

/**
 * Replay keep-window. Segments that fall entirely OUTSIDE [startMs, endMs] are
 * trimmed: greyed in the transcript and excluded from every analysis (evals,
 * Ask, timeline, war-gaming, voice diarization). `null` = keep the whole thing.
 * Non-destructive — clearing it restores everything.
 */
export interface ReplayTrim {
  startMs: number;
  endMs: number;
}

/** The whole store: every slice, composed. */
export type ParleyState = NavSlice &
  ReplaySlice &
  IngestSlice &
  StudySlice &
  MeetingSlice &
  SegmentsSlice &
  CoachingSlice &
  PrepSlice &
  SettingsSlice &
  AuthSlice &
  SpeakersSlice;

/** The `set` a slice creator receives (zustand's, persist-wrapped). */
export type StoreSet = (
  partial: Partial<ParleyState> | ((state: ParleyState) => Partial<ParleyState>),
) => void;

/** The `get` a slice creator receives. */
export type StoreGet = () => ParleyState;

/** A slice creator: builds one concern's fields + actions over the shared set/get. */
export type SliceCreator<T> = (set: StoreSet, get: StoreGet) => T;
