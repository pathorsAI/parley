import { create } from "zustand";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { log } from "../log";
import {
  EMPTY_ACCOUNTS,
  personMatches,
  type AccountsData,
  type Claim,
  type ClaimProvenance,
  type Company,
  type CompanyAttachment,
  type Person,
  type Thread,
} from "./types";

/**
 * Accounts (mini-CRM) store — separate from the main meeting store on purpose:
 * different lifecycle (survives meetings) and different persistence (the
 * config-dir accounts.json via read_accounts/write_accounts, same pattern as
 * templates.json). In the browser (dev preview) it falls back to localStorage.
 *
 * Writes are debounced; nothing is persisted until the initial load finished,
 * so a slow startup can never clobber the file with an empty state.
 */

const LS_KEY = "parley-accounts";
const SAVE_DEBOUNCE_MS = 800;

export interface ExtractedNewPerson {
  name: string;
  title: string;
  committeeRole: string;
  reason: string;
}

export interface ExtractedNewClaim {
  category: Claim["category"];
  text: string;
  /** Person/company NAMES (the model doesn't know our ids); resolved on apply. */
  subjects: string[];
  side: "ours" | "theirs" | "";
  layer: "surface" | "deep" | "";
  quote: string;
}

export interface ExtractedClaimUpdate {
  claimId: string;
  action: "support" | "supersede" | "conflict";
  /** For supersede: the corrected claim text. */
  newText: string;
  quote: string;
}

/** One extraction pass's proposals — reviewed item by item, never auto-applied. */
export interface ExtractedOps {
  newPersons: ExtractedNewPerson[];
  newClaims: ExtractedNewClaim[];
  claimUpdates: ExtractedClaimUpdate[];
}

interface AccountsState extends AccountsData {
  /** True once the initial read finished (persist writes are gated on it). */
  loaded: boolean;

  // companies
  addCompany: (fields: { name: string; note?: string; aliases?: string[] }) => Company;
  updateCompany: (id: string, patch: Partial<Omit<Company, "id">>) => void;
  archiveCompany: (id: string) => void;

  // persons
  addPerson: (fields: {
    companyId: string;
    name: string;
    title?: string;
    committeeRole?: Person["committeeRole"];
  }) => Person;
  updatePerson: (id: string, patch: Partial<Omit<Person, "id" | "companyId">>) => void;
  archivePerson: (id: string) => void;

  // threads
  addThread: (fields: {
    companyId: string;
    kind: Thread["kind"];
    name: string;
    stage?: Thread["stage"];
  }) => Thread;
  updateThread: (id: string, patch: Partial<Omit<Thread, "id" | "companyId">>) => void;

  // attachments
  addAttachment: (fields: {
    companyId: string;
    name: string;
    kind: CompanyAttachment["kind"];
    text: string;
  }) => CompanyAttachment;
  removeAttachment: (id: string) => void;

  // claims
  addClaim: (
    fields: Omit<Claim, "id" | "createdAt" | "lastSupportedAt" | "status"> &
      Partial<Pick<Claim, "status">>
  ) => Claim;
  updateClaim: (id: string, patch: Partial<Omit<Claim, "id" | "companyId">>) => void;
  /** User vouches for a claim: confidence → confirmed, user provenance appended. */
  confirmClaim: (id: string) => void;
  /** User rejects a claim: kept (status "wrong") so history survives. */
  markClaimWrong: (id: string) => void;

  /** Apply a REVIEWED extraction (only the approved ops reach here). */
  applyExtractedOps: (opts: {
    companyId: string;
    threadId?: string;
    ops: ExtractedOps;
    provenance: ClaimProvenance;
  }) => void;

  /** Replace everything (initial hydrate). */
  hydrate: (data: AccountsData) => void;
}

function now(): number {
  return Date.now();
}

