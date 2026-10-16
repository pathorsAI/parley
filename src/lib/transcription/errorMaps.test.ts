import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../nav/settings", () => ({ openSettings: vi.fn() }));

import { blockMessageKey, failureMessageKey, isLocalFailureCode } from "./errors";
import { localFailureCode } from "./localModels";

// Every transcription failure code a surface can receive, and the i18n key it
// shows for it — pinned as literal tables. They were recorded from the four
// per-surface maps this module replaced (tauriEvents' meeting://error map,
// localAlerts' local-failure toasts, the voice-typing overlay's ERROR_KEYS, the
// upload's local-failure messages), so they prove the merged lookups return
// exactly the same keys. Codes come from the backend (`meeting://error`,
// `voicetyping://error`, local_stt::failure_code) and from the start gates
// ("no-key", "no-local-model").
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

/** Start-gate refusals per surface (start.ts toasts, the overlay's codes,
 *  ingest.ts's thrown messages) — the behavior tests in meeting/start.test.ts,
 *  voiceTyping/host.test.ts and replay/ingest*.test.ts pin the same texts end
 *  to end. */
const START_BLOCKS = {
  meeting: {
    "no-key": "meeting.error.noSttKey",
    signin: "meeting.error.signin",
    "no-local-model": "localStt.error.notReady",
  },
  voiceTyping: { "no-key": "voiceTyping.noKey", "no-local-model": "voiceTyping.noLocalModel" },
  upload: {
    "no-key": "ingest.error.noSttKey",
    "no-local-model": "localStt.error.notReadyUpload",
    "no-upload": "ingest.error.providerNoUpload",
  },
};

describe("transcription error messages", () => {
  it("meeting://error toasts", () => {
    expect(Object.fromEntries(CODES.map((c) => [c, failureMessageKey("meeting", c)]))).toEqual(MEETING_ERROR_TOAST);
    expect(CODES.filter(isLocalFailureCode)).toEqual(["local", "local-memory", "local-missing"]);
  });

  it("voice-typing overlay errors", () => {
    expect(Object.fromEntries(CODES.map((c) => [c, failureMessageKey("voiceTyping", c)]))).toEqual(
      VOICE_TYPING_OVERLAY,
    );
    expect(failureMessageKey("voiceTyping", null)).toBe("voiceTyping.error");
    // A start failure's raw message (String(e)) is not a code.
    expect(failureMessageKey("voiceTyping", "Error: connection refused")).toBe("voiceTyping.error");
  });

  it("the overlay shows a start block exactly as the voice-typing gate names it", () => {
    for (const [code, key] of Object.entries(START_BLOCKS.voiceTyping)) {
      expect(failureMessageKey("voiceTyping", code)).toBe(key);
    }
  });

  it("start blocks", () => {
    expect({
      meeting: {
        "no-key": blockMessageKey("meeting", "no-key"),
        signin: blockMessageKey("meeting", "signin"),
        "no-local-model": blockMessageKey("meeting", "no-local-model"),
      },
      voiceTyping: {
        "no-key": blockMessageKey("voiceTyping", "no-key"),
        "no-local-model": blockMessageKey("voiceTyping", "no-local-model"),
      },
      upload: {
        "no-key": blockMessageKey("upload", "no-key"),
        "no-local-model": blockMessageKey("upload", "no-local-model"),
        "no-upload": blockMessageKey("upload", "no-upload"),
      },
    }).toEqual(START_BLOCKS);
  });

  it("upload: local failures", () => {
    expect({
      local: failureMessageKey("upload", "local"),
      "local-memory": failureMessageKey("upload", "local-memory"),
      "local-missing": failureMessageKey("upload", "local-missing"),
    }).toEqual(UPLOAD_LOCAL_FAILURE);
    // Only local failures are translated on upload; anything else keeps the
    // backend's message.
    expect(failureMessageKey("upload", "quota")).toBeNull();
    // The upload path classifies the rejection message, not a code.
    expect(localFailureCode("whisper: not enough memory to load")).toBe("local-memory");
    expect(localFailureCode("model x is not downloaded")).toBe("local-missing");
    expect(localFailureCode("decoder crashed")).toBe("local");
  });
});
