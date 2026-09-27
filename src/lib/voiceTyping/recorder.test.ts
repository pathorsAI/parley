import { describe, expect, it } from "vitest";
import { loneModifierRelease } from "./recorder";

/**
 * Releasing a lone modifier in the push-to-talk recorder either picks it as a
 * hold-to-talk key or explains why it can't be one — and which keys qualify
 * depends on the keyboard the platform has.
 */

const MAC = true;
const PC = false;
const WINDOWS_HINT = { hint: "settings.voiceTyping.recorder.modifierAloneWindows" };
const LEFT_HINT = { hint: "settings.voiceTyping.recorder.leftModifier" };

describe("loneModifierRelease", () => {
  it("selects right Ctrl and right Alt on both platforms", () => {
    for (const mac of [MAC, PC]) {
      expect(loneModifierRelease("ControlRight", mac)).toEqual({ select: "right-control" });
      expect(loneModifierRelease("AltRight", mac)).toEqual({ select: "right-option" });
    }
  });

  it("selects right ⌘ on macOS but explains it on Windows, where it is the Windows key", () => {
    expect(loneModifierRelease("MetaRight", MAC)).toEqual({ select: "right-command" });
    expect(loneModifierRelease("MetaRight", PC)).toEqual(WINDOWS_HINT);
  });

  it("points left-side keys and Shift at the right-side keys", () => {
    for (const code of ["ControlLeft", "AltLeft", "MetaLeft", "ShiftLeft", "ShiftRight"]) {
      expect(loneModifierRelease(code, MAC)).toEqual(LEFT_HINT);
      expect(loneModifierRelease(code, PC)).toEqual(WINDOWS_HINT);
    }
  });

  it("stays quiet on macOS for modifiers without a left/right story", () => {
    expect(loneModifierRelease("CapsLock", MAC)).toBeNull();
    expect(loneModifierRelease("CapsLock", PC)).toEqual(WINDOWS_HINT);
  });

  it("ignores keys that are not modifiers at all", () => {
    for (const mac of [MAC, PC]) {
      expect(loneModifierRelease("KeyD", mac)).toBeNull();
      expect(loneModifierRelease("Space", mac)).toBeNull();
    }
  });
});
