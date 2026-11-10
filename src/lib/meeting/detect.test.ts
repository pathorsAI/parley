import { describe, expect, it } from "vitest";
import type { MeetingDraft } from "../store/prep";
import {
  DRAFT_NEAR_MS,
  PILL_SIZE,
  PROMPT_MARGIN,
  muteApp,
  pickDraftNear,
  promptFrame,
  sanitizeMutedApps,
  shouldPrompt,
  unmuteApp,
  type MicAppPayload,
} from "./detect";

const NOW = Date.UTC(2026, 10, 2, 6, 0);
const MIN = 60_000;

function draft(id: string, meetingAt: number | null): MeetingDraft {
  return {
    id,
    title: id,
    meetingAt,
    meetingEndAt: null,
    reminderLeadMin: 5,
    remindedFor: null,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    todos: [],
    meetingFolderId: null,
    meetingOrgShare: null as unknown as MeetingDraft["meetingOrgShare"],
    updatedAt: 0,
  };
}

const zoom: MicAppPayload = { appId: "us.zoom.xos", appName: "Zoom", kind: "app" };

describe("pickDraftNear", () => {
  it("picks the draft scheduled closest to now within 15 minutes either side", () => {
    const drafts = [draft("later", NOW + 12 * MIN), draft("just-started", NOW - 3 * MIN), draft("none", null)];
    expect(pickDraftNear(drafts, NOW)?.id).toBe("just-started");
  });

  it("includes the edges and ignores anything further out", () => {
    expect(pickDraftNear([draft("edge", NOW + DRAFT_NEAR_MS)], NOW)?.id).toBe("edge");
    expect(pickDraftNear([draft("past", NOW - 16 * MIN), draft("future", NOW + 40 * MIN)], NOW)).toBeNull();
    expect(pickDraftNear([draft("untimed", null)], NOW)).toBeNull();
  });
});

describe("shouldPrompt", () => {
  const base = {
    enabled: true,
    meetingStatus: "idle" as const,
    finalizing: false,
    starting: false,
    muted: [],
    app: zoom,
  };

  it("asks when idle and enabled", () => {
    expect(shouldPrompt(base)).toBe(true);
    expect(shouldPrompt({ ...base, meetingStatus: "stopped" })).toBe(true);
  });

  it("stays quiet while recording, starting, saving, or switched off", () => {
    expect(shouldPrompt({ ...base, meetingStatus: "recording" })).toBe(false);
    expect(shouldPrompt({ ...base, meetingStatus: "paused" })).toBe(false);
    expect(shouldPrompt({ ...base, starting: true })).toBe(false);
    expect(shouldPrompt({ ...base, finalizing: true })).toBe(false);
    expect(shouldPrompt({ ...base, enabled: false })).toBe(false);
  });

  it("never asks about a muted app", () => {
    expect(shouldPrompt({ ...base, muted: [{ id: "us.zoom.xos", name: "Zoom" }] })).toBe(false);
    expect(shouldPrompt({ ...base, muted: [{ id: "com.google.chrome", name: "Chrome" }] })).toBe(true);
  });
});

describe("muted apps", () => {
  it("adds an app once, lowercased, and removes it again", () => {
    const once = muteApp([], { appId: "US.ZOOM.XOS", appName: "Zoom" });
    expect(once).toEqual([{ id: "us.zoom.xos", name: "Zoom" }]);
    expect(muteApp(once, zoom)).toEqual(once);
    expect(unmuteApp(once, "us.zoom.xos")).toEqual([]);
  });

  it("cannot mute an app the OS did not name", () => {
    expect(muteApp([], { appId: "", appName: "" })).toEqual([]);
  });

  it("sanitizes whatever was persisted", () => {
    expect(sanitizeMutedApps(undefined)).toEqual([]);
    expect(sanitizeMutedApps("zoom")).toEqual([]);
    expect(
      sanitizeMutedApps([{ id: "Zoom.exe", name: "Zoom" }, { id: "zoom.exe" }, { name: "x" }, null, { id: "slack.exe" }]),
    ).toEqual([
      { id: "zoom.exe", name: "Zoom" },
      { id: "slack.exe", name: "slack.exe" },
    ]);
  });
});

describe("promptFrame", () => {
  it("puts the pill 16px from the top-right corner of the work area", () => {
    const f = promptFrame({ x: 0, y: 25, width: 1440 });
    expect(f.x + PROMPT_MARGIN + PILL_SIZE.width).toBe(1440 - 16);
    expect(f.y + PROMPT_MARGIN).toBe(25 + 16);
  });

  it("follows a second screen's origin", () => {
    const f = promptFrame({ x: 1440, y: 0, width: 1920 });
    expect(f.x + f.width).toBe(1440 + 1920);
  });
});
