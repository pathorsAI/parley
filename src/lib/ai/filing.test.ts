import { describe, expect, it } from "vitest";
import { resolveFilingFolders } from "./filing";

const folders = [
  { id: "f-acme", name: "Acme Corp" },
  { id: "f-hiring", name: "Hiring" },
  { id: "f-board", name: "Board" },
  { id: "f-ops", name: "Ops" },
];

/** Shorthand for one raw pick off the model. */
const pick = (name: string, isNew = false, reason = "fits") => ({ name, isNew, reason });

describe("resolveFilingFolders", () => {
  it("matches an existing folder by exact name", () => {
    expect(resolveFilingFolders([pick("Acme Corp")], folders)).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("matches case- and whitespace-insensitively, keeping the registry's spelling", () => {
    expect(resolveFilingFolders([pick("  acme CORP ")], folders)).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("treats a name matching nothing as a new folder", () => {
    expect(resolveFilingFolders([pick("Globex")], folders)).toEqual([
      { folderId: null, name: "Globex", reason: "fits" },
    ]);
  });

  it("resolves to the existing folder even when the model claims it is new", () => {
    expect(resolveFilingFolders([pick("Hiring", true)], folders)).toEqual([
      { folderId: "f-hiring", name: "Hiring", reason: "fits" },
    ]);
  });

  it("keeps only the first new-folder suggestion", () => {
    const out = resolveFilingFolders(
      [pick("Globex", true), pick("Initech", true), pick("Acme Corp")],
      folders
    );
    expect(out).toEqual([
      { folderId: null, name: "Globex", reason: "fits" },
      { folderId: "f-acme", name: "Acme Corp", reason: "fits" },
    ]);
  });

  it("collapses duplicate folder ids to one entry", () => {
    const out = resolveFilingFolders(
      [pick("Acme Corp", false, "customer"), pick("acme corp", true, "same again"), pick("Ops")],
      folders
    );
    expect(out).toEqual([
      { folderId: "f-acme", name: "Acme Corp", reason: "customer" },
      { folderId: "f-ops", name: "Ops", reason: "fits" },
    ]);
  });

  it("caps at three entries, preserving the model's order", () => {
    const out = resolveFilingFolders(
      [pick("Acme Corp"), pick("Hiring"), pick("Board"), pick("Ops")],
      folders
    );
    expect(out.map((f) => f.folderId)).toEqual(["f-acme", "f-hiring", "f-board"]);
  });

  it("drops empty and whitespace-only names", () => {
    const out = resolveFilingFolders([pick(""), pick("   "), pick("Board")], folders);
    expect(out).toEqual([{ folderId: "f-board", name: "Board", reason: "fits" }]);
  });

  it("trims the reason and allows an empty one", () => {
    expect(resolveFilingFolders([pick("Board", false, "  ongoing governance  ")], folders)).toEqual([
      { folderId: "f-board", name: "Board", reason: "ongoing governance" },
    ]);
    expect(resolveFilingFolders([pick("Board", false, "   ")], folders)).toEqual([
      { folderId: "f-board", name: "Board", reason: "" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(resolveFilingFolders([], folders)).toEqual([]);
    expect(resolveFilingFolders([], [])).toEqual([]);
  });
});
