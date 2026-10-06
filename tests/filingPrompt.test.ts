import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs build script with no type declarations.
import { rendered, TARGETS } from "../scripts/gen-filing-prompt.mjs";

// shared/prompts/filing.json is THE title + filing prompt for every client.
// Desktop imports it directly; iOS and Android compile generated copies. This
// fails the build when someone edits the JSON without re-running
// `node scripts/gen-filing-prompt.mjs`, which would otherwise ship phones that
// quietly ask a different question than desktop does — and name the same
// recording differently.
describe("generated filing prompt copies", () => {
  const out = rendered() as Record<string, string>;
  for (const [key, rel] of Object.entries(TARGETS as Record<string, string>)) {
    it(`${rel} matches shared/prompts/filing.json`, () => {
      const onDisk = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(onDisk, "stale — run node scripts/gen-filing-prompt.mjs").toBe(out[key]);
    });
  }
});
