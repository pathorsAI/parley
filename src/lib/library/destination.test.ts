import { describe, it, expect } from "vitest";
import {
  PERSONAL_ROOT,
  parseDestination,
  personalDestination,
  sameDestination,
  serializeDestination,
  type LibraryDestination,
} from "./destination";

/** Every destination the pickers can produce, as a round-trip fixture. */
const CASES: LibraryDestination[] = [
  PERSONAL_ROOT,
  { scope: "personal", folderId: "fld-1" },
  { scope: "org", orgId: "org-1", folderId: null },
  { scope: "org", orgId: "org-1", folderId: "of-1" },
];

describe("destination serialization", () => {
  it.each(CASES)("round-trips %j", (d) => {
    expect(parseDestination(serializeDestination(d))).toEqual(d);
  });

  it("keeps an org root distinct from the personal root", () => {
    expect(serializeDestination({ scope: "org", orgId: "org-1", folderId: null })).not.toBe(
      serializeDestination(PERSONAL_ROOT)
    );
  });

  it("splits org id from folder id at the FIRST separator only", () => {
    // Ids are opaque; a value that already carries a colon must not shift the
    // boundary and silently address a different org.
    expect(parseDestination("o:org-1:of:1")).toEqual({
      scope: "org",
      orgId: "org-1",
      folderId: "of:1",
    });
  });

  it("reads an unknown value as the personal root instead of throwing", () => {
    // A stale option value (a folder deleted on another device, say) must not
    // wedge the picker.
    expect(parseDestination("")).toEqual(PERSONAL_ROOT);
    expect(parseDestination("garbage")).toEqual(PERSONAL_ROOT);
  });

  it("treats a null folder id as the personal root", () => {
    expect(sameDestination(personalDestination(null), PERSONAL_ROOT)).toBe(true);
    expect(sameDestination(personalDestination("fld-1"), PERSONAL_ROOT)).toBe(false);
  });
});
