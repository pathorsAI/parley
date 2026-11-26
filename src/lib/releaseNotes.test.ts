import { describe, it, expect, vi } from "vitest";
import { resolveInstalledReleaseNotes, type ReleaseNotes } from "./releaseNotes";

const empty: ReleaseNotes = { version: "0.37.8", body: "" };

describe("resolveInstalledReleaseNotes", () => {
  it("keeps notes that already have a body without fetching", async () => {
    const fetchFor = vi.fn();
    const notes = { version: "0.37.8", body: "- fixed things" };
    await expect(resolveInstalledReleaseNotes(notes, fetchFor)).resolves.toEqual(notes);
    expect(fetchFor).not.toHaveBeenCalled();
  });

  it("fills an empty body from the GitHub release for that exact version", async () => {
    const fetchFor = vi.fn(async () => ({ version: "0.37.8", body: "- from GitHub", url: "https://example.test/r" }));
    await expect(resolveInstalledReleaseNotes(empty, fetchFor)).resolves.toMatchObject({
      version: "0.37.8",
      body: "- from GitHub",
    });
    expect(fetchFor).toHaveBeenCalledWith("0.37.8");
  });

  it("returns null (no blank dialog) when GitHub has no body either", async () => {
    const fetchFor = vi.fn(async () => ({ version: "0.37.8", body: "  \n" }));
    await expect(resolveInstalledReleaseNotes(empty, fetchFor)).resolves.toBeNull();
  });

  it("returns null when the lookup fails", async () => {
    const fetchFor = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(resolveInstalledReleaseNotes(empty, fetchFor)).resolves.toBeNull();
  });
});