export const useAccounts = create<AccountsState>()((set, get) => ({
  ...EMPTY_ACCOUNTS,
  loaded: false,

  addCompany: (fields) => {
    const company: Company = {
      id: crypto.randomUUID(),
      name: fields.name.trim(),
      aliases: fields.aliases ?? [],
      note: fields.note?.trim() ?? "",
      createdAt: now(),
      archived: false,
    };
    set((s) => ({ companies: [...s.companies, company] }));
    return company;
  },

  updateCompany: (id, patch) =>
    set((s) => ({
      companies: s.companies.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
    })),

  archiveCompany: (id) =>
    set((s) => ({
      companies: s.companies.map((c) => (c.id === id ? { ...c, archived: true } : c)),
    })),

  addPerson: (fields) => {
    const person: Person = {
      id: crypto.randomUUID(),
      companyId: fields.companyId,
      name: fields.name.trim(),
      aliases: [],
      title: fields.title?.trim() ?? "",
      committeeRole: fields.committeeRole,
      influencedBy: [],
      createdAt: now(),
      archived: false,
    };
    set((s) => ({ persons: [...s.persons, person] }));
    return person;
  },

  updatePerson: (id, patch) =>
    set((s) => ({
      persons: s.persons.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)),
    })),

  archivePerson: (id) =>
    set((s) => ({
      persons: s.persons.map((p) => (p.id === id ? { ...p, archived: true } : p)),
    })),

  addThread: (fields) => {
    const thread: Thread = {
      id: crypto.randomUUID(),
      companyId: fields.companyId,
      companyRoles: [],
      kind: fields.kind,
      name: fields.name.trim(),
      status: "active",
      stage: fields.kind === "sales" ? (fields.stage ?? "discovery") : undefined,
      committee: [],
      createdAt: now(),
    };
    set((s) => ({ threads: [...s.threads, thread] }));
    return thread;
  },

  updateThread: (id, patch) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? { ...t, ...patch, id: t.id } : t)),
    })),

  addAttachment: (fields) => {
    const attachment: CompanyAttachment = {
      id: crypto.randomUUID(),
      companyId: fields.companyId,
      name: fields.name.trim() || "untitled",
      kind: fields.kind,
      text: fields.text,
      createdAt: now(),
    };
    set((s) => ({ attachments: [...s.attachments, attachment] }));
    return attachment;
  },

  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),

  addClaim: (fields) => {
    const claim: Claim = {
      status: "active",
      ...fields,
      id: crypto.randomUUID(),
      createdAt: now(),
      lastSupportedAt: now(),
    };
    set((s) => ({ claims: [...s.claims, claim] }));
    syncStanceCache(claim, set, get);
    return claim;
  },

  updateClaim: (id, patch) =>
    set((s) => ({
      claims: s.claims.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
    })),

  confirmClaim: (id) =>
    set((s) => ({
      claims: s.claims.map((c) =>
        c.id === id
          ? {
              ...c,
              confidence: "confirmed" as const,
              provenance: [...c.provenance, { kind: "user" as const }],
              lastSupportedAt: now(),
            }
          : c
      ),
    })),

  markClaimWrong: (id) =>
    set((s) => {
      const target = s.claims.find((c) => c.id === id);
      return {
        claims: s.claims.map((c) => {
          if (c.id === id) return { ...c, status: "wrong" as const };
          // Killing one side of a conflict releases the survivor.
          if (target && c.conflictsWith?.includes(id)) {
            const rest = c.conflictsWith.filter((x) => x !== id);
            return {
              ...c,
              conflictsWith: rest,
              confidence: rest.length ? c.confidence : ("inferred" as const),
            };
          }
          return c;
        }),
      };
    }),

  applyExtractedOps: ({ companyId, threadId, ops, provenance }) => {
    const state = get();

    // 1. New persons (resolved first so new claims can reference them by name).
    const createdPersons: Person[] = ops.newPersons.map((np) => ({
      id: crypto.randomUUID(),
      companyId,
      name: np.name.trim(),
      aliases: [],
      title: np.title.trim(),
      committeeRole: isCommitteeRole(np.committeeRole) ? np.committeeRole : undefined,
      influencedBy: [],
      createdAt: now(),
      archived: false,
    }));

    const allPersons = [...state.persons, ...createdPersons];
    const companies = state.companies;

    const resolveSubject = (name: string): string | null => {
      const person = allPersons.find((p) => !p.archived && personMatches(p, name));
      if (person) return person.id;
      const company = companies.find(
        (c) => !c.archived && personMatches({ name: c.name, aliases: c.aliases } as Person, name)
      );
      return company ? company.id : null;
    };

    // 2. New claims.
    const createdClaims: Claim[] = ops.newClaims.map((nc) => ({
      id: crypto.randomUUID(),
      companyId,
      threadId,
      subjects: nc.subjects.map(resolveSubject).filter((x): x is string => !!x),
      category: nc.category,
      side: nc.side || undefined,
      layer: nc.layer || undefined,
      text: nc.text.trim(),
      provenance: [withQuote(provenance, nc.quote)],
      confidence: "inferred",
      status: "active",
      createdAt: now(),
      lastSupportedAt: now(),
    }));

    // 3. Updates to existing claims.
    let claims = [...state.claims, ...createdClaims];
    for (const up of ops.claimUpdates) {
      const target = claims.find((c) => c.id === up.claimId);
      if (!target) continue;
      if (up.action === "support") {
        claims = claims.map((c) =>
          c.id === target.id
            ? {
                ...c,
                provenance: [...c.provenance, withQuote(provenance, up.quote)],
                lastSupportedAt: now(),
              }
            : c
        );
      } else if (up.action === "supersede") {
        const replacement: Claim = {
          ...target,
          id: crypto.randomUUID(),
          text: (up.newText || target.text).trim(),
          provenance: [withQuote(provenance, up.quote)],
          confidence: "inferred",
          status: "active",
          conflictsWith: undefined,
          createdAt: now(),
          lastSupportedAt: now(),
        };
        claims = claims
          .map((c) =>
            c.id === target.id
              ? { ...c, status: "superseded" as const, supersededBy: replacement.id }
              : c
          )
          .concat(replacement);
      } else {
        // conflict: a fresh contradicting claim; both sides flagged for triage.
        const rival: Claim = {
          ...target,
          id: crypto.randomUUID(),
          text: (up.newText || up.quote).trim() || target.text,
          provenance: [withQuote(provenance, up.quote)],
          confidence: "conflicted",
          status: "active",
          conflictsWith: [target.id],
          createdAt: now(),
          lastSupportedAt: now(),
        };
        claims = claims
          .map((c) =>
            c.id === target.id
              ? {
                  ...c,
                  confidence: "conflicted" as const,
                  conflictsWith: [...(c.conflictsWith ?? []), rival.id],
                }
              : c
          )
          .concat(rival);
      }
    }

    set({ persons: allPersons, claims });
    for (const c of createdClaims) syncStanceCache(c, set, get);
  },

  hydrate: (data) =>
    set({
      companies: data.companies ?? [],
      persons: data.persons ?? [],
      threads: data.threads ?? [],
      claims: data.claims ?? [],
      attachments: data.attachments ?? [],
      loaded: true,
    }),
}));

