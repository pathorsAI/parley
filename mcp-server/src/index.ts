#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import {
  TEMPLATES_PATH,
  listEvalTemplates,
  getEvalTemplate,
  upsertEvalTemplate,
  deleteEvalTemplate,
  listTodoTemplates,
  getTodoTemplate,
  upsertTodoTemplate,
  deleteTodoTemplate,
} from "./store.js";

/** Wrap a tool handler so any thrown error becomes an MCP error result. */
function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

const evalDefSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
});

const server = new McpServer({
  name: "parley-templates",
  version: "0.1.0",
});

// ---- Eval template tools --------------------------------------------------

server.registerTool(
  "list_eval_templates",
  {
    title: "List eval templates",
    description:
      "List all Parley evaluation templates as { id, name, builtin, evalCount }.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await listEvalTemplates());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_eval_template",
  {
    title: "Get eval template",
    description: "Get a full Parley evaluation template by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return jsonResult(await getEvalTemplate(id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "upsert_eval_template",
  {
    title: "Create or update eval template",
    description:
      "Create (omit id) or update (provide existing id) an evaluation template. Returns the saved template.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string(),
      evals: z.array(evalDefSchema),
    },
  },
  async ({ id, name, evals }) => {
    try {
      return jsonResult(await upsertEvalTemplate({ id, name, evals }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "delete_eval_template",
  {
    title: "Delete eval template",
    description: "Delete an evaluation template by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return jsonResult(await deleteEvalTemplate(id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ---- TODO template tools --------------------------------------------------

server.registerTool(
  "list_todo_templates",
  {
    title: "List TODO templates",
    description:
      "List all Parley TODO/checklist templates as { id, name, builtin, itemCount }.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await listTodoTemplates());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_todo_template",
  {
    title: "Get TODO template",
    description: "Get a full Parley TODO template by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return jsonResult(await getTodoTemplate(id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "upsert_todo_template",
  {
    title: "Create or update TODO template",
    description:
      "Create (omit id) or update (provide existing id) a TODO template. Returns the saved template.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string(),
      items: z.array(z.string()),
    },
  },
  async ({ id, name, items }) => {
    try {
      return jsonResult(await upsertTodoTemplate({ id, name, items }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "delete_todo_template",
  {
    title: "Delete TODO template",
    description: "Delete a TODO template by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return jsonResult(await deleteTodoTemplate(id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main() {
  const isSse = process.argv.includes("--sse") || process.env.MCP_TRANSPORT === "sse";
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : 3011;

  if (isSse) {
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);

    const httpServer = createServer((req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.statusCode = 200;
        res.end();
        return;
      }

      if (req.url === "/sse" || req.url?.startsWith("/sse?")) {
        transport.handleRequest(req, res).catch((err) => {
          console.error("[parley-templates-mcp] request error:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      } else {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });

    httpServer.listen(port, "127.0.0.1", () => {
      console.error(`[parley-templates-mcp] ready. SSE server listening on http://127.0.0.1:${port}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[parley-templates-mcp] ready. Shared file: ${TEMPLATES_PATH}`);
  }
}

main().catch((err) => {
  console.error("[parley-templates-mcp] fatal:", err);
  process.exit(1);
});
