import { describe, expect, it } from "vitest";
import {
  DEFAULT_ICON_NAME,
  ICON_NAMES,
  ICON_REGISTRY,
  LEGACY_EMOJI_MAP,
  resolveIcon,
} from "./icons";

describe("resolveIcon", () => {
  it("returns the registry entry for a known name", () => {
    expect(resolveIcon("handshake")).toBe(ICON_REGISTRY.handshake);
    expect(resolveIcon("graduation-cap")).toBe(ICON_REGISTRY["graduation-cap"]);
  });

  it("maps legacy emoji onto their registry entry", () => {
    expect(resolveIcon("🎯")).toBe(ICON_REGISTRY.target);
    expect(resolveIcon("🤝")).toBe(ICON_REGISTRY.handshake);
    expect(resolveIcon("⚖️")).toBe(ICON_REGISTRY.scale);
    expect(resolveIcon("🚀")).toBe(ICON_REGISTRY.rocket);
    expect(resolveIcon("🔁")).toBe(ICON_REGISTRY["rotate-ccw"]);
    expect(resolveIcon("🎓")).toBe(ICON_REGISTRY["graduation-cap"]);
  });

  it("falls back to the default for an unknown string", () => {
    expect(resolveIcon("not-an-icon")).toBe(ICON_REGISTRY[DEFAULT_ICON_NAME]);
    expect(resolveIcon("🦄")).toBe(ICON_REGISTRY[DEFAULT_ICON_NAME]);
  });

  it("falls back to the default for undefined or blank", () => {
    expect(resolveIcon(undefined)).toBe(ICON_REGISTRY[DEFAULT_ICON_NAME]);
    expect(resolveIcon("")).toBe(ICON_REGISTRY[DEFAULT_ICON_NAME]);
    expect(resolveIcon("   ")).toBe(ICON_REGISTRY[DEFAULT_ICON_NAME]);
  });

  it("never returns undefined", () => {
    for (const input of ["handshake", "🎯", "junk", "", "  target  "]) {
      expect(resolveIcon(input)).toBeTypeOf("object");
    }
  });
});

describe("ICON_REGISTRY", () => {
  it("contains the default and exposes its keys in order", () => {
    expect(ICON_REGISTRY[DEFAULT_ICON_NAME]).toBeDefined();
    expect(ICON_NAMES).toEqual(Object.keys(ICON_REGISTRY));
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(18);
  });

  it("every legacy emoji points at a real registry entry", () => {
    for (const [emoji, name] of Object.entries(LEGACY_EMOJI_MAP)) {
      expect(ICON_REGISTRY[name], `${emoji} -> ${name}`).toBeDefined();
    }
  });
});
