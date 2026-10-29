// Everything the user sets up FOR one meeting: context, negotiation setup,
// agenda checklist, and where it will be filed / shared.

import type { TodoItem } from "../types";
import type { MeetingShare } from "../history/history";
import { log } from "../log";
import { notify } from "../notify";
import { translate } from "../../i18n/messages";
import { isMeetingActive } from "./meeting";
import type { SliceCreator } from "./types";

/** Default reminder lead: enough to wrap up and join, short enough to still
 *  be on your mind. Changeable per draft. */
export const DEFAULT_REMINDER_LEAD_MIN = 5;

/**
 * A saved meeting draft (儲存草稿): everything prepared for one upcoming
 * meeting. Drafts wait in a list — 總覽's 即將開始 — and one is loaded into
 * the prep fields to be edited or recorded.
 */
export interface MeetingDraft {
  id: string;
  title: string;
  meetingAt: number | null;
  meetingEndAt: number | null;
  reminderLeadMin: number;
  /** The `meetingAt` whose reminder has already fired. */
  remindedFor: number | null;
  meetingContext: string;
  meetingBatna: string;
  meetingTarget: string;
  meetingFloor: string;
  todos: TodoItem[];
  meetingFolderId: string | null;
  meetingOrgShare: MeetingShare;
  updatedAt: number;
}

/** The prep fields a draft fills in when it is loaded. */
function prepFromDraft(d: MeetingDraft) {
  return {
    meetingTitle: d.title,
    meetingAt: d.meetingAt,
    meetingEndAt: d.meetingEndAt,
    reminderLeadMin: d.reminderLeadMin,
    meetingContext: d.meetingContext,
    meetingBatna: d.meetingBatna,
    meetingTarget: d.meetingTarget,
    meetingFloor: d.meetingFloor,
    todos: d.todos,
    meetingFolderId: d.meetingFolderId,
    meetingOrgShare: d.meetingOrgShare,
    meetingNotes: "",
  };
}

/** Drafts in the order 即將開始 lists them: timed ones soonest first, then
 *  the untimed ones, newest first. Pure. */
export function sortDrafts(drafts: readonly MeetingDraft[]): MeetingDraft[] {
  return [...drafts].sort((a, b) => {
    if (a.meetingAt != null && b.meetingAt != null) return a.meetingAt - b.meetingAt;
    if (a.meetingAt != null) return -1;
    if (b.meetingAt != null) return 1;
    return b.updatedAt - a.updatedAt;
  });
}

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
  /** Free-form notes typed during the meeting (the floating window's 筆記). */
  meetingNotes: string;
  setMeetingNotes: (notes: string) => void;
  /** When the drafted meeting starts (epoch ms), or null when it has no time.
   *  A draft with a time is kept across restarts and reminds you before it. */
  meetingAt: number | null;
  setMeetingAt: (at: number | null) => void;
  /** When it ends (epoch ms) — the calendar-style picker's end time. */
  meetingEndAt: number | null;
  setMeetingEndAt: (at: number | null) => void;
  /** Minutes before `meetingAt` the reminder fires (0 = at the start). */
  reminderLeadMin: number;
  setReminderLeadMin: (min: number) => void;
  /** Saved drafts, waiting to be recorded (persisted). */
  drafts: MeetingDraft[];
  /** The saved draft the prep fields are being edited for (null = a new one). */
  editingDraftId: string | null;
  /** Save the prep as a draft (a new one, or the one being edited) and clear
   *  the prep for the next. Returns the saved draft (null during a meeting). */
  saveDraft: () => MeetingDraft | null;
  /** Load a saved draft into the prep to edit it, and open the sheet. */
  editDraft: (id: string) => void;
  /** Leave the draft being edited unchanged and clear the prep. */
  discardDraftEdit: () => void;
  /** Load a saved draft into the prep to record it, taking it off the list. */
  takeDraft: (id: string) => boolean;
  deleteDraft: (id: string) => void;
  /** Note that this draft's reminder fired for its `meetingAt`. */
  markDraftReminded: (id: string, at: number) => void;
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
  meetingNotes: "",
  meetingAt: null,
  meetingEndAt: null,
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",
  todos: [] as TodoItem[],
} satisfies Partial<PrepSlice>;

