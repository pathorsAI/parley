// The npm/crate parity rule `tauri build` enforces
// (scripts/check-tauri-versions.mjs): this tree holds to it, and a tree that
// does not is caught here rather than after a tag is pushed (#657).
import { describe, expect, it } from "vitest";
import { checkRepo, tauriVersionMismatches } from "../scripts/check-tauri-versions.mjs";

/** bun.lock's package table, cut down to the entries this check reads. */
function bunLock(versions: Record<string, string>): string {
  const entries = Object.entries(versions)
    .map(([pkg, v]) => `    "${pkg}": ["${pkg}@${v}", "", {}, "sha512-x"],`)
    .join("\n");
  // The workspace block lists ranges, not resolved versions; it is here so the
  // parser is shown ignoring it.
  return `{
  "lockfileVersion": 1,
  "workspaces": { "": { "dependencies": { "@tauri-apps/api": "^2" } } },
  "packages": {
${entries}
  }
}`;
}

function cargoLock(versions: Record<string, string>): string {
  return Object.entries(versions)
    .map(([name, v]) => `[[package]]\nname = "${name}"\nversion = "${v}"\n`)
    .join("\n");
}

describe("this repository", () => {
  it("keeps every Tauri npm package in step with its crate", () => {
    expect(checkRepo()).toEqual([]);
  });
});

describe("tauriVersionMismatches", () => {
  it("catches the mismatch that cost v0.35.0 and v0.35.1", () => {
    const mismatches = tauriVersionMismatches(
      bunLock({ "@tauri-apps/api": "2.11.0", "@tauri-apps/plugin-notification": "2.8.0" }),
      cargoLock({ tauri: "2.11.2", "tauri-plugin-notification": "2.4.0" }),
    );

    expect(mismatches).toEqual([
      {
        pkg: "@tauri-apps/plugin-notification",
        npm: "2.8.0",
        crate: "tauri-plugin-notification",
        crateVersion: "2.4.0",
      },
    ]);
  });

  it("accepts a differing patch, which the Tauri CLI allows", () => {
    expect(
      tauriVersionMismatches(
        bunLock({ "@tauri-apps/api": "2.11.0" }),
        cargoLock({ tauri: "2.11.2" }),
      ),
    ).toEqual([]);
  });

  it("catches a major apart as readily as a minor", () => {
    expect(
      tauriVersionMismatches(
        bunLock({ "@tauri-apps/api": "3.0.0", "@tauri-apps/plugin-log": "2.8.0" }),
        cargoLock({ tauri: "2.11.2", "tauri-plugin-log": "2.8.1" }),
      ),
    ).toMatchObject([{ pkg: "@tauri-apps/api", crate: "tauri" }]);
  });

  /** The CLI ships as a prebuilt binary, and these two plugins are Rust-only:
   *  pairing them by name would compare versions nothing enforces. */
  it("leaves the CLI and the crate-only plugins alone", () => {
    expect(
      tauriVersionMismatches(
        bunLock({ "@tauri-apps/api": "2.11.0", "@tauri-apps/cli": "2.11.2" }),
        cargoLock({
          tauri: "2.11.2",
          "tauri-cli": "9.9.9",
          "tauri-plugin-single-instance": "2.5.0",
          "tauri-plugin-autostart": "2.5.1",
        }),
      ),
    ).toEqual([]);
  });

  it("refuses to pass when it can pair nothing, instead of passing vacuously", () => {
    expect(() => tauriVersionMismatches("{}", cargoLock({ tauri: "2.11.2" }))).toThrow(
      /lockfile formats changed|format changed/,
    );
  });
});
