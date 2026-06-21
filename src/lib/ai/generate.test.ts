import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerceToSchema } from "./generate";

// The deterministic salvage behind streamObjectResilient/generateObjectResilient:
// it rescues a structured call whose output was generated but didn't conform —
// most often a drifted wrapper key in json_object mode (Groq gpt-oss emitting
// {"moments":[…]} for a {"events":[…]} schema). No LLM round-trip.

const schema = z.object({
  events: z.array(z.object({ title: z.string(), n: z.number() })),
});

describe("coerceToSchema", () => {
  it("passes through output that already matches the schema", () => {
    const v = { events: [{ title: "a", n: 1 }] };
    expect(coerceToSchema(v, schema)).toEqual(v);
  });

  it("remaps a drifted single wrapper key onto the schema's key", () => {
    // The exact gpt-oss-on-Groq failure: right data under "moments", not "events".
    const drifted = { moments: [{ title: "a", n: 1 }, { title: "b", n: 2 }] };
    expect(coerceToSchema(drifted, schema)).toEqual({
      events: [{ title: "a", n: 1 }, { title: "b", n: 2 }],
    });
  });

  it("still validates element shape after remapping (rejects bad elements)", () => {
    const drifted = { moments: [{ title: "a" /* missing n */ }] };
    expect(coerceToSchema(drifted, schema)).toBeNull();
  });

  it("won't guess when there are multiple arrays (ambiguous)", () => {
    expect(coerceToSchema({ a: [{ title: "x", n: 1 }], b: [] }, schema)).toBeNull();
  });

  it("returns null for non-objects / no array payload", () => {
    expect(coerceToSchema(null, schema)).toBeNull();
    expect(coerceToSchema("nope", schema)).toBeNull();
    expect(coerceToSchema({ events: "not-an-array" }, schema)).toBeNull();
  });
});
