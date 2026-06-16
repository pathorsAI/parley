#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function usage() {
  console.error(`Usage:
  bun run release <version|major|minor|patch> --message "Release notes"
  bun run release <version|major|minor|patch> --notes-file ./notes.md

Examples:
  bun run release patch --message "Fix transcript sync and improve settings"
  bun run release 0.2.0 --notes-file ./release-notes.md

Set DRY_RUN=1 to preview without writing, committing, tagging, or pushing.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
}

function parseArgs(argv) {
  const [versionArg, ...rest] = argv;
  let message = "";
  let notesFile = "";

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--message" || arg === "-m") {
      message = rest[i + 1] ?? "";
      i += 1;
    } else if (arg === "--notes-file" || arg === "-f") {
      notesFile = rest[i + 1] ?? "";
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(1);
    }
  }

  return { versionArg, message, notesFile };
}

function bumpVersion(current, bump) {
  const parts = current.split(".").map((value) => Number.parseInt(value, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`Cannot bump invalid current version: ${current}`);
  }

  if (bump === "major") return `${parts[0] + 1}.0.0`;
  if (bump === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  if (bump === "patch") return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  return bump;
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Version must be semver like 0.2.0, major, minor, or patch. Got: ${version}`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function writeJson(file, value) {
  writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

function replacePackageVersion(file, version) {
  const fullPath = path.join(root, file);
  const source = readFileSync(fullPath, "utf8");
  const next = source.replace(/^version = "[^"]+"/m, `version = "${version}"`);

  if (next === source) {
    throw new Error(`Could not find package version in ${file}`);
  }

  writeFileSync(fullPath, next);
}

function ensureCleanWorktree() {
  const status = output("git", ["status", "--porcelain"]);
  if (status !== "") {
    console.error("Release requires a clean git worktree. Commit or stash current changes first.");
    console.error(status);
    process.exit(1);
  }
}

const { versionArg, message, notesFile } = parseArgs(process.argv.slice(2));

if (!versionArg || (!message && !notesFile)) {
  usage();
  process.exit(1);
}

const packageJson = readJson("package.json");
const nextVersion = bumpVersion(packageJson.version, versionArg);
assertSemver(nextVersion);

const tag = `v${nextVersion}`;
const releaseNotes = notesFile
  ? readFileSync(path.resolve(root, notesFile), "utf8").trim()
  : message.trim();

if (!releaseNotes) {
  console.error("Release notes cannot be empty.");
  process.exit(1);
}

if (output("git", ["tag", "--list", tag]) !== "") {
  console.error(`Tag already exists locally: ${tag}`);
  process.exit(1);
}

if (process.env.DRY_RUN === "1") {
  console.log(`Would release ${tag}`);
  console.log(releaseNotes);
  process.exit(0);
}

ensureCleanWorktree();

packageJson.version = nextVersion;
writeJson("package.json", packageJson);

const tauriConfig = readJson("src-tauri/tauri.conf.json");
tauriConfig.version = nextVersion;
writeJson("src-tauri/tauri.conf.json", tauriConfig);

replacePackageVersion("src-tauri/Cargo.toml", nextVersion);

run("bun", ["install", "--lockfile-only"]);
run("cargo", ["update", "-p", "parley", "--manifest-path", "src-tauri/Cargo.toml"]);

const notesDir = path.join(root, ".github", "release-notes");
if (!existsSync(notesDir)) {
  mkdirSync(notesDir, { recursive: true });
}
writeFileSync(path.join(notesDir, `${tag}.md`), `${releaseNotes}\n`);

run("git", [
  "add",
  "package.json",
  "bun.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  path.join(".github", "release-notes", `${tag}.md`),
]);
run("git", ["commit", "-m", `Release ${tag}`]);
run("git", ["tag", "-a", tag, "-m", releaseNotes]);
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);

console.log(`Released ${tag}. GitHub Actions will build the app and attach bundles to the draft release.`);
