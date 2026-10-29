#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { buildDeusTextRequest } from "../../apps/server/src/deus/DeusCoordinator.ts";
import {
  encodeJson,
  jsonBytes,
  type TextContent,
} from "../../apps/server/src/deus/textProtocol.ts";
import { McpToolUseCase } from "./run.ts";

const decodeCase = Schema.decodeEffect(Schema.fromJsonString(McpToolUseCase));
const decodeArgs = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
export const loadDeusTextCases = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const lines = yield* fs.readFileString(new URL("./deus-text.ndjson", import.meta.url).pathname);
  return yield* Effect.forEach(lines.trim().split("\n"), (line) => decodeCase(line));
});
export function deusTextRequest(testCase: McpToolUseCase) {
  const contents: TextContent[] = [
    {
      role: "user",
      parts: [
        { text: encodeJson({ evidenceOnly: true, context: testCase.setup.context ?? null }) },
      ],
    },
  ];
  for (const turn of testCase.setup.priorTurns ?? []) {
    if (turn.text)
      contents.push({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.text }],
      });
    const calls = turn.toolCalls ?? [];
    if (calls.length) {
      contents.push({
        role: "model",
        parts: calls.map((call, index) => ({
          functionCall: {
            id: `prior-${index}`,
            name: call.tool,
            args: decodeArgs(call.input),
          },
        })),
      });
      contents.push({
        role: "user",
        parts: calls.map((call, index) => ({
          functionResponse: {
            id: `prior-${index}`,
            name: call.tool,
            response: { result: call.result, evidenceOnly: true },
          },
        })),
      });
    }
  }
  contents.push({ role: "user", parts: [{ text: testCase.prompt }] });
  return buildDeusTextRequest(contents);
}
const main = Effect.gen(function* () {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !["--dry-run", "--context"].includes(flags[0]!))
    return yield* Effect.die(
      "Only --dry-run or --context is supported. This runner never calls a provider.",
    );
  for (const testCase of yield* loadDeusTextCases) {
    const request = deusTextRequest(testCase);
    yield* Console.log(
      encodeJson({
        id: testCase.id,
        bytes: jsonBytes(request),
        ...(flags[0] === "--dry-run" ? { request } : { tools: request.tools?.length }),
      }),
    );
  }
});
if (import.meta.main) main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
