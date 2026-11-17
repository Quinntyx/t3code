#!/usr/bin/env node
// A tiny stdio MCP server for ExternalMcpServers.test.ts: three tools, newline-delimited JSON-RPC.
const readline = require("node:readline");

const tools = [
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

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line.trim() === "") return;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      return reply(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") return reply(message.id, { tools });
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      if (name === "crash-on-call") {
        process.stderr.write("fixture server crashed on purpose\n");
        process.exit(1);
      }
      if (name === "image") {
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
      if (name === "echo") {
        return reply(message.id, {
          content: [{ type: "text", text: String(args?.text ?? "") }],
          structuredContent: { echoed: args?.text ?? "" },
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
