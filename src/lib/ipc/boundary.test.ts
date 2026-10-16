import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "./commands";

// The IPC boundary: every Tauri command and event goes through src/lib/ipc.
// Components and lib modules call `ipc.someCommand(…)` / `listenEvent(…)`;
// none of them reaches for `invoke` / `listen` / `emit` itself, so the
// command and event contract is written down exactly once.

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const IPC_DIR = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every `@tauri-apps/api/<module>` binding a file pulls in — static
 *  `import { a, b } from …` and dynamic `const { a } = await import(…)`. */
function tauriApiBindings(text: string, module: "core" | "event"): string[] {
  const spec = `"@tauri-apps/api/${module}"`;
  const names: string[] = [];
  const staticImport = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${spec}`, "g");
  const dynamicImport = new RegExp(String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${spec}\s*\)`, "g");
  for (const re of [staticImport, dynamicImport]) {
    for (const m of text.matchAll(re)) {
      names.push(...m[1].split(",").map((n) => n.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean));
    }
  }
  // A namespace or default import would hide what it uses — flag it whole.
  if (new RegExp(String.raw`import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*${spec}`).test(text)) names.push("*");
  return names;
}

const outsideIpc = sourceFiles(SRC).filter((f) => !f.startsWith(IPC_DIR));
const rel = (f: string) => relative(SRC, f).split(sep).join("/");

describe("IPC boundary", () => {
  it("scans the app sources", () => {
    expect(outsideIpc.length).toBeGreaterThan(100);
  });

  it("only src/lib/ipc calls invoke (core is otherwise used for convertFileSrc only)", () => {
    const offenders = outsideIpc.flatMap((f) =>
      tauriApiBindings(readFileSync(f, "utf8"), "core")
        .filter((name) => name !== "convertFileSrc")
        .map((name) => `${rel(f)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("only src/lib/ipc subscribes to or emits events", () => {
    const offenders = outsideIpc.flatMap((f) =>
      tauriApiBindings(readFileSync(f, "utf8"), "event").map((name) => `${rel(f)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the guard itself sees a violation", () => {
    expect(tauriApiBindings(`import { invoke } from "@tauri-apps/api/core";`, "core")).toEqual(["invoke"]);
    expect(tauriApiBindings(`const { listen } = await import("@tauri-apps/api/event");`, "event")).toEqual(["listen"]);
    expect(tauriApiBindings(`import * as core from "@tauri-apps/api/core";`, "core")).toEqual(["*"]);
  });
});

describe("IPC command contract", () => {
  // Every command a call site uses has exactly one typed function, named
  // after it — the name the function invokes, pinned so a rename on either
  // side shows up here.
  it("names each function after its command", () => {
    const src = readFileSync(join(IPC_DIR, "commands.ts"), "utf8");
    const pairs = [...src.matchAll(/export const (\w+) = \([^)]*\)[^=]*=>\s*invoke<[^>]*>\("([a-z0-9_]+)"/gs)].map(
      (m) => [m[1], m[2]] as const,
    );
    const camel = (cmd: string) => cmd.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    expect(pairs.length).toBe(Object.keys(commands).filter((k) => typeof (commands as Record<string, unknown>)[k] === "function").length);
    for (const [fn, cmd] of pairs) expect(fn).toBe(camel(cmd));
    expect(new Set(pairs.map(([, cmd]) => cmd)).size).toBe(pairs.length);
  });
});
