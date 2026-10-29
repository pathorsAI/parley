import { create } from "zustand";
import { useStore, isMeetingActive } from "../store";
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

/** The reminder card the main window shows (null = none up). */
export const useReminderDue = create<{ dueAt: number | null; dismiss: () => void }>((set) => ({
  dueAt: null,
  dismiss: () => set({ dueAt: null }),
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

function fire(): void {
  const s = useStore.getState();
  if (s.meetingAt == null) return;
  s.setRemindedFor(s.meetingAt);
  // Already recording: the reminder has nothing left to say.
  if (isMeetingActive(s.meetingStatus)) return;
  const minutes = Math.max(0, Math.round((s.meetingAt - Date.now()) / 60_000));
  log.info("reminder: firing", { meetingAt: s.meetingAt, minutes });
  useReminderDue.setState({ dueAt: s.meetingAt });
  void alertUser(
    reminderHeadline(s.settings.language, s.meetingTitle, minutes),
    translate(s.settings.language, "reminder.body"),
  );
}

/**
 * Run the meeting-draft reminder for this window (the main window, once).
 * Re-plans whenever the draft's time, lead or reminded marker changes, and
 * retires the draft's time once its meeting is recorded. Returns its teardown.
 */
export function initMeetingReminder(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const replan = () => {
    clearTimeout(timer);
    const s = useStore.getState();
    const plan = planReminder({
      meetingAt: s.meetingAt,
      leadMin: s.reminderLeadMin,
      remindedFor: s.remindedFor,
      now: Date.now(),
    });
    if (plan.kind === "fire") fire();
    else if (plan.kind === "wait") timer = setTimeout(replan, plan.ms);
  };

  const unsubscribe = useStore.subscribe((next, prev) => {
    // The drafted meeting is being recorded: its time is spent.
    if (isMeetingActive(next.meetingStatus) && !isMeetingActive(prev.meetingStatus)) {
      useReminderDue.getState().dismiss();
      if (next.meetingAt != null) next.setMeetingAt(null);
      return;
    }
    if (
      next.meetingAt !== prev.meetingAt ||
      next.reminderLeadMin !== prev.reminderLeadMin ||
      next.remindedFor !== prev.remindedFor
    ) {
      // A new time is a new reminder; a cleared one takes its card with it.
      if (next.meetingAt !== prev.meetingAt) {
        if (next.meetingAt == null) useReminderDue.getState().dismiss();
        if (next.remindedFor != null && next.remindedFor !== next.meetingAt) next.setRemindedFor(null);
      }
      replan();
    }
  });
  replan();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
