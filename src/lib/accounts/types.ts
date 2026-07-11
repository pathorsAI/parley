// Domain types for the accounts & intel layer (mini-CRM).
// Design: docs/design/mini-crm.md — entities stay thin, analysis lives in
// atomic intel CLAIMS with provenance; entity fields like a person's stance
// are projection caches whose source of truth is the claim base.

/** A company (or any organization on the battlefield: partner, competitor, channel). */
export interface Company {
  id: string;
  name: string;
  /** Alternate spellings/nicknames, used to match transcript mentions. */
  aliases: string[];
  /** One-line positioning, free text. */
  note: string;
  /** Reserved for a future one-way push to an external CRM (design D1). */
  externalCrmId?: string;
  createdAt: number;
  archived: boolean;
}

/** Buying-committee role, MEDDICC vocabulary. */
export type CommitteeRole =
  | "economic"
  | "champion"
  | "influencer"
  | "user"
  | "gatekeeper"
  | "blocker";

/** A person, belonging to exactly one company (design D5). */
export interface Person {
  id: string;
  companyId: string;
  name: string;
  aliases: string[];
  /** Title / department, free text. */
  title: string;
  /** Projection cache — updated by the review flow, backed by claims. */
  committeeRole?: CommitteeRole;
  /** Projection cache of the newest active stance claim. */
  stance?: {
    value: "support" | "neutral" | "oppose";
    confidence: "confirmed" | "inferred";
    updatedAt: number;
  };
  /** Who this person listens to (design D5: a field, not a graph). */
  influencedBy: string[];
  createdAt: number;
  archived: boolean;
}

/** What kind of battle a thread is (design D3). Only "sales" carries a pipeline stage. */
export type ThreadKind = "sales" | "channel" | "investment" | "other";

/** Sales-pipeline stage for sales-kind threads. */
export type SalesStage = "discovery" | "demo" | "proposal" | "negotiation" | "closing";

/** A thread (戰線): one of possibly several parallel battles under a company. */
export interface Thread {
  id: string;
  companyId: string;
  /** Other organizations party to this thread and their role (cross-company
   *  meetings, design D2 — e.g. distributor + end customer). */
  companyRoles: {
    companyId: string;
    role: "customer" | "distributor" | "partner" | "competitor";
  }[];
  kind: ThreadKind;
  name: string;
  status: "active" | "won" | "lost" | "parked";
  /** Only meaningful when kind === "sales". */
  stage?: SalesStage;
  /** Free-form stage description for non-sales threads. */
  customStatus?: string;
  /** Expected signing date (design D4 — no amount field). */
  expectedCloseAt?: number;
  /** Buying committee on THIS thread (may differ from Person.committeeRole). */
  committee: { personId: string; role: CommitteeRole }[];
  createdAt: number;
}

/** The nine claim categories distilled from the reference battle reports. */
export type ClaimCategory =
  | "stance" // 立場（含深層動機、恐懼、談判習慣）
  | "relation" // 關係邊（誰投資誰、誰牽線誰、老同事）
  | "leverage" // 籌碼（side: ours|theirs；含 BATNA、時間壓力、錨）
  | "goal" // 目標（side × layer: surface|deep）
  | "risk" // 風險（收編、定價陷阱、合約、現金流）
  | "redline" // 紅線：不可揭露／不可越 → live guardrail
  | "competitor" // 競情（價目、強弱點、攻擊點）
  | "nextmove" // 下一步（有順序邏輯的行動）
  | "openq"; // 待查證（缺的情報、互相矛盾的資訊）

export type ClaimConfidence = "confirmed" | "inferred" | "conflicted";

/** Where a claim came from. A claim accumulates provenance as evidence arrives. */
export type ClaimProvenance =
  | { kind: "meeting"; historyId: string; quote: string; atMs?: number }
  | { kind: "import"; attachmentId: string; quote?: string }
  | { kind: "user" };

/** One atomic intel claim — the unit everything else projects from. */
export interface Claim {
  id: string;
  companyId: string;
  /** Absent = a company-level claim not tied to any thread (design D3). */
  threadId?: string;
  /** personIds / companyIds this claim is about (may be several). */
  subjects: string[];
  category: ClaimCategory;
  /** For leverage / goal claims. */
  side?: "ours" | "theirs";
  /** For goal claims. */
  layer?: "surface" | "deep";
  /** The claim itself — one sentence, one assertion. */
  text: string;
  provenance: ClaimProvenance[];
  confidence: ClaimConfidence;
  /** Wrong/superseded claims are KEPT (so "why did we believe this" survives). */
  status: "active" | "superseded" | "wrong";
  supersededBy?: string;
  conflictsWith?: string[];
  createdAt: number;
  /** Freshness: when evidence last supported this claim (design D6). */
  lastSupportedAt: number;
}

/** Pasted source material attached to a company (notes, chat logs, old analyses). */
export interface CompanyAttachment {
  id: string;
  companyId: string;
  name: string;
  kind: "note" | "chatlog" | "doc";
  text: string;
  createdAt: number;
}

/** The whole persisted accounts file (config-dir accounts.json). */
export interface AccountsData {
  companies: Company[];
  persons: Person[];
  threads: Thread[];
  claims: Claim[];
  attachments: CompanyAttachment[];
}

export const EMPTY_ACCOUNTS: AccountsData = {
  companies: [],
  persons: [],
  threads: [],
  claims: [],
  attachments: [],
};

export const CLAIM_CATEGORIES: ClaimCategory[] = [
  "stance",
  "relation",
  "leverage",
  "goal",
  "risk",
  "redline",
  "competitor",
  "nextmove",
  "openq",
];

export const COMMITTEE_ROLES: CommitteeRole[] = [
  "economic",
  "champion",
  "influencer",
  "user",
  "gatekeeper",
  "blocker",
];

export const SALES_STAGES: SalesStage[] = [
  "discovery",
  "demo",
  "proposal",
  "negotiation",
  "closing",
];

export const THREAD_KINDS: ThreadKind[] = ["sales", "channel", "investment", "other"];

/** Does this person's name/alias match a (possibly partial) mention? */
export function personMatches(p: Person, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return [p.name, ...p.aliases].some((a) => {
    const b = a.trim().toLowerCase();
    return !!b && (b === n || b.includes(n) || n.includes(b));
  });
}
