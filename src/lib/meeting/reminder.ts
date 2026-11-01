import { create } from "zustand";
import { useStore, isMeetingActive } from "../store";
import type { MeetingDraft } from "../store/prep";
import { translate } from "../../i18n";
import { isTauri } from "../platform";
import { log } from "../log";

/** A reminder missed while Parley was closed still fires this long after the
 *  meeting's start — late is better than never; much later is noise. */
export const LATE_GRACE_MS = 10 * 60_000;
/** Longest single wait: timers past ~24 days overflow, and a day-long wait is
 *  re-planned anyway once it wakes. */
const MAX_WAIT_MS = 24 * 60 * 60_000;

export type ReminderPlan = { kind: "none" } | { kind: "wait"; ms: number } | { kind: "fire" };

/** What the reminder for a drafted meeting should do at `now`. Pure. */
export function planReminder(p: {
  meetingAt: number | null;
  leadMin: number;
  remindedFor: number | null;
  now: number;
}): ReminderPlan {
  if (p.meetingAt == null || p.remindedFor === p.meetingAt) return { kind: "none" };
  if (p.now > p.meetingAt + LATE_GRACE_MS) return { kind: "none" };
  const fireAt = p.meetingAt - Math.max(0, p.leadMin) * 60_000;
  if (fireAt > p.now) return { kind: "wait", ms: Math.min(fireAt - p.now, MAX_WAIT_MS) };
  return { kind: "fire" };
}

/** The draft whose reminder card the main window shows (null = none up). */
export const useReminderDue = create<{ draftId: string | null; dismiss: () => void }>((set) => ({
  draftId: null,
  dismiss: () => set({ draftId: null }),
}));

/** The notification's headline: whose meeting, and how soon. */
export function reminderHeadline(language: Parameters<typeof translate>[0], title: string, minutes: number): string {
  const name = title.trim() || translate(language, "floating.untitled");
  return minutes > 0
    ? translate(language, "reminder.soon", { title: name, minutes: String(minutes) })
    : translate(language, "reminder.now", { title: name });
}

/** Ask for permission to post notifications, once, when a time is first set. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (error) {
    log.warn("reminder: notification permission check failed", { error: String(error) });
    return false;
  }
}

/** Reach the user wherever they are: a system notification, the Dock, and the
 *  window itself (shown if it was closed to the Dock or tray), where the
 *  reminder card waits with Start. */
async function alertUser(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    if (await ensureNotificationPermission()) {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title, body });
    }
  } catch (error) {
    log.warn("reminder: notification failed", { error: String(error) });
  }
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (!(await win.isVisible())) await win.show();
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch (error) {
    log.warn("reminder: window attention failed", { error: String(error) });
  }
}

function fire(draft: MeetingDraft): void {
  const s = useStore.getState();
  if (draft.meetingAt == null) return;
  s.markDraftReminded(draft.id, draft.meetingAt);
  // Already recording: the reminder has nothing left to say.
  if (isMeetingActive(s.meetingStatus)) return;
  const minutes = Math.max(0, Math.round((draft.meetingAt - Date.now()) / 60_000));
  log.info("reminder: firing", { draft: draft.id, meetingAt: draft.meetingAt, minutes });
  useReminderDue.setState({ draftId: draft.id });
  void alertUser(
    reminderHeadline(s.settings.language, draft.title, minutes),
    translate(s.settings.language, "reminder.body"),
  );
}

/**
 * Run the meeting-draft reminders for this window (the main window, once):
 * one per saved draft with a time, re-planned whenever the drafts change.
 * Returns its teardown.
 */
export function initMeetingReminder(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Firing marks the draft, which changes the drafts and re-enters through the
  // subscription below; the guard keeps that from planning mid-loop.
  let planning = false;
  const replan = () => {
    if (planning) return;
    planning = true;
    try {
      clearTimeout(timer);
      const now = Date.now();
      let wait: number | null = null;
      const due: string[] = [];
      for (const d of useStore.getState().drafts) {
        const plan = planReminder({ meetingAt: d.meetingAt, leadMin: d.reminderLeadMin, remindedFor: d.remindedFor, now });
        if (plan.kind === "fire") due.push(d.id);
        else if (plan.kind === "wait") wait = wait == null ? plan.ms : Math.min(wait, plan.ms);
      }
      for (const id of due) {
        const d = useStore.getState().drafts.find((x) => x.id === id);
        if (d) fire(d);
      }
      if (wait != null) timer = setTimeout(replan, wait);
    } finally {
      planning = false;
    }
  };

  const unsubscribe = useStore.subscribe((next, prev) => {
    if (next.drafts === prev.drafts) return;
    // A card whose draft is gone (recorded, deleted) goes with it.
    const due = useReminderDue.getState().draftId;
    if (due && !next.drafts.some((d) => d.id === due)) useReminderDue.getState().dismiss();
    replan();
  });
  replan();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
