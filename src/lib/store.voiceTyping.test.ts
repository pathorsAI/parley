import { describe, it, expect, vi } from "vitest";

// The migration and the default it falls back to are both platform-dependent,
// and `DEFAULT_VOICE_TYPING_SHORTCUT` is evaluated once at module load — so
// each platform needs its own module instance rather than a mock flipped
// mid-file.
async function loadStore(mac: boolean) {
  vi.resetModules();
  vi.doMock("./platform", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./platform")>();
    return { ...actual, isMac: () => mac, isWindows: () => !mac };
  });
  return await import("./store");
}

describe("migrateVoiceTypingShortcut", () => {
  it("leaves every saved trigger alone on macOS", async () => {
    const { migrateVoiceTypingShortcut } = await loadStore(true);
    expect(migrateVoiceTypingShortcut("alt-space")).toBe("alt-space");
    expect(migrateVoiceTypingShortcut("fn")).toBe("fn");
    expect(migrateVoiceTypingShortcut("right-option")).toBe("right-option");
    expect(migrateVoiceTypingShortcut("combo:super+KeyJ")).toBe("combo:super+KeyJ");
  });

  it("moves a Windows install off the old alt-space default", async () => {
    const { migrateVoiceTypingShortcut, DEFAULT_VOICE_TYPING_SHORTCUT } = await loadStore(false);
    // Alt+Space is the native window system menu on Windows: honouring the
    // persisted value would leave upgraders with dictation that never fires.
    expect(migrateVoiceTypingShortcut("alt-space")).toBe(DEFAULT_VOICE_TYPING_SHORTCUT);
    expect(DEFAULT_VOICE_TYPING_SHORTCUT).toBe("combo:control+alt+Space");
  });

  it("moves a Windows install off the macOS modifier-key triggers", async () => {
    const { migrateVoiceTypingShortcut, DEFAULT_VOICE_TYPING_SHORTCUT } = await loadStore(false);
    // These ride a CGEventTap; the Windows backend cannot register them, so a
    // value synced off a Mac would be a dead trigger.
    for (const id of ["fn", "right-option", "right-command", "right-control"] as const) {
      expect(migrateVoiceTypingShortcut(id)).toBe(DEFAULT_VOICE_TYPING_SHORTCUT);
    }
  });

  it("keeps a combo the Windows user recorded themselves", async () => {
    const { migrateVoiceTypingShortcut } = await loadStore(false);
    expect(migrateVoiceTypingShortcut("combo:control+shift+KeyD")).toBe("combo:control+shift+KeyD");
  });

  it("falls back to the platform default when nothing is persisted", async () => {
    const win = await loadStore(false);
    expect(win.migrateVoiceTypingShortcut(undefined)).toBe(win.DEFAULT_VOICE_TYPING_SHORTCUT);
    const mac = await loadStore(true);
    expect(mac.migrateVoiceTypingShortcut(undefined)).toBe("alt-space");
  });
});
