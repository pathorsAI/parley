// Everything the user sets up FOR one meeting: context, negotiation setup,
// agenda checklist, and where it will be filed / shared.

import type { TodoItem } from "../types";
import type { MeetingShare } from "../history/history";
import { log } from "../log";
import { liveMeetingRunning, noteDraftTaken } from "./liveProbe";
import { retitleForTime } from "../meeting/draftTitle";
import { applyAiChecks, toggleAgendaItem, type AgendaCheck } from "../meeting/agenda";
import {
  emptyPlaybook,
  playbookWithItem,
  playbookWithoutItem,
  type MeetingPlaybook,
  type PlaybookItemFields,
  type PlaybookList,
} from "../meeting/playbook";
import { emptyOpening, normalizeOpening, openingWithSmallTalk, openingWithoutSmallTalk, type MeetingOpening } from "../meeting/opening";
import { withRemovedDraft, type RemovedDraft } from "../meeting/removedDrafts";
import type { SliceCreator } from "./types";

export type { DraftRemoval, RemovedDraft } from "../meeting/removedDrafts";

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
  /** What to ask, how to steer, where to go next — live suggestions pick from it. */
  playbook: MeetingPlaybook;
  /** What to say in the first minute: small talk, then the standard opening.
   *  On screen from the start of the meeting (meeting/opening.ts). */
  opening: MeetingOpening;
  meetingFolderId: string | null;
  meetingOrgShare: MeetingShare;
  updatedAt: number;
}

/** What an MCP client gives `addDraft`. */
export interface NewDraftFields {
  title: string;
  meetingAt: number | null;
  meetingEndAt: number | null;
  reminderLeadMin: number | null;
  meetingContext: string;
  meetingFolderId: string | null;
  agenda: string[];
  playbook: MeetingPlaybook;
  opening: MeetingOpening;
}

/** The fields an MCP client may change on a saved draft; absent ones stay. */
export type DraftPatch = Partial<
  Pick<
    MeetingDraft,
    | "title"
    | "meetingAt"
    | "meetingEndAt"
    | "reminderLeadMin"
    | "meetingContext"
    | "meetingFolderId"
    | "todos"
    | "playbook"
    | "opening"
  >
>;

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
    meetingPlaybook: d.playbook,
    meetingOpening: d.opening,
    meetingFolderId: d.meetingFolderId,
    meetingOrgShare: d.meetingOrgShare,
    meetingNotes: "",
  };
}

/** Drafts in the order the draft lists show them: timed ones soonest first,
 *  then the untimed ones, newest first. Given `now`, a meeting whose time has
 *  already gone by (see isOver) drops below both, the latest first, so the
 *  next meeting to start is always on top. Pure. */
