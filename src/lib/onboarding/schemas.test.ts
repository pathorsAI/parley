import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { zodSchema } from "ai";
import type { z } from "zod";
import { backgroundDraftSchema } from "./memoryImport";
import { introSchema, nameEditSchema } from "./micCheck";

describe("onboarding LLM schemas", () => {
  // A strict json_schema request with an optional field is refused upstream,
  // and the hosted model reports that as a 502 (no json_object fallback).
  it.each<[string, z.ZodType<object>]>([
    ["backgroundDraftSchema", backgroundDraftSchema],
    ["introSchema", introSchema],
    ["nameEditSchema", nameEditSchema],
  ])("%s requires every field", (_name, schema) => {
    const json = zodSchema(schema).jsonSchema as { properties: Record<string, unknown>; required?: string[] };
    expect([...(json.required ?? [])].sort()).toEqual(Object.keys(json.properties).sort());
  });
});
