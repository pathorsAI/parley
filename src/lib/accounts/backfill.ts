import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { log } from "../log";
import { recordLlmUsage } from "../usage/log";
import type { Settings } from "../types";
import type { Claim } from "./types";
import type { StageBundle } from "./bundles";
import { slotQueryMatches } from "./slotState";

/**
 * Board-open backfill (#146): one-shot LLM classification of cards that the
 * coarse query pre-attached but nothing has slot-tagged yet. Results write
 * back into `Claim.slotIds` (the caller applies them via the store), so a
 * card is only ever sent once per stage — no new cards, no re-run. Cards that
 * fill nothing get the `<stage>.none` sentinel: done for THIS stage, still
 * classifiable when the thread reaches a later stage.
 */

/** Sentinel marking "classified for this stage, fills no slot". */
export function slotNoneSentinel(stage: string): string {
  return `${stage}.none`;
}

/**
 * Cards worth sending: active, coarse-query hit on some slot of this bundle,
 * and never classified for this stage (no `<stage>.`-prefixed id yet).
 */
export function eligibleForBackfill(claims: Claim[], bundle: StageBundle): Claim[] {
  const prefix = `${bundle.stage}.`;
  return claims.filter(
    (c) =>
      c.status === "active" &&
      !c.slotIds?.some((id) => id.startsWith(prefix)) &&
      bundle.slots.some((s) => slotQueryMatches(c, s))
  );
}

const assignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      claimId: z.string().describe("id of a claim from the provided list"),
      slotIds: z
        .array(z.string())
        .describe("slot ids this claim fills, ONLY from the provided slot list; empty if none"),
    })
  ),
});

const SYSTEM =
  "You classify sales-intelligence claims onto a stage gap-board. For EVERY claim in the list, " +
  "decide which of the provided slots it fills (most fill one, some several, some none). " +
  "Judge by meaning, not keywords; when in doubt, leave the claim unassigned rather than " +
  "forcing a fit." +
  JSON_MODE_INSTRUCTION;

/** In-flight dedup so a double board-open doesn't fire two identical calls. */
const inflight = new Map<string, Promise<{ claimId: string; slotIds: string[] }[]>>();

/**
 * Classify eligible cards for this bundle. Returns the FULL new `slotIds`
 * value per touched claim (existing other-stage ids preserved, `<stage>.none`
 * for the unassigned) — apply with `updateClaim(id, { slotIds })`.
 */
export async function backfillSlotIds(opts: {
  settings: Settings;
  bundle: StageBundle;
  claims: Claim[];
}): Promise<{ claimId: string; slotIds: string[] }[]> {
  const { settings, bundle, claims } = opts;
  const eligible = eligibleForBackfill(claims, bundle);
  if (!eligible.length) return [];

  const key =
    bundle.stage +
    "|" +
    bundle.slots.map((s) => s.id).join(",") +
    "|" +
    eligible
      .map((c) => c.id)
      .sort((a, b) => a.localeCompare(b))
      .join(",");
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const slotLines = bundle.slots.map((s) => `- ${s.id}: ${s.label} — ${s.hint}`).join("\n");
    const claimLines = eligible
      .map(
        (c) =>
          `[${c.id}] (${c.category}${c.side ? `/${c.side}` : ""}${c.layer ? `/${c.layer}` : ""}) ${c.text}`
      )
      .join("\n");
    const { object, usage } = await generateObjectResilient({
      settings,
      workload: "deep",
      schema: assignmentsSchema,
      system: SYSTEM,
      prompt: `Slots:\n${slotLines}\n\nClaims to classify:\n${claimLines}`,
    });
    void recordLlmUsage(settings, "deep", "accounts-slot-backfill", usage);

    // Normalize against what we offered; unmentioned claims count as "none".
    const knownSlots = new Set(bundle.slots.map((s) => s.id));
    const byClaim = new Map(
      object.assignments.map((a) => [a.claimId, a.slotIds.filter((id) => knownSlots.has(id))])
    );
    const out = eligible.map((c) => {
      const assigned = byClaim.get(c.id) ?? [];
      const merged = [
        ...(c.slotIds ?? []),
        ...(assigned.length ? assigned : [slotNoneSentinel(bundle.stage)]),
      ];
      return { claimId: c.id, slotIds: [...new Set(merged)] };
    });
    log.info("accounts: slot backfill classified", {
      stage: bundle.stage,
      sent: eligible.length,
      assigned: out.filter((o) => !o.slotIds.every((id) => id.endsWith(".none"))).length,
    });
    return out;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}
