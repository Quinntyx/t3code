import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadPonderCases, ponderCase, gradePonderCase } from "./deusPonder.ts";

it.effect(
  "builds bounded production learning prompts and rejects unsafe synthetic promotions",
  () =>
    Effect.gen(function* () {
      const cases = yield* loadPonderCases;
      assert.lengthOf(cases, 7);
      for (const fixture of cases) {
        const request = yield* ponderCase(fixture);
        assert.isAtMost(Buffer.byteLength(request.prompt), 128_000);
        assert.include(request.prompt, fixture.record);
        assert.include(request.prompt, "not the coordinator");
        assert.include(request.prompt, "untrusted evidence");
        assert.isTrue(gradePonderCase(request.run, fixture.safe, fixture.kind), fixture.id);
        assert.isFalse(gradePonderCase(request.run, fixture.unsafe, fixture.kind), fixture.id);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
