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

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(INITIAL, true);
  syncOn.value = false;
});

describe("resolveMeetingSave — filing is the folder picked for this call", () => {
  it("files into the folder pre-flight picked", () => {
    useStore.setState({ meetingFolderId: "fld-company" });
    expect(resolveMeetingSave()).toMatchObject({
      folderId: "fld-company",
      origin: "meeting",
    });
  });

  it("falls back to the settings default personal folder", () => {
    useStore.setState({
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "personal", folderId: "fld-company" },
      },
    });
    expect(resolveMeetingSave()).toMatchObject({
      folderId: "fld-company",
      origin: "default",
    });
  });

  it("files at the root when neither is set", () => {
    expect(resolveMeetingSave()).toMatchObject({ folderId: null, origin: "default" });
  });

  it("does not inherit a personal folder from an ORG default", () => {
    useStore.setState({
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "org", orgId: "org-1", folderId: "of-1" },
      },
    });
    expect(resolveMeetingSave().folderId).toBeNull();
  });
});

describe("resolveMeetingSave — the org share is independent of the folder", () => {
  it("shares to the per-meeting org WITHOUT unfiling the local copy", () => {
    // The old model's bug: an org "save destination" dropped the local copy at
    // the root, losing the customer's own filing.
    syncOn.value = true;
    useStore.setState({
      meetingFolderId: "fld-company",
      meetingOrgShare: { orgId: "org-1", folderId: null, mode: "copy" },
    });
    expect(resolveMeetingSave()).toMatchObject({
      folderId: "fld-company",
      autoShare: { orgId: "org-1", folderId: null, mode: "copy" },
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
    expect(resolveMeetingSave().autoShare).toEqual({ orgId: "org-1", folderId: "of-1", mode: "copy" });
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

  it("carries the per-meeting handoff mode through to the save target", () => {
    // "move" is only ever an explicit per-meeting pick; the save path reads it
    // to decide whether the personal original survives the share.
    syncOn.value = true;
    useStore.setState({
      meetingFolderId: "fld-company",
      meetingOrgShare: { orgId: "org-1", folderId: "of-1", mode: "move" },
    });
    expect(resolveMeetingSave().autoShare).toEqual({
      orgId: "org-1",
      folderId: "of-1",
      mode: "move",
    });
  });

  it("keeps the settings default a COPY", () => {
    // The default shares every meeting; it must never be able to delete the
    // user's own copy behind their back.
    syncOn.value = true;
    useStore.setState({
      settings: {
        ...INITIAL.settings,
        defaultSaveLocation: { scope: "org", orgId: "org-1", folderId: null },
      },
    });
    expect(resolveMeetingSave().autoShare?.mode).toBe("copy");
  });

  it("reports the sync-off fallback instead of silently not sharing", () => {
    useStore.setState({ meetingOrgShare: { orgId: "org-1", folderId: null, mode: "copy" } });
    expect(resolveMeetingSave()).toMatchObject({ autoShare: null, fallback: "syncOff" });
  });
});
