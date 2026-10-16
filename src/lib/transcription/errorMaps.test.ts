import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../nav/settings", () => ({ openSettings: vi.fn() }));

import { meetingErrorToastKey } from "../tauriEvents";
import { LOCAL_FAILURE_TOAST_KEY, isLocalFailureCode } from "./localAlerts";
import { overlayErrorKey } from "../voiceTyping/errorKeys";
import { localUploadErrorKey } from "../replay/ingest";
import { localFailureCode } from "./localModels";

// Every transcription failure code a surface can receive, and the i18n key it
// shows for it — pinned as literal tables, so merging the per-surface maps can
// be checked to return exactly the same keys. Codes come from the backend
// (`meeting://error`, `voicetyping://error`, local_stt::failure_code) and from
// the start gates ("no-key", "no-local-model").
const CODES = [
  "quota",
  "auth",
  "key",
  "capture",
  "connect",
  "local",
  "local-memory",
  "local-missing",
  "no-key",
  "no-local-model",
  "something-new",
  "",
];

/** `meeting://error` → toast (tauriEvents.ts + localAlerts.ts). */
const MEETING_ERROR_TOAST = {
  quota: "meeting.error.quota",
  auth: "meeting.error.auth",
  key: "meeting.error.key",
  capture: "meeting.error.capture",
  connect: "meeting.error.connect",
  local: "localStt.error.failed",
  "local-memory": "localStt.error.memory",
  "local-missing": "localStt.error.notReady",
  "no-key": "meeting.error.connect",
  "no-local-model": "meeting.error.connect",
  "something-new": "meeting.error.connect",
  "": "meeting.error.connect",
};

/** Voice-typing overlay error phase `message` → bubble text. */
const VOICE_TYPING_OVERLAY = {
  quota: "voiceTyping.error.quota",
  auth: "voiceTyping.error.auth",
  key: "voiceTyping.error.key",
  capture: "voiceTyping.error",
  connect: "voiceTyping.error",
  local: "voiceTyping.error.local",
  "local-memory": "voiceTyping.error.localMemory",
  "local-missing": "voiceTyping.noLocalModel",
  "no-key": "voiceTyping.noKey",
  "no-local-model": "voiceTyping.noLocalModel",
  "something-new": "voiceTyping.error",
  "": "voiceTyping.error",
};

/** A rejected local `transcribe_file`, by failure code → upload error text
 *  (`null` = the backend's own message is kept). */
const UPLOAD_LOCAL_FAILURE = {
  local: null,
  "local-memory": "localStt.error.memory",
  "local-missing": "localStt.error.notReadyUpload",
};

describe("transcription error maps (current behavior)", () => {
  it("meeting://error toasts", () => {
    const actual = Object.fromEntries(
      CODES.map((c) => [c, isLocalFailureCode(c) ? LOCAL_FAILURE_TOAST_KEY[c] : meetingErrorToastKey(c)]),
    );
    expect(actual).toEqual(MEETING_ERROR_TOAST);
  });

  it("voice-typing overlay errors", () => {
    expect(Object.fromEntries(CODES.map((c) => [c, overlayErrorKey(c)]))).toEqual(VOICE_TYPING_OVERLAY);
    expect(overlayErrorKey(null)).toBe("voiceTyping.error");
    // A start failure's raw message (String(e)) is not a code.
    expect(overlayErrorKey("Error: connection refused")).toBe("voiceTyping.error");
  });

  it("upload: local failures", () => {
    expect({
      local: localUploadErrorKey("local"),
      "local-memory": localUploadErrorKey("local-memory"),
      "local-missing": localUploadErrorKey("local-missing"),
    }).toEqual(UPLOAD_LOCAL_FAILURE);
    // The upload path classifies the rejection message, not a code.
    expect(localFailureCode("whisper: not enough memory to load")).toBe("local-memory");
    expect(localFailureCode("model x is not downloaded")).toBe("local-missing");
    expect(localFailureCode("decoder crashed")).toBe("local");
  });
});
