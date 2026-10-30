import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DEUS_LIVE_POLICY } from "../../apps/server/src/deus/GeminiLiveAdapter.ts";
import { DEUS_TOOL_DECLARATIONS } from "../../apps/server/src/deus/DeusTools.ts";
import { TEXT_LIMITS, checkBytes } from "../../apps/server/src/deus/textProtocol.ts";
import { deusLiveRequest } from "./deusLive.ts";
import { loadDeusTextCases } from "./deusText.ts";

it.effect(
  "dry-runs the actual Live policy and restricted non-blocking declarations without provider access",
  () =>
    Effect.gen(function* () {
      for (const testCase of yield* loadDeusTextCases) {
        const request = deusLiveRequest(testCase);
        checkBytes(request, TEXT_LIMITS.requestBytes);
        assert.deepEqual(request.config.responseModalities, ["AUDIO"]);
        assert.include(
          JSON.stringify(request.config.systemInstruction),
          DEUS_LIVE_POLICY.slice(0, 80),
        );
        const first = request.config.tools?.[0];
        const tools =
          first && "functionDeclarations" in first ? first.functionDeclarations : undefined;
        assert.deepEqual(
          tools?.map((tool) => tool.name),
          DEUS_TOOL_DECLARATIONS.map((tool) => tool.name),
        );
        assert.isTrue(tools?.every((tool) => tool.behavior === "NON_BLOCKING"));
        assert.deepEqual(request.config.realtimeInputConfig?.automaticActivityDetection, {
          disabled: false,
        });
        assert.include(String(request.config.systemInstruction), '"syntheticFixture":true');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
