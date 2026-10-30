#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { liveConfig } from "../../apps/server/src/deus/GeminiLiveAdapter.ts";
import { encodeJson, jsonBytes } from "../../apps/server/src/deus/textProtocol.ts";
import { loadDeusTextCases } from "./deusText.ts";
import type { McpToolUseCase } from "./run.ts";

export function deusLiveRequest(testCase: McpToolUseCase) {
  return {
    model: "explicit-eval-live-model",
    config: liveConfig("explicit-eval-voice", {
      evidenceOnly: true,
      syntheticFixture: true,
      humanTranscription: testCase.prompt,
      context: testCase.setup.context ?? null,
      priorTurns: testCase.setup.priorTurns ?? [],
    }),
  };
}
const main = Effect.gen(function* () {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !["--dry-run", "--context"].includes(flags[0]!))
    return yield* Effect.die(
      "Only --dry-run or --context is supported. This runner never calls a provider.",
    );
  for (const testCase of yield* loadDeusTextCases) {
    const request = deusLiveRequest(testCase);
    yield* Console.log(
      encodeJson({
        id: testCase.id,
        bytes: jsonBytes(request),
        providerCalls: 0,
        ...(flags[0] === "--dry-run" ? { request } : { tools: request.config.tools?.length }),
      }),
    );
  }
});
if (import.meta.main) main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
