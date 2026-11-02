// "Another app started a call — record it?" (issue #606), the pure half: what
// the backend reports, which draft the prompt offers, the muted list, and
// where the prompt goes. The wiring lives in detectPrompt.ts.
import type { MeetingDraft } from "../store/prep";
import type { MeetingStatus, MutedMeetingApp } from "../types";

/** `meeting://detected` / `meeting://ended` (meeting_detect.rs `MicApp`). */
export interface MicAppPayload {
  /** Lowercase bundle id / exe / package name; empty when unknown. */
  appId: string;
  /** "Zoom", "Google Chrome", …; empty when unknown. */
  appName: string;
  /** A browser (a web call such as Google Meet), an app, or someone the OS
   *  would not name (macOS before 14.2). */
  kind: "browser" | "app" | "unknown";
}

/** A draft scheduled this close to now (either side) is the meeting the call
 *  most likely is. */
export const DRAFT_NEAR_MS = 15 * 60_000;

/** The saved draft scheduled closest to `now`, within {@link DRAFT_NEAR_MS}
 *  either side, or null. Pure. */
export function pickDraftNear(
  drafts: readonly MeetingDraft[],
  now: number,
  windowMs: number = DRAFT_NEAR_MS,
): MeetingDraft | null {
  let best: MeetingDraft | null = null;
  let bestGap = Infinity;
  for (const d of drafts) {
    if (d.meetingAt == null) continue;
    const gap = Math.abs(d.meetingAt - now);
    if (gap <= windowMs && gap < bestGap) {
      best = d;
      bestGap = gap;
    }
  }
  return best;
}

/** Whether a detected call should be asked about, from the main window's
 *  view. The backend already held back for muted apps and for Parley's own
 *  capture; this repeats the checks against the latest settings and the
 *  frontend's own start latch. Pure. */
export function shouldPrompt(p: {
  enabled: boolean;
  meetingStatus: MeetingStatus;
  finalizing: boolean;
  starting: boolean;
  muted: readonly MutedMeetingApp[];
  app: MicAppPayload;
}): boolean {
  if (!p.enabled || p.starting || p.finalizing) return false;
  if (p.meetingStatus === "recording" || p.meetingStatus === "paused") return false;
  return !isMuted(p.muted, p.app.appId);
}

export function isMuted(muted: readonly MutedMeetingApp[], appId: string): boolean {
  if (!appId) return false;
  const id = appId.toLowerCase();
  return muted.some((m) => m.id === id);
}

/** The muted list with `app` added (once). An unknown app cannot be muted. Pure. */
export function muteApp(muted: readonly MutedMeetingApp[], app: { appId: string; appName: string }): MutedMeetingApp[] {
  const id = app.appId.toLowerCase();
  if (!id || muted.some((m) => m.id === id)) return [...muted];
  return [...muted, { id, name: app.appName || id }];
}

/** The muted list without `id`. Pure. */
export function unmuteApp(muted: readonly MutedMeetingApp[], id: string): MutedMeetingApp[] {
  return muted.filter((m) => m.id !== id);
}

/** A persisted muted list, whatever shape it was saved in. Pure. */
export function sanitizeMutedApps(raw: unknown): MutedMeetingApp[] {
  if (!Array.isArray(raw)) return [];
  const out: MutedMeetingApp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id) continue;
    const key = id.toLowerCase();
    if (out.some((m) => m.id === key)) continue;
    out.push({ id: key, name: typeof name === "string" && name ? name : key });
  }
  return out;
}

/** The pill the prompt draws, in logical px. */
export const PILL_SIZE = { width: 460, height: 64 } as const;
/** Transparent margin around the pill, for its CSS shadow. */
export const PROMPT_MARGIN = 16;
/** The prompt window's size: the pill plus its shadow margin. */
export const PROMPT_SIZE = {
  width: PILL_SIZE.width + PROMPT_MARGIN * 2,
  height: PILL_SIZE.height + PROMPT_MARGIN * 2,
} as const;
/** How much taller the window grows while the chevron's menu is open. */
export const PROMPT_MENU_EXTRA = 96;
/** The pill's gap from the screen's top and right edges (the window's
 *  transparent margin makes up part of it). */
const PROMPT_GAP = 16 - PROMPT_MARGIN;

/** Where the prompt goes on a work area (logical px): its top-right corner.
 *  Pure. */
export function promptFrame(area: { x: number; y: number; width: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(area.x + Math.max(0, area.width - PROMPT_SIZE.width - PROMPT_GAP)),
    y: Math.round(area.y + PROMPT_GAP),
    ...PROMPT_SIZE,
  };
}

/** How long an untouched prompt stays up. */
export const PROMPT_TIMEOUT_MS = 20_000;
