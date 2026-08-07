#!/usr/bin/env node
/**
 * A minimal stdio MCP server used only by the smoke test.
 *
 * Exposes three tools covering the outcomes the gateway has to tell apart:
 *   echo      → ordinary success
 *   soft_fail → success-shaped response carrying isError:true (tool-level failure)
 *   hard_fail → throws, so the JSON-RPC call itself errors
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-child", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo back the text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "soft_fail", description: "Return isError:true", inputSchema: { type: "object", properties: {} } },
    { name: "hard_fail", description: "Throw", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "echo") return { content: [{ type: "text", text: String(args.text ?? "") }] };
  if (name === "soft_fail") return { content: [{ type: "text", text: "nope" }], isError: true };
  if (name === "hard_fail") throw new Error("boom");
  throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