function withQuote(p: ClaimProvenance, quote: string): ClaimProvenance {
  const q = quote.trim();
  if (!q) return p;
  if (p.kind === "meeting") return { ...p, quote: q };
  if (p.kind === "import") return { ...p, quote: q };
  return p;
}

function isCommitteeRole(v: string): v is NonNullable<Person["committeeRole"]> {
  return ["economic", "champion", "influencer", "user", "gatekeeper", "blocker"].includes(v);
}

/** Keep Person.stance (a projection cache) in step with a new stance claim. */
function syncStanceCache(
  claim: Claim,
  set: (fn: (s: AccountsState) => Partial<AccountsState>) => void,
  get: () => AccountsState
): void {
  if (claim.category !== "stance" || claim.status !== "active") return;
  const value = stanceValueFromText(claim.text);
  if (!value) return;
  const persons = get().persons;
  const targets = claim.subjects.filter((id) => persons.some((p) => p.id === id));
  if (!targets.length) return;
  set((s) => ({
    persons: s.persons.map((p) =>
      targets.includes(p.id)
        ? {
            ...p,
            stance: {
              value,
              confidence: claim.confidence === "confirmed" ? "confirmed" : "inferred",
              updatedAt: claim.lastSupportedAt,
            },
          }
        : p
    ),
  }));
}

