import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs build script with no type declarations.
import { rendered, TARGETS } from "../scripts/gen-study-prompt.mjs";

// shared/prompts/study.json is THE study-pipeline prompt set for every client.
// Desktop imports it directly; Android compiles a generated copy. This fails
// the build when someone edits the JSON without re-running
// `node scripts/gen-study-prompt.mjs`, which would otherwise ship a phone that
// analyses the same recording with different instructions than the desktop.
describe("generated study prompt copy", () => {
  const out = rendered() as Record<string, string>;
  for (const [key, rel] of Object.entries(TARGETS as Record<string, string>)) {
    it(`${rel} matches shared/prompts/study.json`, () => {
      const onDisk = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(onDisk, "stale — run node scripts/gen-study-prompt.mjs").toBe(out[key]);
    });
  }
});
