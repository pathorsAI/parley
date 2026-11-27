import type { AiTaskSlots } from "./catalog";

/**
 * How a slot's user content is bounded and written into a variant's system
 * prompt. This file is the reference implementation of the rules the cloud
 * applies (shared/ai-tasks/tasks.generated.json `slotRendering` says the same
 * in words); the consistency test runs every call site through it.
 */
export type SlotDef =
  | {
      type: "string";
      /** Longer text is cut to this many UTF-16 code units after trimming. */
      maxChars: number;
      /** What `{{name}}` becomes when the value is not empty; `{{value}}` is the value. */
      template: string;
    }
  | {
      type: "string[]";
      /** Items past this many (after blank ones are dropped) are dropped. */
      maxItems: number;
      /** Longer items are cut to this many UTF-16 code units. */
      maxItemChars: number;
      /** Placed between items. */
      join: string;
      /** What `{{name}}` becomes when at least one item remains; `{{value}}` is the joined items. */
      template: string;
    };

/** Plain UTF-16 code-unit order — what a bare `.sort()` does — on every runtime. */
function byCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The variant key for a set of params: `k=v` pairs sorted by key, joined by commas; "" for none. */
export function variantKey(params: Record<string, string>): string {
  // Code-unit order, not localeCompare: the cloud (parley-internal
  // apps/cloud/src/aiTasks.ts) sorts with the default `.sort()`, which is the
  // same order on every runtime; a locale's order is not.
  return Object.keys(params)
    .sort(byCodeUnits)
    .map((k) => `${k}=${params[k]}`)
    .join(",");
}

/** One slot's rendered text: "" when the value is missing or empty after bounding. */
export function renderSlot(def: SlotDef, value: string | string[] | undefined): string {
  if (def.type === "string") {
    const text = typeof value === "string" ? value.trim().slice(0, def.maxChars) : "";
    return text ? def.template.replace("{{value}}", () => text) : "";
  }
  const items = (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, def.maxItems)
    .map((v) => v.slice(0, def.maxItemChars));
  return items.length ? def.template.replace("{{value}}", () => items.join(def.join)) : "";
}

/**
 * A variant's system prompt with every `{{slot}}` replaced in one pass (a
 * value that itself contains `{{…}}` is inserted verbatim). A placeholder with
 * no slot definition is an error: the registry must never ship one.
 */
export function fillTaskSystem(system: string, slotDefs: Record<string, SlotDef>, slots: AiTaskSlots): string {
  return system.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const def = slotDefs[name];
    if (!def) throw new Error(`ai task: no slot definition for {{${name}}}`);
    return renderSlot(def, slots[name]);
  });
}
