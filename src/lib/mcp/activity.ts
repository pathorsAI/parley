/**
 * Live MCP client traffic, as recorded by the built-in server: who connected
 * (clientInfo from `initialize`), when they last called, and the recent tool
 * calls. The titlebar chip and the report's hand-off section both read it
 * through {@link useMcpActivity}, so they always agree on "connected".
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";
import { markGettingStarted } from "../onboarding/gettingStarted";

/** One tool call recorded by the MCP server (newest first in `recent`). */
export interface McpActivityEntry {
  at: number;
  tool: string;
  kind: "read" | "write";
  ok: boolean;
  error?: string;
}

export interface McpActivityInfo {
  client: { name?: string; version?: string } | null;
  lastRequestAt: number | null;
  recent: McpActivityEntry[];
}

/** Derived connection state. HTTP MCP has no persistent session, so this is
 *  recency of the last request: active (seconds), connected (minutes), idle
 *  (client seen before, quiet now), none (no client ever). */
export type McpConnState = "active" | "connected" | "idle" | "none";

export function connState(info: McpActivityInfo | null, now: number): McpConnState {
  const last = info?.lastRequestAt;
  if (!last) return "none";
  const age = now - last;
  if (age <= 15_000) return "active";
  if (age <= 5 * 60_000) return "connected";
  return "idle";
}

/** "name vX" for the connected client, or null when nobody has connected. */
export function clientLabel(client: McpActivityInfo["client"] | undefined): string | null {
  if (!client) return null;
  const version = client.version ? ` v${client.version}` : "";
  return `${client.name ?? "?"}${version}`;
}

/** True once the feed holds at least one tool call that succeeded. */
export function hasSuccessfulCall(info: McpActivityInfo | null): boolean {
  return !!info?.recent?.some((e) => e.ok);
}

/**
 * Poll `get_mcp_activity` (every 3 s, or every 1 s with `fast` while a live view
 * is open). The first successful tool call ticks the getting-started
 * "handed off" step — an external AI actually read or wrote Parley's data.
 */
export function useMcpActivity(opts: { fast?: boolean } = {}): {
  info: McpActivityInfo | null;
  now: number;
} {
  const fast = !!opts.fast;
  const [info, setInfo] = useState<McpActivityInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    async function refresh() {
      try {
        const a = await invoke<McpActivityInfo>("get_mcp_activity");
        if (!alive) return;
        setInfo(a);
        setNow(Date.now());
        // Idempotent: a no-op once the step is already done.
        if (hasSuccessfulCall(a)) markGettingStarted("handedOff");
      } catch {
        /* server not up yet; retry next tick */
      }
    }
    void refresh();
    const id = setInterval(refresh, fast ? 1000 : 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fast]);

  return { info, now };
}
