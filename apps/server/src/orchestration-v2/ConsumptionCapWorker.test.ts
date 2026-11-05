import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadUsageService from "../usage/ThreadUsageService.ts";
import * as ConsumptionCapWorker from "./ConsumptionCapWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-consumption-cap");
const runId = RunId.make("run-consumption-cap");

const candidate = (input: {
  readonly cap: OrchestrationV2AppThread["consumptionCap"];
  readonly hit?: OrchestrationV2AppThread["consumptionCapHit"];
  readonly activeRunId?: RunId;
  readonly hasActiveDelegates?: boolean;
  readonly hasActiveBackgroundWork?: boolean;
}): ProjectionStore.ProjectionConsumptionCapCandidate => ({
  thread: {
    id: threadId,
    consumptionCap: input.cap,
    consumptionCapHit: input.hit ?? null,
  } as OrchestrationV2AppThread,
  activeRunId: input.activeRunId ?? null,
  hasActiveDelegates: input.hasActiveDelegates ?? false,
  hasActiveBackgroundWork: input.hasActiveBackgroundWork ?? false,
});

const runSweep = (input: {
  readonly candidates: ReadonlyArray<ProjectionStore.ProjectionConsumptionCapCandidate>;
  readonly models: ReadonlyArray<{
    readonly providerInstanceId: ProviderInstanceId;
    readonly model: string;
    readonly costUsd: number | null;
  }>;
}) =>
  Effect.gen(function* () {
    const commands: OrchestrationV2ServerCommand[] = [];
    const layer = ConsumptionCapWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({
            register: (_name, effect) => effect.pipe(Effect.ignoreCause()),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getConsumptionCapCandidates: () => Effect.succeed(input.candidates),
          }),
          Layer.mock(ThreadUsageService.ThreadUsageService)({
            read: () =>
              Effect.succeed({
                models: input.models.map((model) => ({
                  ...model,
                  driver: ProviderDriverKind.make("claudeAgent"),
                  group: "main" as const,
                  threads: 1,
                  tokens: {
                    uncachedInputTokens: 100,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 10,
                    reasoningTokens: 0,
                  },
                  totalTokens: 110,
                })),
                startedAt: null,
                bucketMs: 60_000,
                series: [],
                compactedAt: [],
              }),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.sync(() => undefined as ProviderInstance | undefined),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length } as never;
              }),
          }),
        ),
      ),
    );
    yield* Effect.void.pipe(Effect.provide(layer));
    return commands;
  }).pipe(Effect.runPromise);

describe("consumption cap sweep", () => {
  it("records the hit and stops an active run", async () => {
    const commands = await runSweep({
      candidates: [
        candidate({
          cap: { conditions: [{ kind: "spend", limitUsd: 0.5 }] },
          activeRunId: runId,
        }),
      ],
      models: [
        {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "opus",
          costUsd: 0.75,
        },
      ],
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.metadata.update",
      "thread.stop",
    ]);
    expect(commands[0]).toMatchObject({
      type: "thread.metadata.update",
      consumptionCapHit: {
        runId,
        reason: "Thread API spend $0.75 reached $0.50 cap.",
      },
    });
    expect(commands[1]).toMatchObject({
      type: "thread.stop",
      threadId,
      reason: "Thread API spend $0.75 reached $0.50 cap.",
    });
  });

  it("stops the thread when a delegate is the only active work", async () => {
    const commands = await runSweep({
      candidates: [
        candidate({
          cap: { conditions: [{ kind: "spend", limitUsd: 0.5 }] },
          hasActiveDelegates: true,
        }),
      ],
      models: [
        {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "opus",
          costUsd: 0.75,
        },
      ],
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.metadata.update",
      "thread.stop",
    ]);
  });

  it("stops the thread when background work is the only active work", async () => {
    const commands = await runSweep({
      candidates: [
        candidate({
          cap: { conditions: [{ kind: "spend", limitUsd: 0.5 }] },
          hasActiveBackgroundWork: true,
        }),
      ],
      models: [
        {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "opus",
          costUsd: 0.75,
        },
      ],
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.metadata.update",
      "thread.stop",
    ]);
  });

  it("does not clear a quota hit while the window is unknown", async () => {
    const commands = await runSweep({
      candidates: [
        candidate({
          cap: {
            conditions: [
              {
                kind: "quota",
                windowKind: "session",
                atPercent: 80,
              },
            ],
          },
          hit: {
            at: "2026-11-04T12:00:00.000Z",
            reason: "5h usage 90% reached 80% cap.",
          },
        }),
      ],
      models: [],
    });

    expect(commands).toEqual([]);
  });

  it("clears a hit that no longer breaches the cap", async () => {
    const commands = await runSweep({
      candidates: [
        candidate({
          cap: { conditions: [{ kind: "spend", limitUsd: 5 }] },
          hit: {
            at: "2026-11-04T12:00:00.000Z",
            reason: "Thread API spend $0.75 reached $0.50 cap.",
          },
        }),
      ],
      models: [
        {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "opus",
          costUsd: 0.75,
        },
      ],
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.metadata.update",
      consumptionCapHit: null,
    });
  });
});
