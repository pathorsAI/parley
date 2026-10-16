import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import type { Settings, SttProviderId } from "../types";
import {
  FALLBACK_STT_PROVIDER,
  STT_BY_ID,
  STT_PROVIDERS,
  sttApiKey,
  sttBatchUrl,
  sttLabel,
  sttModel,
  sttRelayUrl,
  sttRequiresAccount,
  usesCloudSession,
  usesLocalModel,
} from "./providers";
import { PROVIDERS } from "../ai/providers";
import { DEFAULT_LOCAL_STT_MODEL, LOCAL_STT_API_KEY } from "./localModels";
import { translate, type TranslationKey } from "../../i18n/messages";

const base = useStore.getState().settings;
const settingsFor = (over: Partial<Settings>): Settings => ({ ...base, ...over });

describe("local STT provider", () => {
  it("is registered keyless, without diarization, with upload support", () => {
    const local = STT_BY_ID.local;
    expect(STT_PROVIDERS.some((p) => p.id === "local")).toBe(true);
    expect(local.apiKeyField).toBeNull();
    expect(local.diarization).toBe(false);
    expect(local.supportsFileUpload).toBe(true);
  });

  it("sttApiKey returns the sentinel so the existing key gates pass", () => {
    expect(sttApiKey(settingsFor({ transcriptionProvider: "local" }), "local")).toBe(LOCAL_STT_API_KEY);
    expect(LOCAL_STT_API_KEY.trim()).not.toBe("");
  });

  it("sends the selected model id, and no relay or batch URL", () => {
    const s = settingsFor({ transcriptionProvider: "local", localSttModel: "breeze-asr-25-q5_0" });
    expect(sttModel(s, "local")).toBe("breeze-asr-25-q5_0");
    expect(sttRelayUrl("local", "meeting")).toBeUndefined();
    expect(sttBatchUrl("local")).toBeUndefined();
  });

  it("other providers keep sending no model and their own trimmed key", () => {
    const s = settingsFor({ transcriptionProvider: "soniox", sonioxApiKey: " k \n" });
    expect(sttModel(s, "soniox")).toBeNull();
    expect(sttApiKey(s, "soniox")).toBe("k");
  });

  it("defaults the setting to the recommended model", () => {
    expect(base.localSttModel).toBe(DEFAULT_LOCAL_STT_MODEL);
  });

  it("has a translated label; brand providers keep their brand name", () => {
    const zh = sttLabel((k: TranslationKey) => translate("zh-TW", k), STT_BY_ID.local);
    const en = sttLabel((k: TranslationKey) => translate("en", k), STT_BY_ID.local);
    expect(en).toBe("Local (whisper.cpp)");
    expect(zh).toContain("whisper.cpp");
    expect(zh).not.toBe(en);
    expect(sttLabel((k) => k, STT_BY_ID.soniox)).toBe("Soniox");
  });
});

// The capability columns every caller branches on instead of provider ids.
describe("STT registry capabilities", () => {
  it("pins each provider's credential, account and endpoint columns", () => {
    const rows = Object.fromEntries(
      STT_PROVIDERS.map((p) => [
        p.id,
        { credential: p.credential, requiresAccount: p.requiresAccount, relay: !!p.relayPath, batch: !!p.batchPath },
      ]),
    );
    const byok = { credential: "apiKey", requiresAccount: false, relay: false, batch: false };
    expect(rows).toEqual({
      soniox: byok,
      deepgram: byok,
      assemblyai: byok,
      openai: byok,
      gemini: byok,
      parley: { credential: "cloudSession", requiresAccount: true, relay: true, batch: true },
      local: { credential: "localModel", requiresAccount: false, relay: false, batch: false },
    });
  });

  it("gives every key-based provider a key field", () => {
    for (const p of STT_PROVIDERS.filter((x) => x.credential === "apiKey")) {
      expect(p.apiKeyField, p.id).toBeTruthy();
    }
  });

  it("answers the capability checks per id, and nothing for an unknown id", () => {
    expect(STT_PROVIDERS.filter((p) => usesLocalModel(p.id)).map((p) => p.id)).toEqual(["local"]);
    expect(STT_PROVIDERS.filter((p) => usesCloudSession(p.id)).map((p) => p.id)).toEqual(["parley"]);
    expect(STT_PROVIDERS.filter((p) => sttRequiresAccount(p.id)).map((p) => p.id)).toEqual(["parley"]);
    const unknown = "whisper-cloud" as SttProviderId;
    expect(usesLocalModel(unknown)).toBe(false);
    expect(usesCloudSession(unknown)).toBe(false);
    expect(sttRequiresAccount(unknown)).toBe(false);
  });

  it("resolves the hosted credential from the cloud session", () => {
    useStore.setState({ cloudAuth: null });
    expect(sttApiKey(base, "parley")).toBe("");
    useStore.setState({
      cloudAuth: { token: "sess_9", user: { id: "u", name: "n", email: "e@x" }, activeOrganizationId: null },
    });
    expect(sttApiKey(base, "parley")).toBe("sess_9");
    expect(sttModel(base, "parley")).toBeNull();
    useStore.setState({ cloudAuth: null });
  });

  it("an LLM provider is account-only exactly when it is hosted Parley", () => {
    expect(PROVIDERS.filter((p) => p.requiresAccount).map((p) => p.id)).toEqual(["parley"]);
  });
});

describe("signing out", () => {
  const session = { token: "sess_1", user: { id: "u", name: "n", email: "e@x" }, activeOrganizationId: null };

  it("moves an account-only STT selection to the BYOK fallback", () => {
    useStore.setState({ cloudAuth: session, settings: { ...base, transcriptionProvider: "parley" } });
    useStore.getState().setCloudAuth(null);
    expect(useStore.getState().settings.transcriptionProvider).toBe("soniox");
    expect(FALLBACK_STT_PROVIDER).toBe("soniox");
  });

  it("leaves any other selection alone, and signing in changes nothing", () => {
    for (const id of ["local", "deepgram"] as const) {
      useStore.setState({ cloudAuth: session, settings: { ...base, transcriptionProvider: id } });
      useStore.getState().setCloudAuth(null);
      expect(useStore.getState().settings.transcriptionProvider).toBe(id);
    }
    useStore.setState({ cloudAuth: null, settings: { ...base, transcriptionProvider: "parley" } });
    useStore.getState().setCloudAuth(session);
    expect(useStore.getState().settings.transcriptionProvider).toBe("parley");
    useStore.setState({ cloudAuth: null, settings: base });
  });
});
