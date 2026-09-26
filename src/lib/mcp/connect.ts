/**
 * How an MCP client is told to reach Parley's built-in server. Settings and the
 * report's "hand off to your AI" section both hand out these strings, so they are
 * built in one place and can never disagree about the port or the server name.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";

/** Where the server listens when the live endpoint hasn't been reported yet. */
export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:3011/mcp";

/** The name Parley registers under in an MCP client's config. */
export const MCP_SERVER_NAME = "parley";

/** Shape returned by the Rust `get_mcp_server_info` command. */
export interface McpServerInfo {
  running: boolean;
  endpoint: string;
  templates_path: string;
}

/** The terminal command that registers Parley with Claude Code. */
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
      invoke<McpServerInfo>("get_mcp_server_info")
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
