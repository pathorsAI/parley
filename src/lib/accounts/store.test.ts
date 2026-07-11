import { beforeEach, describe, expect, it } from "vitest";
import { conflictPairs, useAccounts } from "./store";
import { EMPTY_ACCOUNTS } from "./types";

/** Reset the accounts store between tests (bypasses persistence entirely). */
function reset() {
  useAccounts.setState({ ...EMPTY_ACCOUNTS, loaded: true, recentIngest: null });
}

describe("accounts store", () => {
  beforeEach(reset);

  it("creates entities and manual claims (user-asserted → confirmed)", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "AI3", note: "整合商" });
    const person = s.addPerson({ companyId: company.id, name: "Will", title: "業務" });
    const claim = s.addClaim({
      companyId: company.id,
      subjects: [person.id],
      category: "stance",
      text: "Will 反對倉促合作，把關風險",
      provenance: [{ kind: "user" }],
      confidence: "confirmed",
    });
    const state = useAccounts.getState();
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].status).toBe("active");
    expect(claim.lastSupportedAt).toBeGreaterThan(0);
    // Stance projection cache picked up the oppose-ish wording.
    expect(state.persons[0].stance?.value).toBe("oppose");
    expect(state.persons[0].stance?.confidence).toBe("confirmed");
  });

  it("applyExtractedOps resolves new-person names into claim subjects", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "喜來登" });
    s.applyExtractedOps({
      companyId: company.id,
      ops: {
        newPersons: [{ name: "Jamie", title: "總機副理", committeeRole: "champion", reason: "需求發起人" }],
        newClaims: [
          {
            category: "stance",
            text: "Jamie 是內部 champion，資訊毫不保留",
            subjects: ["Jamie"],
            side: "",
            layer: "",
            quote: "你 email 我我馬上回",
          },
        ],
        claimUpdates: [],
      },
      provenance: { kind: "import", attachmentId: "a1" },
    });
    const state = useAccounts.getState();
    const jamie = state.persons.find((p) => p.name === "Jamie");
    expect(jamie?.committeeRole).toBe("champion");
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].subjects).toEqual([jamie!.id]);
    expect(state.claims[0].confidence).toBe("inferred"); // imports are never confirmed
    const prov = state.claims[0].provenance[0];
    expect(prov.kind).toBe("import");
    expect(prov.kind === "import" && prov.quote).toBe("你 email 我我馬上回");
  });

  it("supersede keeps the old claim as history and links the replacement", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "喜來登" });
    const old = s.addClaim({
      companyId: company.id,
      subjects: [],
      category: "openq",
      text: "會議時間是週四早上 11 點",
      provenance: [{ kind: "user" }],
      confidence: "confirmed",
    });
    s.applyExtractedOps({
      companyId: company.id,
      ops: {
        newPersons: [],
        newClaims: [],
        claimUpdates: [
          { claimId: old.id, action: "supersede", newText: "會議改到週四下午 1 點半", quote: "" },
        ],
      },
      provenance: { kind: "meeting", historyId: "m1", quote: "" },
    });
    const state = useAccounts.getState();
    const oldNow = state.claims.find((c) => c.id === old.id)!;
    expect(oldNow.status).toBe("superseded");
    const replacement = state.claims.find((c) => c.id === oldNow.supersededBy)!;
    expect(replacement.status).toBe("active");
    expect(replacement.text).toBe("會議改到週四下午 1 點半");
  });

  it("conflict flags both sides; killing one releases the survivor", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "喜來登" });
    const original = s.addClaim({
      companyId: company.id,
      subjects: [],
      category: "openq",
      text: "Joyce 說會議是週四早上 11 點",
      provenance: [{ kind: "user" }],
      confidence: "confirmed",
    });
    s.applyExtractedOps({
      companyId: company.id,
      ops: {
        newPersons: [],
        newClaims: [],
        claimUpdates: [
          { claimId: original.id, action: "conflict", newText: "Jamie 說是週四下午 1 點半", quote: "" },
        ],
      },
      provenance: { kind: "meeting", historyId: "m2", quote: "" },
    });
    let state = useAccounts.getState();
    const a = state.claims.find((c) => c.id === original.id)!;
    const b = state.claims.find((c) => c.id !== original.id)!;
    expect(a.confidence).toBe("conflicted");
    expect(b.confidence).toBe("conflicted");
    expect(a.conflictsWith).toContain(b.id);
    expect(b.conflictsWith).toContain(a.id);

    // Triage: marking one side wrong releases the other back to inferred.
    state.markClaimWrong(a.id);
    state = useAccounts.getState();
    expect(state.claims.find((c) => c.id === a.id)!.status).toBe("wrong");
    const survivor = state.claims.find((c) => c.id === b.id)!;
    expect(survivor.conflictsWith).toEqual([]);
    expect(survivor.confidence).toBe("inferred");
  });

  it("archive → unarchive round-trips for companies and persons", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "AI3" });
    const person = s.addPerson({ companyId: company.id, name: "Will" });

    s.archiveCompany(company.id);
    s.archivePerson(person.id);
    let state = useAccounts.getState();
    expect(state.companies[0].archived).toBe(true);
    expect(state.persons[0].archived).toBe(true);

    state.unarchiveCompany(company.id);
    state.unarchivePerson(person.id);
    state = useAccounts.getState();
    expect(state.companies[0].archived).toBe(false);
    expect(state.persons[0].archived).toBe(false);
  });

  it("conflictPairs pairs both sides once, older claim first", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "喜來登" });
    const original = s.addClaim({
      companyId: company.id,
      subjects: [],
      category: "openq",
      text: "會議是週四早上 11 點",
      provenance: [{ kind: "user" }],
      confidence: "confirmed",
    });
    s.applyExtractedOps({
      companyId: company.id,
      ops: {
        newPersons: [],
        newClaims: [],
        claimUpdates: [
          { claimId: original.id, action: "conflict", newText: "是週四下午 1 點半", quote: "" },
        ],
      },
      provenance: { kind: "meeting", historyId: "m1", quote: "" },
    });
    let state = useAccounts.getState();
    const pairs = conflictPairs(state, company.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe(original.id); // older side first
    expect(pairs[0].b.conflictsWith).toContain(original.id);

    // The triage decision: keep the newer one → pair dissolves.
    state.markClaimWrong(original.id);
    state = useAccounts.getState();
    expect(conflictPairs(state, company.id)).toHaveLength(0);
  });

  it("applyExtractedOps leaves a transient recentIngest marker for the touched claims", () => {
    const s = useAccounts.getState();
    const company = s.addCompany({ name: "AI3" });
    expect(useAccounts.getState().recentIngest).toBeNull();
    s.applyExtractedOps({
      companyId: company.id,
      ops: {
        newPersons: [],
        newClaims: [
          { category: "goal", text: "Q3 要上白標", subjects: [], side: "theirs", layer: "surface", quote: "" },
        ],
        claimUpdates: [],
      },
      provenance: { kind: "import", attachmentId: "a1" },
    });
    const state = useAccounts.getState();
    const marker = state.recentIngest;
    expect(marker?.companyId).toBe(company.id);
    expect(marker?.claimIds).toEqual([state.claims[0].id]);

    state.clearRecentIngest();
    expect(useAccounts.getState().recentIngest).toBeNull();
  });
});
