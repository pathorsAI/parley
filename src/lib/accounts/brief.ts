import { translate } from "../../i18n/messages";
import type { AppLanguage } from "../types";
import type { Claim, Company, Person, Thread } from "./types";

/**
 * Compose the pre-meeting brief (design §5.2): a deterministic assembly of the
 * linked thread + attendee profiles + company-level intel into the per-meeting
 * context text. Pure TS — no LLM call — so it's instant, predictable, and free.
 * The user can still edit the result by hand.
 */

const STAGE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closing: "Closing",
};

function pick(claims: Claim[], category: Claim["category"], n: number, extra?: (c: Claim) => boolean): Claim[] {
  return claims
    .filter((c) => c.category === category && (extra ? extra(c) : true))
    .sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)
    .slice(0, n);
}

function bullet(claims: Claim[]): string {
  return claims.map((c) => `- ${c.text}`).join("\n");
}

export function composeBrief(opts: {
  language: AppLanguage;
  company: Company;
  thread: Thread | null;
  attendees: Person[];
  /** Active claims of the company (thread-level + company-level). */
  claims: Claim[];
}): string {
  const { language, company, thread, attendees, claims } = opts;
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const parts: string[] = [];

  // Who we're meeting.
  const head = [`${t("accounts.brief.company")}: ${company.name}`];
  if (company.note) head.push(company.note);
  if (thread) {
    const stage = thread.stage ? `｜${STAGE_LABEL[thread.stage] ?? thread.stage}` : "";
    head.push(`${t("accounts.brief.thread")}: ${thread.name}（${thread.kind}${stage}）`);
    if (thread.expectedCloseAt) {
      head.push(
        `${t("accounts.brief.expectedClose")}: ${new Date(thread.expectedCloseAt).toISOString().slice(0, 10)}`
      );
    }
  }
  parts.push(head.join("\n"));

  // Attendees with their sharpest intel.
  if (attendees.length) {
    const lines = attendees.map((p) => {
      const bits: string[] = [];
      if (p.title) bits.push(p.title);
      if (p.committeeRole) bits.push(t(`accounts.role.${p.committeeRole}`));
      if (p.stance) bits.push(t(`accounts.stance.${p.stance.value}`));
      const about = claims.filter(
        (c) => c.subjects.includes(p.id) && ["stance", "goal", "risk"].includes(c.category)
      );
      const top = about.sort((a, b) => b.lastSupportedAt - a.lastSupportedAt).slice(0, 2);
      const detail = top.length ? `\n${top.map((c) => `  · ${c.text}`).join("\n")}` : "";
      return `- ${p.name}${bits.length ? `（${bits.join("・")}）` : ""}${detail}`;
    });
    parts.push(`${t("accounts.brief.attendees")}:\n${lines.join("\n")}`);
  }

  // The battlefield: leverage, goals, risks.
  const ourCards = pick(claims, "leverage", 3, (c) => c.side === "ours");
  const theirCards = pick(claims, "leverage", 3, (c) => c.side === "theirs");
  if (ourCards.length || theirCards.length) {
    const seg: string[] = [];
    if (ourCards.length) seg.push(`${t("accounts.brief.oursLeverage")}:\n${bullet(ourCards)}`);
    if (theirCards.length) seg.push(`${t("accounts.brief.theirsLeverage")}:\n${bullet(theirCards)}`);
    parts.push(seg.join("\n"));
  }
  const risks = pick(claims, "risk", 3);
  if (risks.length) parts.push(`${t("accounts.brief.risks")}:\n${bullet(risks)}`);

  // Red lines — spelled out so they're in front of the user's eyes pre-call.
  const redlines = pick(claims, "redline", 5);
  if (redlines.length) parts.push(`⚠️ ${t("accounts.brief.redlines")}:\n${bullet(redlines)}`);

  // Open questions to chase this meeting.
  const openqs = pick(claims, "openq", 6);
  if (openqs.length) parts.push(`${t("accounts.brief.openq")}:\n${bullet(openqs)}`);

  return parts.join("\n\n");
}