/** Crude zh/en stance read from claim text — cache only; the claim stays canonical. */
function stanceValueFromText(text: string): "support" | "neutral" | "oppose" | null {
  const t = text.toLowerCase();
  if (/(反對|阻擋|抵制|blocker|oppos|resist|against)/.test(t)) return "oppose";
  if (/(支持|力挺|站我們|champion|support|sponsor|backing|想投資)/.test(t)) return "support";
  if (/(中立|觀望|neutral|undecided|on the fence)/.test(t)) return "neutral";
  return null;
}

// ── Persistence ────────────────────────────────────────────────────────────────

function dataOf(s: AccountsState): AccountsData {
  return {
    companies: s.companies,
    persons: s.persons,
    threads: s.threads,
    claims: s.claims,
    attachments: s.attachments,
  };
}

async function readFile(): Promise<string> {
  if (isTauri()) return await invoke<string>("read_accounts");
  return localStorage.getItem(LS_KEY) ?? "";
}

async function writeFile(json: string): Promise<void> {
  if (isTauri()) {
    await invoke("write_accounts", { json });
    return;
  }
  localStorage.setItem(LS_KEY, json);
}

let initStarted = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hydrate the store from disk once, then persist every change (debounced).
 * Mounted from the app root; safe to call more than once.
 */
export function initAccounts(): void {
  if (initStarted) return;
  initStarted = true;

  (async () => {
    try {
      const raw = await readFile();
      const data = raw.trim() ? (JSON.parse(raw) as AccountsData) : EMPTY_ACCOUNTS;
      useAccounts.getState().hydrate(data);
      log.info("accounts: loaded", {
        companies: data.companies?.length ?? 0,
        claims: data.claims?.length ?? 0,
      });
      // Pair every company with its history folder (companies created before
      // the pairing existed get theirs here). Dynamic import: folders.ts
      // imports this store, so a static edge would be a cycle.
      try {
        const { migrateCompanyFolders } = await import("./folders");
        migrateCompanyFolders();
      } catch (e) {
        log.warn("accounts: folder migration failed", { error: String(e) });
      }
    } catch (e) {
      log.error("accounts: load failed — starting empty, writes disabled", {
        error: String(e),
      });
      // loaded stays false → the subscription below never persists over the
      // (possibly fine) file that we merely failed to read.
      return;
    }

    useAccounts.subscribe((state, prev) => {
      if (!state.loaded) return;
      const unchanged =
        state.companies === prev.companies &&
        state.persons === prev.persons &&
        state.threads === prev.threads &&
        state.claims === prev.claims &&
        state.attachments === prev.attachments;
      if (unchanged) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        const json = JSON.stringify(dataOf(useAccounts.getState()));
        writeFile(json).catch((e) =>
          log.error("accounts: save failed", { error: String(e) })
        );
      }, SAVE_DEBOUNCE_MS);
    });

    // A pending debounce must not die with the window/webview — flush it when
    // the page unloads or is hidden (reload in dev, app quit in Tauri).
    const flush = () => {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      const json = JSON.stringify(dataOf(useAccounts.getState()));
      void writeFile(json).catch((e) =>
        log.error("accounts: flush save failed", { error: String(e) })
      );
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  })();
}

// ── Selectors (plain functions over the state) ────────────────────────────────

export function personsOf(s: AccountsState, companyId: string): Person[] {
  return s.persons.filter((p) => p.companyId === companyId && !p.archived);
}

export function threadsOf(s: AccountsState, companyId: string): Thread[] {
  return s.threads.filter((t) => t.companyId === companyId);
}

export function activeClaims(s: AccountsState, companyId: string): Claim[] {
  return s.claims.filter((c) => c.companyId === companyId && c.status === "active");
}

export function claimsAbout(s: AccountsState, subjectId: string): Claim[] {
  return s.claims.filter((c) => c.status === "active" && c.subjects.includes(subjectId));
}

export function claimsOfThread(s: AccountsState, threadId: string): Claim[] {
  return s.claims.filter((c) => c.status === "active" && c.threadId === threadId);
}

/** Conflicted claims + open questions — the "待釐清" strip. */
export function triageClaims(s: AccountsState, companyId: string): Claim[] {
  return activeClaims(s, companyId).filter(
    (c) => c.confidence === "conflicted" || c.category === "openq"
  );
}
