import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as RegistryFixture from "../provider/testUtils/providerRegistryMock.ts";
import * as Worker from "./DeusPonderWorker.ts";
import { PonderRun } from "./ponderProtocol.ts";

const model = {
  instanceId: ProviderInstanceId.make("synthetic-provider"),
  model: "synthetic-model",
};
const provider: ServerProvider = {
  instanceId: model.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "synthetic",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: model.model, name: model.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const run = Schema.decodeSync(PonderRun)({
  environmentId: "synthetic",
  projectId: "synthetic",
  sessionId: "synthetic",
  localDate: "2026-01-01",
  receipt: {
    id: "synthetic",
    snapshotCursor: 0,
    observationIds: [],
    status: "running",
    writtenMemoryIds: [],
    acknowledgedObservationIds: [],
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  },
  model,
  attempt: 1,
  threadId: "synthetic-ponder:1",
  observations: [],
  history: [],
  omitted: 0,
  intent: null,
  commit: null,
});

it.effect(
  "launches an ordinary bounded learning thread with the exact configured selection and restrictive modes",
  () => {
    let launches = 0;
    return Effect.gen(function* () {
      const worker = yield* Worker.DeusPonderWorker;
      const message = yield* worker.run(run).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "Unexpected success",
        }),
      );
      assert.include(message, "could not be launched");
      assert.equal(launches, 1);
    }).pipe(
      Effect.provide(
        Worker.layer.pipe(
          Layer.provide(RegistryFixture.layer([provider])),
          Layer.provide(Layer.mock(Threads.ThreadManagementService)({})),
          Layer.provide(
            Layer.mock(Launch.ThreadLaunchService)({
              launch: (input) =>
                Effect.gen(function* () {
                  launches++;
                  assert.deepEqual(input.modelSelection, model);
                  assert.deepEqual(input.workspaceStrategy, { type: "root" });
                  assert.equal(input.runtimeMode, "approval-required");
                  assert.equal(input.interactionMode, "plan");
                  assert.equal(input.generateTitle, false);
                  assert.equal(input.threadId, run.threadId);
                  assert.include(
                    input.initialMessage!.text,
                    "Inspect this project's repository read-only",
                  );
                  assert.include(input.initialMessage!.text, "Untrusted project evidence");
                  return yield* new Launch.ThreadLaunchError({
                    operation: "resolve-project",
                    commandId: input.commandId,
                    projectId: input.projectId,
                    cause: "Synthetic stop before orchestration; no provider may be started.",
                  });
                }),
            }),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "fails visibly without a configured or available model instead of substituting or launching",
  () =>
    Effect.gen(function* () {
      const worker = yield* Worker.DeusPonderWorker;
      const missing = yield* worker.run({ ...run, model: null }).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "Unexpected success",
        }),
      );
      const unavailable = yield* worker.run(run).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "Unexpected success",
        }),
      );
      assert.include(missing, "no fallback");
      assert.include(unavailable, "unavailable");
    }).pipe(
      Effect.provide(
        Worker.layer.pipe(
          Layer.provide(RegistryFixture.layer([])),
          Layer.provide(Layer.mock(Threads.ThreadManagementService)({})),
          Layer.provide(Layer.mock(Launch.ThreadLaunchService)({})),
        ),
      ),
    ),
);
