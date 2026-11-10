import { describe, it, expect } from "vitest";
import { CLOUD_MCP_URL, DEFAULT_MCP_ENDPOINT, claudeCodeCommand, mcpClientConfigJson, mcpTarget } from "./connect";
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

describe("MCP target", () => {
  it("follows the setup route, and is always local without the cloud edition", () => {
    expect(mcpTarget("cloud", true)).toBe("cloud");
    expect(mcpTarget("local", true)).toBe("local");
    expect(mcpTarget("cloud", false)).toBe("local");
  });

  it("builds the cloud strings from the remote URL", () => {
    expect(CLOUD_MCP_URL).toBe("https://api.parley.tw/mcp");
    expect(claudeCodeCommand(CLOUD_MCP_URL)).toBe(
      "claude mcp add --transport http parley https://api.parley.tw/mcp"
    );
    expect(JSON.parse(mcpClientConfigJson(CLOUD_MCP_URL))).toEqual({
      mcpServers: { parley: { type: "http", url: CLOUD_MCP_URL } },
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
