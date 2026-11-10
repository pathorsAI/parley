/**
 * How an MCP client is told to reach Parley: the server built into this app
 * (local route) or Parley's remote one (cloud route). Settings, the titlebar
 * chip and the report's "hand off to your AI" section all hand out these
 * strings, so they are built in one place and can never disagree about the
 * port, the URL or the server name.
 */
import * as ipc from "../ipc/commands";
import { useEffect, useState } from "react";
import { isTauri } from "../tauriEvents";
import { CLOUD_ENABLED } from "../flags";
import { useStore } from "../store";
import { effectiveSetupMode } from "../onboarding/setupMode";
import type { SetupMode } from "../types";

/** Where the server listens when the live endpoint hasn't been reported yet. */
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:3011/mcp";

/**
 * Parley's remote MCP server, for the cloud route: OAuth sign-in, reachable
 * from Claude on the web, desktop and phone, and it only sees recordings that
 * have synced to the cloud. It reports no live connection status to the app.
 */
export const CLOUD_MCP_URL = "https://api.parley.tw/mcp";

/** The public walkthrough for adding the cloud connector to Claude / ChatGPT. */
export const CLOUD_MCP_GUIDE_URL = "https://parley.tw/guides/connect-claude-chatgpt/";

/** Which MCP connection Parley hands out: it follows the setup route. */
export type McpTarget = SetupMode;

/** The MCP target for a route; the cloud one only exists in the cloud edition. */
export function mcpTarget(mode: SetupMode, cloudEnabled: boolean): McpTarget {
  return effectiveSetupMode(mode, cloudEnabled);
}

/** The current MCP target, from settings (always "local" in the OSS build). */
export function useMcpTarget(): McpTarget {
  const mode = useStore((s) => s.settings.setupMode);
  return mcpTarget(mode, CLOUD_ENABLED);
}

/** The name Parley registers under in an MCP client's config. */
export const MCP_SERVER_NAME = "parley";

/** Shape returned by the Rust `get_mcp_server_info` command. */
export interface McpServerInfo {
  running: boolean;
  endpoint: string;
  templates_path: string;
}

/** The terminal command that registers Parley with Claude Code — the local
 *  server's live endpoint (or its default), or pass {@link CLOUD_MCP_URL}. */
export function claudeCodeCommand(endpoint?: string | null): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint || DEFAULT_MCP_ENDPOINT}`;
}

/** The JSON block an HTTP-capable MCP client (e.g. Claude Desktop) needs. */
export function mcpClientConfigJson(endpoint?: string | null): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: endpoint || DEFAULT_MCP_ENDPOINT } } },
    null,
    2
  );
}

/**
 * The live endpoint of the built-in server, or null until it reports one.
 * Retries every second while the server is still starting.
 */
export function useMcpEndpoint(): string | null {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri() || endpoint) return;
    let alive = true;
    const lookup = () => {
      ipc.getMcpServerInfo()
        .then((info) => {
          if (alive && info.running && info.endpoint) setEndpoint(info.endpoint);
        })
        .catch(() => {
          /* server not up yet; retry next tick */
        });
    };
    lookup();
    const id = setInterval(lookup, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [endpoint]);
  return endpoint;
}
