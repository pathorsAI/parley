import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
// Folder registry + cloud are I/O boundaries; stub them to fixed answers so the
// rules themselves are what's under test.
vi.mock("./folders", () => ({
  listLocalFolders: () => [{ id: "fld-company", name: "Pathors AI", createdAt: 0 }],
}));
const syncOn = vi.hoisted(() => ({ value: false }));
vi.mock("../cloud/client", () => ({
  syncEnabled: () => syncOn.value,
  CLOUD_URL: "",
  cloudFetch: vi.fn(),
  cloudToken: () => null,
}));
vi.mock("../flags", () => ({ CLOUD_ENABLED: true }));

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
  syncOn.value = false;
});

describe("resolveMeetingSave — filing follows the customer (#211)", () => {
  it("files under the linked company's folder", () => {
    seedCompany();
    useStore.setState({ meetingCompanyId: "co-1" });
    expect(resolveMeetingSave()).toMatchObject({ folderId: "fld-company", origin: "company" });
  });

  it("files at the root when there is no customer — there is nothing to choose", () => {
    expect(resolveMeetingSave()).toMatchObject({ folderId: null, origin: "default" });
  });

  it("files at the root when the paired folder is gone, not into a dead id", () => {
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
    expect(resolveMeetingSave()).toMatchObject({ folderId: null, origin: "default" });
  });
});

describe("resolveMeetingSave — the org share is independent of the customer", () => {
  it("shares to the per-meeting org WITHOUT unfiling the customer", () => {
    // The old model's bug: an org "save destination" dropped the local copy at
    // the root, losing the customer's own filing.
    syncOn.value = true;
    seedCompany();
    useStore.setState({
      meetingCompanyId: "co-1",
      meetingOrgShare: { orgId: "org-1", folderId: null },
    });
    expect(resolveMeetingSave()).toMatchObject({
      folderId: "fld-company",
      autoShare: { orgId: "org-1", folderId: null },
    });
  });

  it("follows the settings default share when the meeting made no choice", () => {
    syncOn.value = true;
    useStore.setState({
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "org", orgId: "org-1", folderId: "of-1" },
      },
    });
    expect(resolveMeetingSave().autoShare).toEqual({ orgId: "org-1", folderId: "of-1" });
  });

  it('lets "off" suppress the default share for one meeting', () => {
    syncOn.value = true;
    useStore.setState({
      meetingOrgShare: "off",
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "org", orgId: "org-1", folderId: null },
      },
    });
    expect(resolveMeetingSave().autoShare).toBeNull();
  });

  it("reports the sync-off fallback instead of silently not sharing", () => {
    useStore.setState({ meetingOrgShare: { orgId: "org-1", folderId: null } });
    expect(resolveMeetingSave()).toMatchObject({ autoShare: null, fallback: "syncOff" });
  });
});
