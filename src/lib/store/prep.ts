// Everything the user sets up FOR one meeting: context, negotiation setup,
// agenda checklist, and where it will be filed / shared.

import type { TodoItem } from "../types";
import type { MeetingShare } from "../history/history";
import { log } from "../log";
import { isMeetingActive } from "./meeting";
import type { SliceCreator } from "./types";

export interface PrepSlice {
  /** Meeting to-do / agenda checklist. */
  todos: TodoItem[];
  /** Per-meeting context/description (who's here, roles) — NOT a global setting. */
  meetingContext: string;
  setMeetingContext: (text: string) => void;
  /** The name typed into the floating meeting window's title. Empty = the save
   *  falls back to its dated default ("會議 · …"). */
  meetingTitle: string;
  setMeetingTitle: (title: string) => void;
  /** The meeting-draft sheet is open: the prep below, filled in before
   *  recording ("新增會議草稿"). UI state only; not part of the draft itself. */
  draftOpen: boolean;
  setDraftOpen: (open: boolean) => void;
  /** Principled-negotiation setup for THIS deal (per-meeting, not global). Feeds
   *  BATNA / ZOPA / walk-away reasoning in the analysis. */
  meetingBatna: string;
  meetingTarget: string;
  meetingFloor: string;
  setNegotiationField: (field: "meetingBatna" | "meetingTarget" | "meetingFloor", value: string) => void;

  // ── Filing for the current/upcoming meeting ─────────────────────────────────
  /** Folder this meeting will be saved into (null = the personal root, or the
   *  settings default when one is configured). */
  meetingFolderId: string | null;
  setMeetingFolder: (folderId: string | null) => void;
  /**
   * This meeting's org-share choice. null = follow the settings default;
   * "off" = suppress a default share for this one meeting. Independent of the
   * folder above — a shared copy is a second destination, not a move. Per
   * meeting: cleared with the rest of the prep slice.
   */
  meetingOrgShare: MeetingShare;
  setMeetingOrgShare: (share: MeetingShare) => void;
  /** Throw the current prep draft away (folder, context, agenda, negotiation
   *  fields). The ONLY prep-clearing path. */
  resetPrep: () => void;

  // the to-do checklist
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  removeTodo: (id: string) => void;
  /** Mark the given checklist item ids as done (used by the AI auto-checker). */
  markTodosDone: (ids: string[]) => void;
  /** Replace the checklist with a template's items (all unchecked). */
  applyTodoTemplate: (items: string[]) => void;
}

/**
 * Everything the user sets up FOR one meeting, reset as one unit by
 * {@link PrepSlice.resetPrep}. Keeping the list in one place is why "the
 * previous call's setup silently followed you into the next meeting" can't come
 * back: one explicit reset clears the slice wholesale.
 *
 * Deliberately NOT reset on stop: the save pipeline reads `meetingFolderId` off
 * the store asynchronously (see history.saveLiveToHistory).
 */
const CLEARED_PREP_SLICE = {
  meetingFolderId: null,
  meetingOrgShare: null,
  meetingContext: "",
  meetingTitle: "",
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",
  todos: [] as TodoItem[],
} satisfies Partial<PrepSlice>;

export const createPrepSlice: SliceCreator<PrepSlice> = (set) => ({
  todos: [],
  meetingContext: "",
  meetingTitle: "",
  draftOpen: false,
  setDraftOpen: (draftOpen) => set({ draftOpen }),
  meetingFolderId: null,
  meetingOrgShare: null,
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",

  setMeetingContext: (text) => set({ meetingContext: text }),
  setMeetingTitle: (meetingTitle) => set({ meetingTitle }),
  setMeetingOrgShare: (meetingOrgShare) => set({ meetingOrgShare }),
  setMeetingFolder: (meetingFolderId) => set({ meetingFolderId }),
  resetPrep: () =>
    set((s) => {
      if (isMeetingActive(s.meetingStatus)) return {};
      log.info("store: prep reset");
      return { ...CLEARED_PREP_SLICE };
    }),
  setNegotiationField: (field, value) => set({ [field]: value }),

  addTodo: (text) =>
    set((state) => {
      const t = text.trim();
      if (!t) return {};
      return { todos: [...state.todos, { id: crypto.randomUUID(), text: t, done: false }] };
    }),

  toggleTodo: (id) =>
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    })),

  removeTodo: (id) => set((state) => ({ todos: state.todos.filter((t) => t.id !== id) })),

  markTodosDone: (ids) =>
    set((state) => {
      const set_ = new Set(ids);
      return { todos: state.todos.map((t) => (set_.has(t.id) ? { ...t, done: true } : t)) };
    }),

  applyTodoTemplate: (items) =>
    set({
      todos: items
        .filter((t) => t.trim())
        .map((t) => ({ id: crypto.randomUUID(), text: t.trim(), done: false })),
    }),
});
