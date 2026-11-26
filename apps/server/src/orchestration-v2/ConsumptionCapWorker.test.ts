import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  UsageLimitSourceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadUsageService from "../usage/ThreadUsageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ConsumptionCapWorker from "./ConsumptionCapWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-consumption-cap");
const runId = RunId.make("run-consumption-cap");

const candidate = (input: {
  readonly cap: OrchestrationV2AppThread["consumptionCap"];
  readonly hit?: OrchestrationV2AppThread["consumptionCapHit"];
  readonly providerInstanceId?: ProviderInstanceId;
  readonly activeRunId?: RunId;
  readonly hasActiveDelegates?: boolean;
  readonly hasActiveBackgroundWork?: boolean;
}): ProjectionStore.ProjectionConsumptionCapCandidate => ({
  thread: {
    id: threadId,
    providerInstanceId: input.providerInstanceId ?? ProviderInstanceId.make("claudeAgent"),
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
  readonly snapshots?: ReadonlyMap<ProviderInstanceId, ServerProvider>;
  readonly usageSources?: ReadonlyArray<UsageLimitSourceSnapshot>;
}) =>
  Effect.gen(function* () {
    const commands: OrchestrationV2ServerCommand[] = [];
    const baseLayers = Layer.mergeAll(
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
        getInstance: (id) =>
          Effect.sync(() => {
            const snapshot = input.snapshots?.get(id);
            return snapshot
              ? ({ snapshot: { getSnapshot: Effect.succeed(snapshot) } } as ProviderInstance)
              : undefined;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length } as never;
          }),
      }),
      ...(input.usageSources === undefined
        ? []
        : [
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.succeed(input.usageSources),
            }),
          ]),
    );
    const layer = ConsumptionCapWorker.layer.pipe(Layer.provide(baseLayers));
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

  it("evaluates quota caps from snapshot usageSources and routed CLIProxyAPI hubs", async () => {
    const piId = ProviderInstanceId.make("pi");
    const claude = ProviderDriverKind.make("claudeAgent");
    const checkedAt = "2026-11-04T12:00:00.000Z";
    const piSnapshot = {
      instanceId: piId,
      driver: ProviderDriverKind.make("pi"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageRoutes: [{ driver: claude, origin: "http://localhost:8317" }],
    } as ServerProvider;
    const hub: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Hub",
      origin: "http://127.0.0.1:8317",
      checkedAt,
      accounts: [
        {
          id: "claude.json",
          driver: claude,
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 92,
                resetsAt: "2099-11-04T15:00:00.000Z",
              },
            ],
          },
        },
      ],
    };
    const commands = await runSweep({
      candidates: [
        candidate({
          providerInstanceId: piId,
          activeRunId: runId,
          cap: {
            conditions: [{ kind: "quota", windowKind: "session", atPercent: 80 }],
          },
        }),
      ],
      models: [],
      snapshots: new Map([[piId, piSnapshot]]),
      usageSources: [hub],
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.metadata.update",
      "thread.stop",
    ]);
  });
});