export const createPrepSlice: SliceCreator<PrepSlice> = (set) => ({
  todos: [],
  meetingContext: "",
  meetingTitle: "",
  meetingNotes: "",
  meetingAt: null,
  meetingEndAt: null,
  reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
  drafts: [],
  editingDraftId: null,
  draftOpen: false,
  setDraftOpen: (draftOpen) =>
    set((s) => {
      // The sheet edits the prep fields, which belong to the live meeting
      // while one runs: a new draft waits for it to end.
      if (draftOpen && isMeetingActive(s.meetingStatus)) {
        notify.message(translate(s.settings.language, "draft.lockedWhileRecording"));
        return {};
      }
      return { draftOpen };
    }),
  meetingFolderId: null,
  meetingOrgShare: null,
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",

  setMeetingContext: (text) => set({ meetingContext: text }),
  setMeetingTitle: (meetingTitle) => set({ meetingTitle }),
  setMeetingNotes: (meetingNotes) => set({ meetingNotes }),
  setMeetingAt: (meetingAt) => set({ meetingAt }),
  setMeetingEndAt: (meetingEndAt) => set({ meetingEndAt }),
  setReminderLeadMin: (reminderLeadMin) => set({ reminderLeadMin }),
  saveDraft: () => {
    let saved: MeetingDraft | null = null;
    set((s) => {
      // The prep belongs to the live meeting while one runs.
      if (isMeetingActive(s.meetingStatus)) return {};
      const id = s.editingDraftId ?? crypto.randomUUID();
      const prev = s.drafts.find((d) => d.id === id);
      const draft: MeetingDraft = {
        id,
        title: s.meetingTitle.trim(),
        meetingAt: s.meetingAt,
        meetingEndAt: s.meetingEndAt,
        reminderLeadMin: s.reminderLeadMin,
        // A moved time (or lead) is a new reminder.
        remindedFor:
          prev && prev.meetingAt === s.meetingAt && prev.reminderLeadMin === s.reminderLeadMin
            ? prev.remindedFor
            : null,
        meetingContext: s.meetingContext,
        meetingBatna: s.meetingBatna,
        meetingTarget: s.meetingTarget,
        meetingFloor: s.meetingFloor,
        todos: s.todos,
        meetingFolderId: s.meetingFolderId,
        meetingOrgShare: s.meetingOrgShare,
        updatedAt: Date.now(),
      };
      saved = draft;
      log.info("store: draft saved", { id, timed: draft.meetingAt != null });
      return {
        drafts: prev ? s.drafts.map((d) => (d.id === id ? draft : d)) : [...s.drafts, draft],
        editingDraftId: null,
        reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
        ...CLEARED_PREP_SLICE,
      };
    });
    return saved;
  },
  editDraft: (id) =>
    set((s) => {
      const d = s.drafts.find((x) => x.id === id);
      if (!d) return {};
      if (isMeetingActive(s.meetingStatus)) {
        notify.message(translate(s.settings.language, "draft.lockedWhileRecording"));
        return {};
      }
      return { ...prepFromDraft(d), editingDraftId: id, draftOpen: true };
    }),
  discardDraftEdit: () =>
    set((s) => {
      if (s.editingDraftId == null || isMeetingActive(s.meetingStatus)) return {};
      return { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null };
    }),
  takeDraft: (id) => {
    let taken = false;
    set((s) => {
      const d = s.drafts.find((x) => x.id === id);
      if (!d || isMeetingActive(s.meetingStatus)) return {};
      taken = true;
      log.info("store: draft taken to record", { id });
      return {
        ...prepFromDraft(d),
        drafts: s.drafts.filter((x) => x.id !== id),
        editingDraftId: null,
        draftOpen: false,
      };
    });
    return taken;
  },
  deleteDraft: (id) =>
    set((s) => ({
      drafts: s.drafts.filter((x) => x.id !== id),
      ...(s.editingDraftId === id
        ? { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null }
        : {}),
    })),
  markDraftReminded: (id, at) =>
    set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? { ...d, remindedFor: at } : d)) })),
  setMeetingOrgShare: (meetingOrgShare) => set({ meetingOrgShare }),
  setMeetingFolder: (meetingFolderId) => set({ meetingFolderId }),
  resetPrep: () =>
    set((s) => {
      if (isMeetingActive(s.meetingStatus)) return {};
      log.info("store: prep reset");
      return { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null };
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
