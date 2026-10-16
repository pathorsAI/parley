// The Settings window's data: what it fetches, polls and listens to. Each hook
// owns one effect (or none) and the shell (SettingsApp) calls them in a fixed
// order — the order the effects run in, and are cleaned up in.

import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { appLogDir, join } from "@tauri-apps/api/path";
import { toast } from "sonner";
import { log } from "../lib/log";
import { isTauri } from "../lib/tauriEvents";
import { CLOUD_ENABLED } from "../lib/flags";
import { signInWithGoogle } from "../lib/cloud/client";
import { listMyInvitations } from "../lib/cloud/orgs";
import type { CloudAuth } from "../lib/cloud/types";
import { SETTINGS_NAVIGATE_EVENT } from "../lib/settingsSync";
import type { McpServerInfo } from "../lib/mcp/connect";
import type { McpActivityInfo } from "../components/McpStatusChip";
import type { useI18n } from "../i18n";
import { fetchLatestReleaseNotes, markReleaseNotesSeen, type ReleaseNotes } from "../lib/releaseNotes";
import * as ipc from "../lib/ipc/commands";
import { MEETING_STATUS_EVENT, createListenerScope, listenEvent, listenIfTauri } from "../lib/ipc/events";
import { NAV, categoryFromHash, type Category } from "./nav";

type T = ReturnType<typeof useI18n>["t"];

/**
 * The open panel: from the deep-link hash at first, then from
 * `settings://navigate` (an already-open window), and back to Account when a
 * signed-in-only panel loses its sign-in. Plus the nav search.
 */
export function useSettingsCategory(cloudAuth: CloudAuth | null, t: T) {
  const [cat, setCat] = useState<Category>(() => categoryFromHash() ?? "basic");
  useEffect(() => {
    // The scope guards the cleanup-beats-listen() race: if unmount wins, the
    // listener is detached the moment it resolves instead of left attached.
    const listeners = createListenerScope((error) =>
      log.warn("settings: navigate listener failed", { error: String(error) }),
    );
    listeners.track(
      listenIfTauri<Category>(SETTINGS_NAVIGATE_EVENT, (e) => {
        if (NAV.some((n) => n.id === e.payload)) setCat(e.payload);
      }),
    );
    return listeners.dispose;
  }, []);
  // Signing out while on a signed-in-only panel (or deep-linking to one while
  // signed out) lands on Account, where signing in happens.
  useEffect(() => {
    if (!cloudAuth && NAV.some((n) => n.id === cat && n.signedInOnly)) setCat("account");
  }, [cloudAuth, cat]);
  // Nav search (⑥): label OR translated keywords, so "金鑰"/"key" finds the
  // provider panel and "麥克風"/"mic" finds transcription.
  const [navQuery, setNavQuery] = useState("");
  const navMatches = useMemo(() => {
    const visible = NAV.filter(
      (n) => (CLOUD_ENABLED || !n.cloudOnly) && (!n.signedInOnly || !!cloudAuth),
    );
    const q = navQuery.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((n) =>
      `${t(n.labelKey)} ${t(n.keywordsKey)}`.toLowerCase().includes(q)
    );
  }, [navQuery, t, cloudAuth]);
  return { cat, setCat, navQuery, setNavQuery, navMatches };
}

/** Invitations waiting for the signed-in user, badged on the Organizations nav
 *  item from any panel; the Organizations page keeps it current as they're answered. */
export function usePendingInvites(cloudAuth: CloudAuth | null) {
  const [pendingInvites, setPendingInvites] = useState(0);
  useEffect(() => {
    if (!CLOUD_ENABLED || !cloudAuth) {
      setPendingInvites(0);
      return;
    }
    listMyInvitations()
      .then((inv) => setPendingInvites(inv.length))
      .catch((error) => log.warn("settings: invitation count failed", { error: String(error) }));
  }, [cloudAuth]);
  return [pendingInvites, setPendingInvites] as const;
}

/** Google sign-in from the Account panel, cancellable, with a retry toast. */
export function useGoogleSignIn(t: T) {
  const [signingIn, setSigningIn] = useState(false);
  const signInAbort = useRef<AbortController | null>(null);

  async function doSignIn() {
    const controller = new AbortController();
    signInAbort.current = controller;
    setSigningIn(true);
    try {
      await signInWithGoogle(controller.signal);
    } catch (e) {
      // Don't toast a user-initiated cancel.
      if (!controller.signal.aborted) {
        const error = e instanceof Error ? e.message : String(e);
        toast.error(t("settings.account.signInFailed", { error }), {
          action: {
            label: t("toast.retry"),
            onClick: () => doSignIn().catch((error) => log.error("settings: sign-in retry failed", { error: String(error) })),
          },
        });
      }
    } finally {
      if (signInAbort.current === controller) signInAbort.current = null;
      setSigningIn(false);
    }
  }
  return { signingIn, signInAbort, doSignIn };
}

/** Mic devices, enumerated only on the Transcription tab — doing it on every
 *  Settings open can trip the macOS microphone permission prompt. */
export function useInputDevices(cat: Category) {
  const [devices, setDevices] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauri() || cat !== "transcription") return;
    ipc.listInputDevices()
      .then(setDevices)
      .catch((error) =>
        log.warn("settings: input device list failed", { error: String(error) }),
      );
  }, [cat]);
  return devices;
}