export function sortDrafts(drafts: readonly MeetingDraft[], now?: number): MeetingDraft[] {
  const rank = (d: MeetingDraft) => {
    if (d.meetingAt == null) return 1;
    return now != null && isOver(d, now) ? 2 : 0;
  };
  return [...drafts].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.meetingAt != null && b.meetingAt != null) {
      return rank(a) === 2 ? b.meetingAt - a.meetingAt : a.meetingAt - b.meetingAt;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/** The end of a draft's meeting: its end time, or an hour after it starts. */
function endOf(d: MeetingDraft & { meetingAt: number }): number {
  return d.meetingEndAt ?? d.meetingAt + STARTING_SOON_MS;
}

/** Has this draft's meeting come and gone? Untimed drafts never have. Pure. */
export function isOver(d: MeetingDraft, now: number): boolean {
  return d.meetingAt != null && endOf({ ...d, meetingAt: d.meetingAt }) <= now;
}

/** How far ahead 總覽's 即將開始的會議 looks: a meeting moves up there an
 *  hour before it starts. */
export const STARTING_SOON_MS = 60 * 60_000;

/** Is this draft's meeting about to start (within STARTING_SOON_MS) or under
 *  way? A meeting without an end time counts as running for an hour. Pure. */
export function isStartingSoon(d: MeetingDraft, now: number): boolean {
  if (d.meetingAt == null) return false;
  return d.meetingAt <= now + STARTING_SOON_MS && !isOver(d, now);
}

/** Drafts destined for this org — its root or any of its folders. Only a
 *  draft's own org pick counts: one that rides the settings-wide default
 *  share has no org of its own. Pure. */
export function draftsForOrg(drafts: readonly MeetingDraft[], orgId: string): MeetingDraft[] {
  return drafts.filter((d) => typeof d.meetingOrgShare === "object" && d.meetingOrgShare?.orgId === orgId);
}

/** Where a new draft opened from somewhere specific (an org's page) starts. */
export interface DraftPreset {
  orgId: string;
  folderId: string | null;
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
   *  the prep for the next. Returns the saved draft. The prep here is the main
   *  window's (useStore): a running meeting took its own copy when it started
   *  (meeting/liveSession.ts), so drafts are editable during a meeting. */
  saveDraft: () => MeetingDraft | null;
  /** Load a saved draft into the prep to edit it, and open the sheet. */
  editDraft: (id: string) => void;
  /** Leave the draft being edited unchanged and clear the prep. */
  discardDraftEdit: () => void;
  /** Load a saved draft into the prep to record it, taking it off the list
   *  (it is filed under removedDrafts as "recorded"). Refused (false) while a
   *  meeting runs: one meeting at a time. */
  takeDraft: (id: string) => boolean;
  /** Take a draft off the list (filed under removedDrafts as "deleted"). */
  deleteDraft: (id: string) => void;
  /** The drafts that left the list — recorded, deleted, or removed by the
   *  cloud sync — newest first (persisted, this device only). Nothing leaves
   *  the list without landing here, so "where did my draft go" always has an
   *  answer and a way back. */
  removedDrafts: RemovedDraft[];
  /** Put a removed draft back on the list, as a fresh write (it syncs up as
   *  one); null when there is no such removed draft. */
  restoreDraft: (id: string) => MeetingDraft | null;
  /** File a draft made elsewhere (an MCP client) straight into the list,
   *  leaving the prep alone — so it works mid-meeting too. */
  addDraft: (fields: NewDraftFields) => MeetingDraft;
  /** Change a saved draft in the list (an MCP client's edit); null when there
   *  is no such draft. The prep fields are left alone, as with a cloud merge. */
  updateDraft: (id: string, patch: DraftPatch) => MeetingDraft | null;
  /** Note that this draft's reminder fired for its `meetingAt`. Per-device
   *  state: deliberately leaves `updatedAt` alone (it is not synced). */
  markDraftReminded: (id: string, at: number) => void;
  /** Fold drafts from Parley Cloud into the list (cloud/draftSync.ts): each of
   *  `upserts` replaces the draft with its id, keeping this device's
   *  `remindedFor` (a new one starts unreminded), and `removed` ids leave the
   *  list (filed under removedDrafts as "elsewhere"). Only the LIST changes: the prep fields — a draft loaded for editing
   *  included — are never touched, so a save made after a remote change is
   *  simply the newer write. */
  mergeCloudDrafts: (upserts: MeetingDraft[], removed: string[]) => void;
  /** The meeting-draft sheet is open: the prep below, filled in before
   *  recording ("新增會議草稿"). UI state only; not part of the draft itself. */
  draftOpen: boolean;
  /** Open or close the sheet. `preset` points a new draft at an org (how an
   *  org's page opens it); without one the prep's own destination stands, as
   *  總覽 opens it. Ignored while a saved draft is being edited. */
  setDraftOpen: (open: boolean, preset?: DraftPreset) => void;
  /** The meeting's playbook (questions, branches, topics). The running
   *  meeting's copy is what live suggestions read. */
  meetingPlaybook: MeetingPlaybook;
  addPlaybookItem: (list: PlaybookList, fields: PlaybookItemFields) => void;
  removePlaybookItem: (list: PlaybookList, id: string) => void;
  /** The meeting's opening (small talk, then the standard opening). The
   *  running meeting's copy is what its opening card shows. */
  meetingOpening: MeetingOpening;
  setOpeningScript: (script: string) => void;
  addSmallTalk: (text: string) => void;
  removeSmallTalk: (index: number) => void;
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
  /** Throw the current prep draft away (folder, context, agenda, playbook,
   *  opening, negotiation fields). The ONLY prep-clearing path. */
  resetPrep: () => void;

  // the to-do checklist
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  removeTodo: (id: string) => void;
  /** Tick the items the AI heard covered (checkTodos), with where it heard
   *  them — the AI's ticks, which the user can still untick. */
  markTodosDone: (checks: readonly AgendaCheck[]) => void;
  /** Replace the checklist with a template's items (all unchecked). */
  applyTodoTemplate: (items: string[]) => void;
}

/**
 * Everything the user sets up FOR one meeting, reset as one unit by
 * {@link PrepSlice.resetPrep}. Keeping the list in one place is why "the
 * previous call's setup silently followed you into the next meeting" can't come
 * back: one explicit reset clears the slice wholesale.
 *
 * A meeting that starts MOVES these into the live store (meeting/liveSession.ts)
 * — the main window's prep is then free for the next draft — and its save reads
 * them from there.
 */
export const CLEARED_PREP_SLICE = {
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
  // One shared frozen value: every reset hands out the same empty playbook,
  // and nothing mutates it (the actions above build new ones).
  meetingPlaybook: Object.freeze(emptyPlaybook()) as MeetingPlaybook,
  meetingOpening: emptyOpening(),
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
  removedDrafts: [],
  editingDraftId: null,
  draftOpen: false,
  setDraftOpen: (draftOpen, preset) =>
    set((s) => {
      // "copy" is what a per-meeting org pick defaults to elsewhere
      // (useMeetingDestination, the settings default share).
      if (draftOpen && preset && s.editingDraftId == null) {
        return {
          draftOpen,
          meetingOrgShare: { orgId: preset.orgId, folderId: preset.folderId, mode: "copy" as const },
        };
      }
      return { draftOpen };
    }),
  meetingFolderId: null,
  meetingOrgShare: null,
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",
  meetingPlaybook: CLEARED_PREP_SLICE.meetingPlaybook,
  meetingOpening: CLEARED_PREP_SLICE.meetingOpening,

  setMeetingContext: (text) => set({ meetingContext: text }),
  setMeetingTitle: (meetingTitle) => set({ meetingTitle }),
  setMeetingNotes: (meetingNotes) => set({ meetingNotes }),
  // The title follows the time while it is still the time's auto name.
  setMeetingAt: (meetingAt) =>
    set((s) => ({
      meetingAt,
      meetingTitle: retitleForTime(s.meetingTitle, s.meetingAt, meetingAt, s.settings.language),
    })),
  setMeetingEndAt: (meetingEndAt) => set({ meetingEndAt }),
  setReminderLeadMin: (reminderLeadMin) => set({ reminderLeadMin }),
  saveDraft: () => {
    let saved: MeetingDraft | null = null;
    set((s) => {
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
        playbook: s.meetingPlaybook,
        opening: normalizeOpening(s.meetingOpening),
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
      return { ...prepFromDraft(d), editingDraftId: id, draftOpen: true };
    }),
  discardDraftEdit: () =>
    set((s) => {
      if (s.editingDraftId == null) return {};
      return { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null };
    }),
  takeDraft: (id) => {
    let taken = false;
    set((s) => {
      const d = s.drafts.find((x) => x.id === id);
      // Taking a draft is recording it — one meeting at a time.
      if (!d || liveMeetingRunning()) return {};
      taken = true;
      noteDraftTaken();
      log.info("store: draft taken to record", { id });
      return {
        ...prepFromDraft(d),
        drafts: s.drafts.filter((x) => x.id !== id),
        removedDrafts: withRemovedDraft(s.removedDrafts, d, "recorded", Date.now()),
        editingDraftId: null,
        draftOpen: false,
      };
    });
    return taken;
  },
  deleteDraft: (id) =>
    set((s) => {
      const d = s.drafts.find((x) => x.id === id);
      if (d) log.info("store: draft deleted", { id });
      return {
        drafts: s.drafts.filter((x) => x.id !== id),
        removedDrafts: d ? withRemovedDraft(s.removedDrafts, d, "deleted", Date.now()) : s.removedDrafts,
        ...(s.editingDraftId === id
          ? { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null }
          : {}),
      };
    }),
  restoreDraft: (id) => {
    let restored: MeetingDraft | null = null;
    set((s) => {
      const entry = s.removedDrafts.find((r) => r.draft.id === id);
      if (!entry) return {};
      // A fresh write: newer than the tombstone the removal sent to the cloud,
      // so the draft comes back on every device.
      const draft: MeetingDraft = { ...entry.draft, remindedFor: null, updatedAt: Date.now() };
      restored = draft;
      log.info("store: draft restored", { id, was: entry.reason });
      return {
        drafts: [...s.drafts.filter((d) => d.id !== id), draft],
        removedDrafts: s.removedDrafts.filter((r) => r.draft.id !== id),
      };
    });
    return restored;
  },
  addDraft: (f) => {
    const draft: MeetingDraft = {
      id: crypto.randomUUID(),
      title: f.title.trim(),
      meetingAt: f.meetingAt,
      meetingEndAt: f.meetingEndAt,
      reminderLeadMin: f.reminderLeadMin ?? DEFAULT_REMINDER_LEAD_MIN,
      remindedFor: null,
      meetingContext: f.meetingContext,
      meetingBatna: "",
      meetingTarget: "",
      meetingFloor: "",
      todos: f.agenda.map((text) => ({ id: crypto.randomUUID(), text, done: false })),
      playbook: f.playbook,
      opening: f.opening,
      meetingFolderId: f.meetingFolderId,
      meetingOrgShare: null,
      updatedAt: Date.now(),
    };
    log.info("store: draft added", { id: draft.id, timed: draft.meetingAt != null });
    set((s) => ({ drafts: [...s.drafts, draft] }));
    return draft;
  },
  updateDraft: (id, patch) => {
    let updated: MeetingDraft | null = null;
    set((s) => {
      const prev = s.drafts.find((d) => d.id === id);
      if (!prev) return {};
      const next: MeetingDraft = { ...prev, ...patch, updatedAt: Date.now() };
      // A moved time (or lead) is a new reminder.
      if (next.meetingAt !== prev.meetingAt || next.reminderLeadMin !== prev.reminderLeadMin) {
        next.remindedFor = null;
      }
      updated = next;
      log.info("store: draft updated", { id, timed: next.meetingAt != null });
      return { drafts: s.drafts.map((d) => (d.id === id ? next : d)) };
    });
    return updated;
  },
  markDraftReminded: (id, at) =>
    set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? { ...d, remindedFor: at } : d)) })),
  mergeCloudDrafts: (upserts, removed) =>
    set((s) => {
      if (upserts.length === 0 && removed.length === 0) return {};
      const gone = new Set(removed);
      const incoming = new Map(upserts.map((d) => [d.id, d]));
      const drafts: MeetingDraft[] = [];
      const now = Date.now();
      // A draft that is back (restored on another device) is no longer removed.
      let removedDrafts = s.removedDrafts.filter((r) => !incoming.has(r.draft.id));
      for (const d of s.drafts) {
        if (gone.has(d.id)) {
          removedDrafts = withRemovedDraft(removedDrafts, d, "elsewhere", now);
          continue;
        }
        const next = incoming.get(d.id);
        if (next) {
          incoming.delete(d.id);
          drafts.push({ ...next, remindedFor: d.remindedFor });
        } else {
          drafts.push(d);
        }
      }
      for (const d of incoming.values()) drafts.push({ ...d, remindedFor: null });
      if (gone.size > 0) log.info("store: drafts removed by the cloud sync", { ids: [...gone].join(",") });
      return { drafts, removedDrafts };
    }),
  setMeetingOrgShare: (meetingOrgShare) => set({ meetingOrgShare }),
  setMeetingFolder: (meetingFolderId) => set({ meetingFolderId }),
  resetPrep: () =>
    set(() => {
      log.info("store: prep reset");
      return { ...CLEARED_PREP_SLICE, reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN, editingDraftId: null };
    }),
  setNegotiationField: (field, value) => set({ [field]: value }),
  addPlaybookItem: (list, fields) =>
    set((s) => ({ meetingPlaybook: playbookWithItem(s.meetingPlaybook, list, fields) })),
  removePlaybookItem: (list, id) =>
    set((s) => ({ meetingPlaybook: playbookWithoutItem(s.meetingPlaybook, list, id) })),
  setOpeningScript: (script) => set((s) => ({ meetingOpening: { ...s.meetingOpening, script } })),
  addSmallTalk: (text) => set((s) => ({ meetingOpening: openingWithSmallTalk(s.meetingOpening, text) })),
  removeSmallTalk: (index) => set((s) => ({ meetingOpening: openingWithoutSmallTalk(s.meetingOpening, index) })),

  addTodo: (text) =>
    set((state) => {
      const t = text.trim();
      if (!t) return {};
      return { todos: [...state.todos, { id: crypto.randomUUID(), text: t, done: false }] };
    }),

  // A click (or an MCP client) is the user's tick — see toggleAgendaItem for
  // how unticking an AI tick keeps the AI from ticking it again.
  toggleTodo: (id) =>
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? toggleAgendaItem(t) : t)),
    })),

  removeTodo: (id) => set((state) => ({ todos: state.todos.filter((t) => t.id !== id) })),

  markTodosDone: (checks) =>
    set((state) => ({ todos: applyAiChecks(state.todos, checks) })),

  applyTodoTemplate: (items) =>
    set({
      todos: items
        .filter((t) => t.trim())
        .map((t) => ({ id: crypto.randomUUID(), text: t.trim(), done: false })),
    }),
});
