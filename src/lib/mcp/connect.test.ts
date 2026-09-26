import { describe, it, expect } from "vitest";
import { DEFAULT_MCP_ENDPOINT, claudeCodeCommand, mcpClientConfigJson } from "./connect";
import { hasSuccessfulCall } from "./activity";

describe("MCP connect strings", () => {
  it("builds the Claude Code command for the live endpoint, or the default", () => {
    expect(claudeCodeCommand("http://127.0.0.1:4555/mcp")).toBe(
      "claude mcp add --transport http parley http://127.0.0.1:4555/mcp"
    );
    expect(claudeCodeCommand(null)).toBe(`claude mcp add --transport http parley ${DEFAULT_MCP_ENDPOINT}`);
  });

  it("builds the client config JSON", () => {
    expect(JSON.parse(mcpClientConfigJson("http://127.0.0.1:4555/mcp"))).toEqual({
      mcpServers: { parley: { type: "http", url: "http://127.0.0.1:4555/mcp" } },
    });
  });
});

describe("hasSuccessfulCall", () => {
  it("needs at least one ok tool call", () => {
    expect(hasSuccessfulCall(null)).toBe(false);
    const call = { at: 1, tool: "list_recordings", kind: "read" as const, ok: false };
    expect(hasSuccessfulCall({ client: null, lastRequestAt: 1, recent: [call] })).toBe(false);
    expect(hasSuccessfulCall({ client: null, lastRequestAt: 1, recent: [call, { ...call, ok: true }] })).toBe(true);
  });
});
