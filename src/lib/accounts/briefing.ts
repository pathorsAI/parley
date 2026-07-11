import { streamText } from "ai";
import { getModel, getProviderOptions } from "../ai/provider";
import { profileContext, outputLanguageInstruction } from "../ai/profile";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
import type { Settings } from "../types";
import type { Claim, Company, Person, Thread } from "./types";

/**
 * Battle briefing (design §4.2): render the claim base into the prose war
 * report the user actually reads before/around a battle. The DOCUMENT is an
 * output artifact — corrections always go to the claims, never to the prose.
 */

const SYSTEM = `You are a senior sales strategist writing a BATTLE BRIEFING for ME about one customer/partner company, from a structured claim base (each claim carries its category and freshness).

Write dense, candid Markdown with exactly these sections:

## 人物盤點與立場
Per key person: role, stance, deep motives/fears, and what winning them unlocks. Merge claims about the same person.

## 籌碼對比
Their cards vs our cards. Call out time-pressure asymmetries, anchors, and BATNA lines explicitly.

## 雙方目標（表面 vs 深層）
Surface positions vs deep intent, both sides.

## 風險與紅線
Risks ranked by severity; then the red lines (information we must NOT reveal) as an explicit list.

## 下一步的槓桿順序
A SEQUENCED play — what to do first and why, not a flat todo list.

Rules: ground every statement in the provided claims — no invention; where claims conflict, present both and say which looks stronger and why; flag stale claims (old lastSupported dates) as "需要再驗證"; mark inferred-only claims with (推測). Write in the claims' language.`;

function claimLines(claims: Claim[], persons: Person[]): string {
  const nameOf = (id: string) =>
    persons.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  return claims
    .map((c) => {
      const subj = c.subjects.length ? ` @${c.subjects.map(nameOf).join(",")}` : "";
      const side = c.side ? ` side=${c.side}` : "";
      const layer = c.layer ? ` layer=${c.layer}` : "";
      const fresh = new Date(c.lastSupportedAt).toISOString().slice(0, 10);
      return `- [${c.category}${side}${layer}] (${c.confidence}, ${fresh})${subj} ${c.text}`;
    })
    .join("\n");
}

export async function generateBattleBriefing(opts: {
  settings: Settings;
  company: Company;
  persons: Person[];
  threads: Thread[];
  claims: Claim[];
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, company, persons, threads, claims, onDelta, signal } = opts;

  const roster = persons
    .filter((p) => !p.archived)
    .map((p) => `- ${p.name}${p.title ? `（${p.title}）` : ""}${p.committeeRole ? ` [${p.committeeRole}]` : ""}`)
    .join("\n");
  const threadLines = threads
    .map((t) => `- ${t.name}: ${t.kind}${t.stage ? `/${t.stage}` : ""} (${t.status})`)
    .join("\n");

  const prompt =
    profileContext(settings) +
    `Company: ${company.name}${company.note ? ` — ${company.note}` : ""}\n\n` +
    (roster ? `People:\n${roster}\n\n` : "") +
    (threadLines ? `Threads:\n${threadLines}\n\n` : "") +
    `Claims:\n${claimLines(claims, persons)}`;

  log.info("accounts: briefing start", { company: company.name, claims: claims.length });
  let full = "";
  const result = streamText({
    model: getModel(settings, "ask"),
    providerOptions: getProviderOptions(settings, "ask"),
    system: SYSTEM + outputLanguageInstruction(settings),
    abortSignal: signal,
    prompt,
  });
  for await (const delta of result.textStream) {
    full += delta;
    onDelta(delta);
  }
  void (async () => {
    try {
      await recordLlmUsage(settings, "ask", "accounts-briefing", await result.usage);
    } catch {
      /* best-effort usage logging */
    }
  })();
  log.info("accounts: briefing ok", { chars: full.length });
  return full;
}
