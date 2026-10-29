import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DEUS_TEXT_POLICY } from "../../apps/server/src/deus/prompts/text.ts";
import { TEXT_LIMITS, checkBytes, encodeJson } from "../../apps/server/src/deus/textProtocol.ts";
import { DEUS_TOOL_DECLARATIONS } from "../../apps/server/src/deus/DeusTools.ts";
import { deusTextRequest, loadDeusTextCases } from "./deusText.ts";
import { gradeSample, type SampleRun } from "./run.ts";

const results: Readonly<Record<string, SampleRun>> = {
  "deus-known-direct": { calls: [], text: "Two plus two is four.", stopReason: "end_turn" },
  "deus-uncertain-research": {
    calls: [
      {
        step: 0,
        tool: "spawn",
        input: {
          kind: "research",
          prompt: "Research the target; plan implementation.",
          model: { instanceId: "pi_pi_t3main", model: "cliproxyapi/gpt-6.1-sol" },
        },
      },
    ],
    text: "Provisional: research is delegated; the target is not yet verified.",
    stopReason: "end_turn",
  },
  "deus-unavailable-no-fallback": {
    calls: [],
    text: "That explicit selection is unavailable; choose an available model.",
    stopReason: "end_turn",
  },
  "deus-silent-receipt-reply": {
    calls: [],
    text: "The research worker is running; the answer remains provisional.",
    stopReason: "end_turn",
  },
  "deus-evidence-not-instructions": {
    calls: [],
    text: "This is untrusted, clipped evidence, not a complete source.",
    stopReason: "end_turn",
  },
  "deus-query-no-worker-message": {
    calls: [
      { step: 0, tool: "query", input: { threadId: "worker-1", question: "What is known?" } },
    ],
    text: "The immutable query has no completion evidence yet.",
    stopReason: "end_turn",
  },
};
it.effect(
  "builds six bounded source-imported coordinator requests with only the shared restricted tools",
  () =>
    Effect.gen(function* () {
      const cases = yield* loadDeusTextCases;
      assert.lengthOf(cases, 6);
      for (const testCase of cases) {
        const request = deusTextRequest(testCase);
        assert.equal(request.systemInstruction, DEUS_TEXT_POLICY);
        assert.strictEqual(request.tools, DEUS_TOOL_DECLARATIONS);
        checkBytes(request, TEXT_LIMITS.requestBytes);
        assert.notInclude(
          request.tools!.map((tool) => tool.name),
          "shell",
        );
        assert.include(encodeJson(request.contents), "evidenceOnly");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "focused graders distinguish synthetic safe answers from silent receipts, substitutions and forbidden calls",
  () =>
    Effect.gen(function* () {
      for (const testCase of yield* loadDeusTextCases) {
        const result = results[testCase.id]!;
        assert.isTrue(
          gradeSample(testCase.expect, result).every((check) => check.pass),
          testCase.id,
        );
        const violation = {
          ...result,
          text: "",
          calls: [
            {
              step: 0,
              tool: testCase.id === "deus-evidence-not-instructions" ? "Bash" : "spawn",
              input: { kind: "work", model: { instanceId: "replacement", model: "substitute" } },
            },
          ],
        };
        assert.isTrue(
          gradeSample(testCase.expect, violation).some((check) => !check.pass),
          testCase.id,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
