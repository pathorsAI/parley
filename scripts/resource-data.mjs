//
// The part every bundled-resource generator has in common, whatever language
// the resource is for: where the generated tables live, how an upstream source
// is downloaded **at a pinned commit**, and the provenance block their headers
// end with.
//
// It exists because there are now two families of generator — the 注音 tables
// (`zhuyin-data.mjs`, `gen-zhuyin-dict.mjs`, `gen-zhuyin-phrases.mjs`) and the
// English word list (`gen-english-words.mjs`) — which share their plumbing and
// nothing else. `zhuyin-data.mjs` keeps everything that is actually about 注音
// (the symbol sets, syllable validation, the McBopomofo repository) and calls
// through to here for the rest, so neither family carries a copy of the other's.
//
// **Why a commit rather than a branch.** Each generator resolves a branch to a
// commit once, downloads every file from that commit, and stamps it into the
// output header. Re-running against an unchanged upstream therefore rewrites a
// byte-identical file, and a real upstream change shows up as a reviewable diff
// naming the commit it came from. Every source's license is reproduced in
// `ios/THIRD-PARTY.md`, which is the file to update when one is added.
//

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/// Where a generated table lives, so no generator has to know the layout.
export function resourcePath(name) {
  return join(root, "ios/ParleyKit/Sources/ParleyKit/Resources", name);
}

/// Resolve `branch` to a commit, then fetch every path in `files` at that one
/// commit. Returns the commit so the caller can stamp it into its header.
export async function downloadData({ repo, branch, files, prefix }) {
  const commit = await resolveCommit(repo, branch);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const texts = await Promise.all(
    files.map((path) => download(repo, commit, path, dir))
  );
  return { commit, texts };
}

async function resolveCommit(repo, branch) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits/${branch}`,
    { headers: { accept: "application/vnd.github.sha" } }
  );
  if (!res.ok) throw new Error(`resolving ${branch}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function download(repo, commit, path, dir) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const file = join(dir, path.replaceAll("/", "_"));
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return readFile(file, "utf8");
}

/// The provenance block every header ends with: what rebuilds the file, which
/// commit it came from, the per-generator license lines, and where the notices
/// are kept.
export function provenance({ repo, script, commit, sources }) {
  return [
    `# GENERATED — run scripts/${script} to rebuild; do not hand-edit.`,
    `# Source: https://github.com/${repo} @ ${commit}`,
    ...sources,
    "# See ios/THIRD-PARTY.md.",
  ];
}