/**
 * The app's version, the shared templates file, the log file, and the MCP
 * server's info — polled every second until the server reports running.
 *
 * The effect also stops a mic test on cleanup. That is where the window has
 * always done it (unmount — and, with it, every time the MCP server's running
 * flag flips, since the flag is this effect's dependency), so it stays here.
 */
export function useAppInfo() {
  const [templatesPath, setTemplatesPath] = useState("");
  const [mcpInfo, setMcpInfo] = useState<McpServerInfo | null>(null);
  const [logPath, setLogPath] = useState("");
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setAppVersion)
      .catch((error) => log.warn("settings: app version lookup failed", { error: String(error) }));
    ipc.getTemplatesPath()
      .then(setTemplatesPath)
      .catch((error) =>
        log.warn("settings: templates path lookup failed", { error: String(error) }),
      );
    appLogDir()
      .then((d) => join(d, "parley.log"))
      .then(setLogPath)
      .catch((error) => log.warn("settings: log path lookup failed", { error: String(error) }));
    const refreshMcpInfo = () => {
      ipc.getMcpServerInfo()
        .then(setMcpInfo)
        .catch((error) =>
          log.warn("settings: MCP server info lookup failed", { error: String(error) }),
        );
    };
    refreshMcpInfo();
    const mcpTimer = globalThis.setInterval(() => {
      if (!mcpInfo?.running) refreshMcpInfo();
    }, 1000);
    return () => {
      globalThis.clearInterval(mcpTimer);
      ipc.stopMicTest().catch((error) => log.warn("settings: stop mic test on cleanup failed", { error: String(error) }));
    };
  }, [mcpInfo?.running]);
  return { appVersion, templatesPath, logPath, mcpInfo };
}

/** MCP client traffic (who's connected, recent reads/writes) — polled every
 *  3 s, only while the MCP tab is open. */
export function useMcpActivity(cat: Category) {
  const [mcpActivity, setMcpActivity] = useState<McpActivityInfo | null>(null);
  useEffect(() => {
    if (!isTauri() || cat !== "mcp") return;
    let alive = true;
    const refresh = () => {
      ipc.getMcpActivity()
        .then((a) => {
          if (alive) setMcpActivity(a);
        })
        .catch(() => {});
    };
    refresh();
    const id = globalThis.setInterval(refresh, 3000);
    return () => {
      alive = false;
      globalThis.clearInterval(id);
    };
  }, [cat]);
  return mcpActivity;
}

/** Is a meeting recording in the main window? Queried once, then followed via
 *  the broadcast `meeting://status` — it locks the mic test + device picker so
 *  changing the input can't disrupt the live capture. */
export function useMeetingRecording() {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    ipc.meetingActive()
      .then((a) => alive && setRecording(a))
      .catch((error) => log.warn("settings: meeting status query failed", { error: String(error) }));
    const un = listenEvent(MEETING_STATUS_EVENT, (e) => {
      if (alive) setRecording(e.payload === "recording");
    });
    return () => {
      alive = false;
      un.then((fn) => fn()).catch((error) =>
        log.warn("settings: meeting status listener cleanup failed", { error: String(error) }),
      );
    };
  }, []);
  return recording;
}

/** The Transcription tab's mic test: start/stop, and the testing flag the
 *  device picker reads to restart it on the new input. */
export function useMicTest(recording: boolean, inputDevice: string, t: T) {
  const [testing, setTesting] = useState(false);

  async function toggleTest() {
    if (recording) return; // the mic belongs to the meeting while recording
    if (testing) {
      await ipc.stopMicTest().catch((error) =>
        log.warn("settings: stop mic test failed", { error: String(error) }),
      );
      setTesting(false);
    } else {
      // Enter the testing state only if the mic actually opened. `start_mic_test`
      // could never fail for a device problem until the capture layer learned to
      // report one, so this used to swallow the error and light up a live-looking
      // test with the level meter pinned at 0 — the same silent lie a meeting told
      // when the mic was denied or held by another app.
      try {
        await ipc.startMicTest({ inputDevice });
        setTesting(true);
      } catch (error) {
        log.warn("settings: start mic test failed", {
          inputDevice,
          error: String(error),
        });
        toast.error(t("settings.transcription.micTestFailed"));
      }
    }
  }
  return { testing, toggleTest };
}

/** "Check for updates" on the Basic panel. Kept by the shell so its answer
 *  survives switching panels. */
export function useUpdateCheck(t: T) {
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");
  async function checkForUpdates() {
    setUpdateChecking(true);
    setUpdateMsg("");
    try {
      const { checkForUpdate } = await import("../lib/update");
      const r = await checkForUpdate({ silent: false });
      setUpdateMsg(r ? t("update.found", { version: r.version }) : t("update.upToDate"));
    } finally {
      setUpdateChecking(false);
    }
  }
  return { updateChecking, updateMsg, checkForUpdates };
}

/** The release notes dialog, opened from the Basic panel and drawn by the shell. */
export function useReleaseNotes(t: T) {
  const [releaseNotesLoading, setReleaseNotesLoading] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null);
  async function showReleaseNotes() {
    setReleaseNotesLoading(true);
    try {
      setReleaseNotes(await fetchLatestReleaseNotes());
    } catch (error) {
      toast.error(t("releaseNotes.loadFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setReleaseNotesLoading(false);
    }
  }
  function closeReleaseNotes() {
    if (releaseNotes) markReleaseNotesSeen(releaseNotes.version);
    setReleaseNotes(null);
  }
  return { releaseNotes, releaseNotesLoading, showReleaseNotes, closeReleaseNotes };
}
