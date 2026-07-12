import { z } from "zod";
import { generateObjectResilient } from "../ai/generate";
import { JSON_MODE_INSTRUCTION } from "../ai/provider";
import { profileContext } from "../ai/profile";
import { log } from "../log";
import { recordLlmUsage } from "../usage/log";
import { translate, type TranslationKey } from "../../i18n/messages";
import type { Settings } from "../types";
import type { Claim, Company, Person, Thread } from "./types";
import type { ExtractedOps } from "./store";
import { readStageBundleOverrides, stageBundles, type SlotDef } from "./bundles";

/**
 * Claim extraction: one LLM pass over source material (a meeting transcript, a
 * pasted note/chat log) that PROPOSES operations against the company's claim
 * base. Nothing returned here is applied — the review dialog approves each op
 * (design D8), then `applyExtractedOps` performs the writes.
 */

const CATEGORY_ENUM = z.enum([
  "stance",
  "relation",
  "leverage",
  "goal",
  "risk",
  "redline",
  "competitor",
  "nextmove",
  "openq",
]);

const opsSchema = z.object({
  newPersons: z.array(
    z.object({
      name: z.string().describe("the person's name or clear alias as mentioned"),
      title: z.string().describe("title/department if known, else empty string"),
      committeeRole: z
        .string()
        .describe(
          "one of economic|champion|influencer|user|gatekeeper|blocker if clear, else empty string"
        ),
      reason: z.string().describe("one line: why this person matters, from the source"),
    })
  ),
  newClaims: z.array(
    z.object({
      category: CATEGORY_ENUM,
      text: z.string().describe("ONE assertion, one sentence, in the source's language"),
      subjects: z
        .array(z.string())
        .describe("names of the persons/companies this claim is about (may be empty)"),
      side: z.string().describe('"ours" or "theirs" for leverage/goal claims, else empty'),
      layer: z.string().describe('"surface" or "deep" for goal claims, else empty'),
      quote: z.string().describe("short verbatim quote from the source backing it, else empty"),
      slotIds: z
        .array(z.string())
        .describe(
          "ids of gap-board slots this claim fills, ONLY from the provided slot list; empty if none or no list given"
        ),
    })
  ),
  claimUpdates: z.array(
    z.object({
      claimId: z.string().describe("id of an EXISTING claim from the provided list"),
      action: z.enum(["support", "supersede", "conflict"]),
      newText: z.string().describe("for supersede: the corrected claim text, else empty"),
      quote: z.string().describe("short verbatim quote from the source, else empty"),
    })
  ),
});

const SYSTEM =
  "You maintain a sales-intelligence claim base about a customer/partner company. " +
  "Read the source material and propose operations: NEW claims for genuinely new intel, " +
  "SUPPORT when the source re-confirms an existing claim, SUPERSEDE when it corrects one, " +
  "CONFLICT when it contradicts one and both versions are plausible. " +
  "newPersons: enumerate EVERY distinct person who speaks in or is mentioned by the source and is " +
  "NOT already in the known-people list — colleagues, bosses, decision makers, third parties. Do not " +
  "stop at the most prominent one; a transcript naming four new people yields four entries. " +
  "Rules: one claim = one assertion; ground every claim in the source (no speculation); " +
  "professional judgments only — NEVER extract sensitive personal data (health, politics, " +
  "private life); prefer fewer, sharper claims over exhaustive noise; claims are written in " +
  "the source's language. Use category `redline` ONLY for information OUR side must not " +
  "reveal or lines we must not cross. Use `openq` for missing intel worth chasing AND for " +
  "unresolved contradictions." +
  JSON_MODE_INSTRUCTION;

/** Cap prompts; for meetings the tail matters most. */
function cap(text: string, max = 24_000): string {
  return text.length > max ? text.slice(-max) : text;
}

/** Compact one-line-per-claim digest so the model can support/supersede/conflict. */
function claimDigest(claims: Claim[]): string {
  return claims
    .filter((c) => c.status === "active")
    .map((c) => `[${c.id}] (${c.category}) ${c.text}`)
    .join("\n");
}

