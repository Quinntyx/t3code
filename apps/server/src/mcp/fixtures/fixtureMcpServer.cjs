#!/usr/bin/env node
// A tiny stdio MCP server for ExternalMcpServers.test.ts: three tools, newline-delimited JSON-RPC.
const readline = require("node:readline");

const defaultTools = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to echo." } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "image",
    description: "Return a one-pixel PNG.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "crash-on-call",
    description: "Exit instead of answering.",
    inputSchema: { type: "object", properties: {} },
  },
];

// A test can rename the tools to exercise emitted-name collisions; behavior still follows the
// default name at the same position.
const toolNames = process.env.FIXTURE_TOOL_NAMES?.split(",") ?? [];
const tools = defaultTools.map((tool, index) => ({ ...tool, name: toolNames[index] ?? tool.name }));
const defaultNameOf = new Map(tools.map((tool, index) => [tool.name, defaultTools[index].name]));
const label = process.env.FIXTURE_LABEL;

// A test sets this to make startup fail after the child exists, as a broken server does.
const failingTool = process.env.FIXTURE_START_FAILURE;
// A test sets this to learn the child it should see stopped when the service scope closes.
if (process.env.FIXTURE_PID_FILE !== undefined) {
  require("node:fs").writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
}

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

if (failingTool !== undefined) {
  process.stderr.write(`fixture cannot start: ${failingTool}\n`);
  process.exit(1);
}

// A test sets these to exercise the protocol around listing: a server request mid-request and pages.
const pingBeforeList = process.env.FIXTURE_PING_BEFORE_LIST === "1";
const paginate = process.env.FIXTURE_PAGINATE === "1";
/** Our ping id to the tools/list request waiting on it, which can use a different id. */
const awaitingPing = new Map();

const answerList = (id, cursor) => {
  if (!paginate) return reply(id, { tools });
  return cursor === undefined
    ? reply(id, { tools: tools.slice(0, 2), nextCursor: "page-2" })
    : reply(id, { tools: tools.slice(2) });
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line.trim() === "") return;
    const message = JSON.parse(line);
    // Our ping is answered first; only now do we answer the tools/list request waiting on it.
    if (message.method === undefined && awaitingPing.has(message.id)) {
      const { listId, cursor } = awaitingPing.get(message.id);
      awaitingPing.delete(message.id);
      return answerList(listId, cursor);
    }
    if (message.method === "initialize") {
      return reply(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") {
      if (pingBeforeList) {
        awaitingPing.set(message.id, { listId: message.id, cursor: message.params?.cursor });
        return process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "ping" })}\n`,
        );
      }
      return answerList(message.id, message.params?.cursor);
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      const original = defaultNameOf.get(name) ?? name;
      if (original === "crash-on-call") {
        process.stderr.write("fixture server crashed on purpose\n");
        process.exit(1);
      }
      if (original === "image") {
        return reply(message.id, {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            },
          ],
        });
      }
      if (original === "echo") {
        const text = String(args?.text ?? "");
        return reply(message.id, {
          content: [{ type: "text", text }],
          structuredContent: { echoed: text, ...(label === undefined ? {} : { label }) },
        });
      }
      return process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such tool" } })}\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such method" } })}\n`,
    );
  })
  .on("close", () => process.exit(0));
