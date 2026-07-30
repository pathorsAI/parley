import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
// Folder registry + cloud are I/O boundaries; stub them to fixed answers so the
// precedence itself is what's under test.
vi.mock("./folders", () => ({
  listLocalFolders: () => [
    { id: "fld-company", name: "Pathors AI", createdAt: 0 },
    { id: "fld-manual", name: "Q3 calls", createdAt: 0 },
  ],
}));
vi.mock("../cloud/client", () => ({
  syncEnabled: () => false,
  CLOUD_URL: "",
  cloudFetch: vi.fn(),
  cloudToken: () => null,
}));

import { resolveMeetingSave } from "./history";
import { useStore } from "../store";
import { useAccounts } from "../accounts/store";

const INITIAL = useStore.getState();
const INITIAL_ACCOUNTS = useAccounts.getState();

/** A company paired with fld-company, the way ensureCompanyFolder leaves it. */
function seedCompany() {
  useAccounts.setState({
    ...INITIAL_ACCOUNTS,
    companies: [
      {
        id: "co-1",
        name: "Pathors AI",
        aliases: [],
        note: "",
        folderId: "fld-company",
        createdAt: 0,
        archived: false,
      },
    ],
  });
}

beforeEach(() => {
  useStore.setState(INITIAL, true);
  useAccounts.setState(INITIAL_ACCOUNTS, true);
});

describe("resolveMeetingSave precedence", () => {
  it("falls back to the settings default when nothing else applies", () => {
    useStore.setState({
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "personal", folderId: "fld-manual" },
      },
    });
    expect(resolveMeetingSave()).toMatchObject({ folderId: "fld-manual", origin: "default" });
  });

  it("prefers the linked company's folder over the settings default", () => {
    seedCompany();
    useStore.setState({
      meetingCompanyId: "co-1",
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "personal", folderId: "fld-manual" },
      },
    });
    expect(resolveMeetingSave()).toMatchObject({ folderId: "fld-company", origin: "company" });
  });

  it("lets an explicit per-meeting override beat the company link", () => {
    seedCompany();
    useStore.setState({
      meetingCompanyId: "co-1",
      meetingSaveOverride: { scope: "personal", folderId: "fld-manual" },
    });
    expect(resolveMeetingSave()).toMatchObject({ folderId: "fld-manual", origin: "override" });
  });

  it("sends a company-linked meeting to the root when the paired folder is gone", () => {
    useAccounts.setState({
      ...INITIAL_ACCOUNTS,
      companies: [
        {
          id: "co-1",
          name: "Ghost Co",
          aliases: [],
          note: "",
          folderId: "fld-deleted",
          createdAt: 0,
          archived: false,
        },
      ],
    });
    useStore.setState({ meetingCompanyId: "co-1" });
    // No company folder → the default rule applies (root, since the default is
    // untouched), rather than writing to a folder id that no longer exists.
    expect(resolveMeetingSave()).toMatchObject({ folderId: null, origin: "default" });
  });

  it("resolves an override pointing at a deleted folder to the root", () => {
    useStore.setState({
      meetingSaveOverride: { scope: "personal", folderId: "fld-deleted" },
    });
    expect(resolveMeetingSave()).toMatchObject({ folderId: null, origin: "override" });
  });
});
