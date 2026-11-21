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
const requestsBeforeList = process.env.FIXTURE_REQUESTS_BEFORE_LIST?.split(",") ?? [];
const paginate = process.env.FIXTURE_PAGINATE === "1";
/** The tools/list request waiting on our own requests, keyed by the id they reuse. */
const awaiting = new Map();

const answerList = (id, cursor) => {
  if (!paginate) return reply(id, { tools });
  return cursor === undefined
    ? reply(id, { tools: tools.slice(0, 2), nextCursor: "page-2" })
    : reply(id, { tools: tools.slice(2) });
};

// Each request reuses the tools/list id, so a client that takes it for a reply misreads it.
const askNext = (listId, cursor, [method, ...rest]) => {
  awaiting.set(listId, { cursor, method, rest });
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: listId, method })}\n`);
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line.trim() === "") return;
    const message = JSON.parse(line);
    // Our requests are answered first, ping with a result and anything else as unknown; only
    // then do we answer the tools/list request waiting on them.
    if (message.method === undefined && awaiting.has(message.id)) {
      const { cursor, method, rest } = awaiting.get(message.id);
      awaiting.delete(message.id);
      const answered =
        method === "ping" ? message.result !== undefined : message.error?.code === -32601;
      if (!answered) process.exit(1);
      return rest.length > 0 ? askNext(message.id, cursor, rest) : answerList(message.id, cursor);
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
      if (requestsBeforeList.length > 0) {
        return askNext(message.id, message.params?.cursor, requestsBeforeList);
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
