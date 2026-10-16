import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../dictionary", () => ({ recognitionTerms: () => ["Parley"] }));

import { useStore } from "../store";
import type { Settings, SttProviderId } from "../types";
import {
  meetingUsesRealPipeline,
  prepareTranscription,
  uploadPickBlock,
  type PrepareDeps,
  type TranscriptionKind,
} from "./prepare";

const base = useStore.getState().settings;
const settingsFor = (provider: SttProviderId, over: Partial<Settings> = {}): Settings => ({
  ...base,
  language: "en",
  transcriptionProvider: provider,
  localSttModel: "m1",
  ...over,
});

/** A fake world: inside Tauri or not, the credential each provider resolves
 *  to, and whether the on-device model is downloaded. */
function deps(opts: { tauri?: boolean; key?: string; localReady?: boolean } = {}): PrepareDeps & {
  checked: string[];
} {
  const checked: string[] = [];
  return {
    checked,
    isTauri: () => opts.tauri ?? true,
    apiKey: (_s, id) => (id === "local" ? "local" : (opts.key ?? "")),
    localModelReady: async (modelId) => {
      checked.push(modelId);
      return opts.localReady ?? false;
    },
  };
}

const KINDS: TranscriptionKind[] = ["meeting", "voiceTyping", "upload"];

describe("prepareTranscription", () => {
  it("refuses a missing credential with no-key on every kind (BYOK)", async () => {
    for (const kind of KINDS) {
      expect(await prepareTranscription(kind, settingsFor("soniox"), deps({ key: "  " }))).toEqual({
        ok: false,
        code: "no-key",
      });
    }
  });

  it("tells a signed-out hosted meeting to sign in; the other kinds say no-key", async () => {
    const s = settingsFor("parley");
    expect(await prepareTranscription("meeting", s, deps({ key: "" }))).toEqual({ ok: false, code: "signin" });
    expect(await prepareTranscription("voiceTyping", s, deps({ key: "" }))).toEqual({ ok: false, code: "no-key" });
    expect(await prepareTranscription("upload", s, deps({ key: "" }))).toEqual({ ok: false, code: "no-key" });
  });

  it("a meeting outside Tauri never gets the real pipeline, whatever the credential", async () => {
    expect(await prepareTranscription("meeting", settingsFor("soniox"), deps({ tauri: false, key: "k" }))).toEqual({
      ok: false,
      code: "no-key",
    });
    expect(await prepareTranscription("meeting", settingsFor("parley"), deps({ tauri: false, key: "tok" }))).toEqual({
      ok: false,
      code: "signin",
    });
    // …and skips the on-device model check (the dev build mocks the stream).
    const d = deps({ tauri: false });
    expect(await prepareTranscription("meeting", settingsFor("local"), d)).toEqual({ ok: false, code: "no-key" });
    expect(d.checked).toEqual([]);
  });

  it("the other kinds don't ask whether Tauri is there", async () => {
    for (const kind of ["voiceTyping", "upload"] as const) {
      const r = await prepareTranscription(kind, settingsFor("soniox"), deps({ tauri: false, key: "k" }));
      expect(r.ok).toBe(true);
    }
  });

  it("checks the selected on-device model on every kind", async () => {
    for (const kind of KINDS) {
      const missing = deps({ localReady: false });
      expect(await prepareTranscription(kind, settingsFor("local"), missing)).toEqual({
        ok: false,
        code: "no-local-model",
      });
      expect(missing.checked).toEqual(["m1"]);
      const ready = await prepareTranscription(kind, settingsFor("local"), deps({ localReady: true }));
      expect(ready.ok).toBe(true);
    }
  });

  it("answers synchronously unless an on-device model has to be checked", () => {
    expect(prepareTranscription("voiceTyping", settingsFor("soniox"), deps({ key: "k" }))).not.toBeInstanceOf(Promise);
    expect(prepareTranscription("voiceTyping", settingsFor("soniox"), deps({ key: "" }))).not.toBeInstanceOf(Promise);
    expect(prepareTranscription("voiceTyping", settingsFor("local"), deps())).toBeInstanceOf(Promise);
  });

  it("builds the request each kind's command needs", async () => {
    const s = settingsFor("parley");
    const meeting = await prepareTranscription("meeting", s, deps({ key: "tok" }));
    const voice = await prepareTranscription("voiceTyping", s, deps({ key: "tok" }));
    const upload = await prepareTranscription("upload", s, deps({ key: "tok" }));
    if (!meeting.ok || !voice.ok || !upload.ok) throw new Error("expected ok");
    expect(meeting.request).toMatchObject({
      provider: "parley",
      apiKey: "tok",
      model: null,
      diarization: true,
      relayUrl: expect.stringMatching(/\/stt\/v2\/stream\?feature=meeting$/),
      batchUrl: undefined,
      languageHints: ["en"],
      vocabulary: ["Parley"],
    });
    expect(voice.request.relayUrl).toMatch(/\?feature=voice_typing$/);
    expect(voice.request.batchUrl).toBeUndefined();
    expect(upload.request.relayUrl).toBeUndefined();
    expect(upload.request.batchUrl).toMatch(/\/stt\/batch$/);

    const local = await prepareTranscription("upload", settingsFor("local"), deps({ localReady: true }));
    if (!local.ok) throw new Error("expected ok");
    expect(local.request).toMatchObject({ provider: "local", apiKey: "local", model: "m1", diarization: false });
  });
});

describe("meetingUsesRealPipeline", () => {
  it("needs both the Tauri shell and a non-blank credential", () => {
    expect(meetingUsesRealPipeline(settingsFor("soniox"), deps({ key: "k" }))).toBe(true);
    expect(meetingUsesRealPipeline(settingsFor("soniox"), deps({ key: " " }))).toBe(false);
    expect(meetingUsesRealPipeline(settingsFor("soniox"), deps({ tauri: false, key: "k" }))).toBe(false);
    expect(meetingUsesRealPipeline(settingsFor("local"), deps())).toBe(true);
  });
});

describe("uploadPickBlock", () => {
  it("refuses a provider without batch support before looking at the credential", () => {
    expect(uploadPickBlock(settingsFor("gemini"), deps({ key: "" }))).toBe("no-upload");
    expect(uploadPickBlock(settingsFor("gemini"), deps({ key: "k" }))).toBe("no-upload");
  });

  it("then needs a credential", () => {
    expect(uploadPickBlock(settingsFor("soniox"), deps({ key: "" }))).toBe("no-key");
    expect(uploadPickBlock(settingsFor("soniox"), deps({ key: "k" }))).toBeNull();
    // The on-device model is checked when the transcription runs, not here.
    expect(uploadPickBlock(settingsFor("local"), deps())).toBeNull();
  });
});
