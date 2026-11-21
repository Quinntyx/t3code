import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

it.effect("looks up existing pull requests in the same explicit target used for creation", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const provider = yield* OriginSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.mock(OriginCli.OriginCli)({
          resolveRepository: () => Effect.succeed("fork/repo"),
          api: (input, schema) => {
            paths.push(input.path);
            const payload: unknown = { pullRequests: [] };
            return Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.orDie);
          },
        }),
      ),
    );
    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature",
      targetRepository: "base/repo",
      state: "open",
    });
    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature",
      state: "open",
    });
    assert.include(paths[0], "/base/repo/pulls?");
    assert.include(paths[1], "/fork/repo/pulls?");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestSourceControlHost.layer()))),
);