function rosterDigest(persons: Person[], threads: Thread[]): string {
  const people = persons
    .filter((p) => !p.archived)
    .map((p) => `- ${p.name}${p.title ? `（${p.title}）` : ""}`)
    .join("\n");
  const lines = threads.map((t) => `- ${t.name} (${t.kind}${t.stage ? `/${t.stage}` : ""})`);
  return (
    (people ? `Known people at this company:\n${people}\n\n` : "") +
    (lines.length ? `Known threads:\n${lines.join("\n")}\n\n` : "")
  );
}

/**
 * Gap-board slots to offer the model (#146): the linked thread's current
 * stage, or — for company-level feeds with no thread — every active sales
 * thread's stage, deduped (slot ids are stage-namespaced, so no collisions).
 */
async function slotsForExtraction(
  settings: Settings,
  threads: Thread[],
  threadId?: string
): Promise<SlotDef[]> {
  const relevant = (threadId ? threads.filter((t) => t.id === threadId) : threads).filter(
    (t) => t.kind === "sales" && t.stage && t.status === "active"
  );
  if (!relevant.length) return [];
  const t = (key: string) => translate(settings.language, key as TranslationKey);
  const bundles = stageBundles(t, await readStageBundleOverrides());
  const out = new Map<string, SlotDef>();
  for (const th of relevant) {
    for (const slot of bundles[th.stage!].slots) out.set(slot.id, slot);
  }
  return [...out.values()];
}

function slotDigest(slots: SlotDef[]): string {
  if (!slots.length) return "";
  const lines = slots.map((s) => `- ${s.id}: ${s.label} — ${s.hint}`);
  return (
    `Gap-board slots (tag each NEW claim with the slot ids it fills via slotIds; ` +
    `a claim may fill several, most fill one, leave empty when none apply):\n${lines.join("\n")}\n\n`
  );
}

export async function extractClaimOps(opts: {
  settings: Settings;
  company: Company;
  persons: Person[];
  threads: Thread[];
  existingClaims: Claim[];
  /** What we're reading: transcript text or pasted material. */
  sourceText: string;
  /** One line describing the source for the prompt (e.g. "meeting transcript"). */
  sourceLabel: string;
  /** Linked thread (post-meeting path) — scopes slot tagging to its stage. */
  threadId?: string;
}): Promise<ExtractedOps> {
  const { settings, company, persons, threads, existingClaims, sourceText, sourceLabel, threadId } =
    opts;

  const slots = await slotsForExtraction(settings, threads, threadId);
  const digest = claimDigest(existingClaims);
  const prompt =
    profileContext(settings) +
    `Company under analysis: ${company.name}${company.note ? ` — ${company.note}` : ""}\n\n` +
    rosterDigest(persons, threads) +
    slotDigest(slots) +
    (digest
      ? `EXISTING claims (reference these ids in claimUpdates; do NOT re-add them as new):\n${digest}\n\n`
      : "") +
    `Source (${sourceLabel}):\n${cap(sourceText)}`;

  const { object, usage } = await generateObjectResilient({
    settings,
    workload: "deep",
    schema: opsSchema,
    system: SYSTEM,
    prompt,
  });
  void recordLlmUsage(settings, "deep", "accounts-extract", usage);

  // Normalize: drop updates that point at unknown claims, clamp enums,
  // and keep only slot ids we actually offered (the model must not invent).
  const known = new Set(existingClaims.map((c) => c.id));
  const knownSlots = new Set(slots.map((s) => s.id));
  const ops: ExtractedOps = {
    newPersons: object.newPersons.filter((p) => p.name.trim()),
    newClaims: object.newClaims
      .filter((c) => c.text.trim())
      .map((c) => ({
        category: c.category,
        text: c.text,
        subjects: c.subjects,
        side: c.side === "ours" || c.side === "theirs" ? c.side : "",
        layer: c.layer === "surface" || c.layer === "deep" ? c.layer : "",
        quote: c.quote,
        slotIds: c.slotIds.filter((id) => knownSlots.has(id)),
      })),
    claimUpdates: object.claimUpdates.filter((u) => known.has(u.claimId)),
  };
  log.info("accounts: extraction proposed", {
    company: company.name,
    persons: ops.newPersons.length,
    claims: ops.newClaims.length,
    updates: ops.claimUpdates.length,
  });
  return ops;
}
