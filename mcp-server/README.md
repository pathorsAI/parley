# Parley Templates MCP Server (Legacy Dev Reference)

Parley's production app now starts a built-in HTTP MCP endpoint from the Tauri
backend. Open the app and check **Settings -> MCP Server** for the live endpoint.

This package is kept as a development reference for the older standalone
Node/stdio implementation. It is no longer the primary way users connect to
Parley templates.

A local [MCP](https://modelcontextprotocol.io) server that manages Parley's
**evaluation** and **TODO** templates. It reads and writes the same on-disk JSON
file that the Parley desktop app uses, so changes made by an MCP client (Claude
Code, Claude Desktop, etc.) show up in the app and vice-versa.

## Shared file (source of truth)

```
~/Library/Application Support/com.pathors.parley/templates.json
```

The directory and file are created on first write. A missing or empty file is
treated as `{ "evalTemplates": [], "todoTemplates": [] }`. The file is written
pretty-printed (2-space). When editing one section the server preserves the
other (editing eval templates never clobbers TODO templates, and vice-versa).

Shape:

```jsonc
{
  "evalTemplates": [
    {
      "id": "string",
      "name": "string",
      "builtin": false,
      "evals": [
        { "id": "string", "name": "string", "description": "string", "prompt": "string" }
      ]
    }
  ],
  "todoTemplates": [
    { "id": "string", "name": "string", "builtin": false, "items": ["string", "string"] }
  ]
}
```

IDs are generated with `crypto.randomUUID()` when not provided.

## Tools

Eval templates:

- `list_eval_templates` -> `[{ id, name, builtin, evalCount }]`
- `get_eval_template` `{ id }` -> full template
- `upsert_eval_template` `{ id?, name, evals: [{ id?, name, description, prompt }] }` -> creates (new uuid) or updates by id; returns the saved template
- `delete_eval_template` `{ id }` -> `{ deleted, id }`

TODO templates:

- `list_todo_templates` -> `[{ id, name, builtin, itemCount }]`
- `get_todo_template` `{ id }` -> full template
- `upsert_todo_template` `{ id?, name, items: string[] }` -> create/update by id; returns the saved template
- `delete_todo_template` `{ id }` -> `{ deleted, id }`

Each tool returns its result as JSON text content. Inputs are validated with
zod; errors are returned as an MCP error result instead of crashing the process.

## Build

Uses [bun](https://bun.sh) for installs and `tsc` for the build.

```bash
cd mcp-server
bun install
bun run build      # tsc -> dist/index.js
# bun run typecheck  # tsc --noEmit
```

The entry point after building is `dist/index.js` (ESM, stdio transport).

## Register this legacy server in an MCP client

The server speaks MCP over stdio. Run it with `node` against the built file.

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "parley-templates": {
      "command": "node",
      "args": ["/Users/yjack/Github/pathors/parley/mcp-server/dist/index.js"]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "parley-templates": {
      "command": "node",
      "args": ["/Users/yjack/Github/pathors/parley/mcp-server/dist/index.js"]
    }
  }
}
```

Restart the client after editing its config. Build first (`bun run build`) so
`dist/index.js` exists.
