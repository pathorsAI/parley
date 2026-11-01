// `tauri build` refuses to run when a Tauri package's npm version and its Rust
// crate differ in major or minor:
//
//     Found version mismatched Tauri packages.
//     tauri-plugin-notification (v2.4.0) : @tauri-apps/plugin-notification (v2.8.0)
//
// Nothing else enforces that. `cargo clippy` never reads package.json and
// `tauri dev` only warns, so before this check the gate first ran when a tag
// was already pushed — which is how v0.35.0 and v0.35.1 became two version
// numbers that built nothing (#657). Here the same rule is applied to the two
// lockfiles, which both record exact resolved versions, so it costs seconds and
// needs no install: it runs in the unit suite and as the release workflow's
// first job.
//
// Deliberately not compared: crates with no npm counterpart
// (tauri-plugin-single-instance, tauri-plugin-autostart) and @tauri-apps/cli,
// which ships as a binary and has no crate in this tree.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The npm package whose crate is `tauri` itself rather than `tauri-<name>`. */
const API_PACKAGE = "@tauri-apps/api";

/**
 * Resolved versions of every @tauri-apps package, read from bun.lock's package
 * table — the entries shaped `"@tauri-apps/x": ["@tauri-apps/x@1.2.3", …]`.
 * The workspace's own dependency block lists ranges ("^2") instead of an array,
 * so it cannot match.
 *
 * @param {string} lock
 * @returns {Map<string, string>}
 */
export function npmVersions(lock) {
  const found = new Map();
  const entry = /"(@tauri-apps\/[^"]+)":\s*\["@tauri-apps\/[^"@]+@([^"]+)"/g;
  for (const [, name, version] of lock.matchAll(entry)) found.set(name, version);
  return found;
}

/**
 * Versions of every crate in Cargo.lock, by name.
 *
 * @param {string} lock
 * @returns {Map<string, string>}
 */
export function crateVersions(lock) {
  const found = new Map();
  const entry = /\[\[package\]\]\s*\nname = "([^"]+)"\nversion = "([^"]+)"/g;
  for (const [, name, version] of lock.matchAll(entry)) found.set(name, version);
  return found;
}

/** The crate a Tauri npm package must stay in step with, or null when it has
 *  none. @param {string} pkg @returns {string | null} */
function crateFor(pkg) {
  if (pkg === API_PACKAGE) return "tauri";
  const plugin = /^@tauri-apps\/(plugin-[a-z0-9-]+)$/.exec(pkg);
  return plugin ? `tauri-${plugin[1]}` : null;
}

/** What the Tauri CLI compares: the major and minor, never the patch. */
function sameMinor(a, b) {
  const [aMajor, aMinor] = a.split(".");
  const [bMajor, bMinor] = b.split(".");
  return aMajor === bMajor && aMinor === bMinor;
}

/**
 * @typedef {{ pkg: string, npm: string, crate: string, crateVersion: string }} Mismatch
 */

/**
 * Every Tauri package whose npm and crate versions would stop `tauri build`.
 *
 * Throws when the two lockfiles yield no comparable pair at all: a check that
 * silently passes once a lockfile format changes is worse than none, because it
 * would hand the release workflow a green light it never earned.
 *
 * @param {string} bunLock
 * @param {string} cargoLock
 * @returns {Mismatch[]}
 */
export function tauriVersionMismatches(bunLock, cargoLock) {
  const npm = npmVersions(bunLock);
  const crates = crateVersions(cargoLock);

  const mismatches = [];
  let compared = 0;

  for (const [pkg, version] of [...npm].sort()) {
    const crate = crateFor(pkg);
    if (!crate) continue;
    const crateVersion = crates.get(crate);
    if (!crateVersion) continue;
    compared += 1;
    if (!sameMinor(version, crateVersion)) {
      mismatches.push({ pkg, npm: version, crate, crateVersion });
    }
  }

  if (compared === 0) {
    throw new Error(
      "No @tauri-apps package could be paired with a crate: " +
        `${npm.size} npm entries, ${crates.size} crates. ` +
        "One of the lockfile formats changed — fix this check before trusting it.",
    );
  }

  return mismatches;
}

/** The same, for this repository's own lockfiles. @returns {Mismatch[]} */
export function checkRepo() {
  return tauriVersionMismatches(
    fs.readFileSync(path.join(REPO, "bun.lock"), "utf8"),
    fs.readFileSync(path.join(REPO, "src-tauri", "Cargo.lock"), "utf8"),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let mismatches;
  try {
    mismatches = checkRepo();
  } catch (error) {
    console.error(`::error title=Tauri version check is broken::${error.message}`);
    process.exit(1);
  }

  if (mismatches.length > 0) {
    for (const { pkg, npm, crate, crateVersion } of mismatches) {
      console.error(
        `::error title=Tauri version mismatch::${crate} (v${crateVersion}) : ${pkg} (v${npm}) — ` +
          "tauri build refuses this. Pin the npm range in package.json to the crate's minor, " +
          "or move the crate in src-tauri/Cargo.toml to match.",
      );
    }
    process.exit(1);
  }

  console.log("Tauri npm packages and crates are in step.");
}
