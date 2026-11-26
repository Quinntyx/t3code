import {
  CommandId,
  type ProviderInstanceId,
  type ThreadConsumptionCap,
  type ThreadConsumptionCapHit,
  type ThreadId,
} from "@t3tools/contracts";
import {
  collectLimitPools,
  resolveInstanceHubRoutes,
  usageOrigin,
} from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  type ConsumptionCapModelUsage,
  capModel,
  consumptionCapHitMatches,
  evaluateConsumptionCap,
} from "../usage/consumptionCap.ts";
import * as ThreadUsageService from "../usage/ThreadUsageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const clearHit = (threadId: ThreadId, hitAt: string, expectedCap: ThreadConsumptionCap | null) => ({
  type: "thread.metadata.update" as const,
  commandId: CommandId.make(`consumption-cap-clear:${threadId}:${hitAt}`),
  threadId,
  consumptionCapHit: null,
  expectedConsumptionCap: expectedCap,
});

/** Quota conditions watch the account behind their scope, or the thread's own account. */
function quotaTargets(
  cap: ThreadConsumptionCap,
  usageModels: ReadonlyArray<ConsumptionCapModelUsage>,
  threadProviderInstanceId: ProviderInstanceId,
  threadModel: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlySet<string | null>> {
  const targets = new Map<ProviderInstanceId, Set<string | null>>();
  const add = (instanceId: ProviderInstanceId, model: string | null) => {
    const models = targets.get(instanceId) ?? new Set<string | null>();
    models.add(model);
    targets.set(instanceId, models);
  };
  for (const condition of cap.conditions) {
    if (condition.kind !== "quota") continue;
    if (condition.models !== undefined) {
      for (const model of condition.models) add(model.providerInstanceId, model.model ?? null);
      continue;
    }
    for (const model of usageModels) add(model.providerInstanceId, model.model);
    add(threadProviderInstanceId, threadModel);
  }
  return targets;
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const usage = yield* ThreadUsageService.ThreadUsageService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const usageSources = Option.getOrUndefined(
    yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources),
  );

  const readWindows = Effect.fn("ConsumptionCapWorker.readWindows")(function* (
    targets: ReadonlyMap<ProviderInstanceId, ReadonlySet<string | null>>,
    nowMs: number,
  ) {
    const currentSources = usageSources ? yield* usageSources.current : [];
    const windowsByInstance = new Map<
      string,
      ReadonlyArray<{
        id: string;
        kind: "session" | "weekly" | "monthly" | "other";
        label: string;
        usedPercent: number;
        resetsAt: string | null;
      }>
    >();
    for (const [instanceId, models] of targets) {
      const instance = yield* instances.getInstance(instanceId);
      const snapshot = instance ? yield* instance.snapshot.getSnapshot : undefined;
      const windowsById = new Map<
        string,
        {
          id: string;
          kind: "session" | "weekly" | "monthly" | "other";
          label: string;
          usedPercent: number;
          resetsAt: string | null;
        }
      >();
      const pushWindow = (window: {
        id: string;
        kind: "session" | "weekly" | "monthly" | "other";
        label: string;
        usedPercent: number;
        resetsAt: string | null;
      }) => {
        if (!windowsById.has(window.id)) windowsById.set(window.id, window);
      };
      if (snapshot?.usageLimits && !snapshot.usageLimits.unavailable) {
        for (const window of snapshot.usageLimits.windows) {
          pushWindow({
            id: window.id,
            kind: window.kind,
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
          });
        }
      }
      for (const source of snapshot?.usageSources ?? []) {
        if (source.limits.unavailable) continue;
        for (const window of source.limits.windows) {
          pushWindow({
            id: `${source.id}:${window.id}`,
            kind: window.kind,
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
          });
        }
      }
      if (snapshot && currentSources.length > 0) {
        const modelList = models.size > 0 ? [...models] : [null];
        for (const model of modelList) {
          const { hubs, driversByOrigin } = resolveInstanceHubRoutes(
            snapshot,
            currentSources,
            model,
          );
          for (const hub of hubs) {
            const rawOrigin = hub.origin ?? hub.endpoint;
            const hubOrigin = rawOrigin ? usageOrigin(rawOrigin) : null;
            const allowedDrivers =
              (hubOrigin ? driversByOrigin.get(hubOrigin) : undefined) ??
              new Set([snapshot.driver]);
            const hubAccounts = hub.accounts.filter(
              (account) => !account.usageLimits.unavailable && allowedDrivers.has(account.driver),
            );
            const pools = collectLimitPools(
              hubAccounts.map((account) => ({
                key: `${hub.id}:${account.id}`,
                driver: account.driver,
                displayName: null,
                email: account.email,
                workspaceId: account.workspaceId,
                plan: account.plan,
                accentColor: undefined,
                environments: [],
                sourceLabel: hub.label,
                redeem: null,
                limits: account.usageLimits,
              })),
              nowMs,
            );
            for (const pool of pools) {
              for (const window of pool.windows) {
                const nextReset = window.resets.find((reset) => reset.at > nowMs);
                pushWindow({
                  id: `${hub.id}:${pool.driver}:${window.id}`,
                  kind: window.kind,
                  label: window.label,
                  usedPercent: Math.max(0, Math.min(100, 100 - window.remainingPercent)),
                  resetsAt: nextReset
                    ? DateTime.formatIso(DateTime.makeUnsafe(nextReset.at))
                    : null,
                });
              }
            }
          }
        }
      }
      windowsByInstance.set(instanceId, [...windowsById.values()]);
    }
    return windowsByInstance;
  });

  return Effect.fn("ConsumptionCapWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const candidates = yield* projections.getConsumptionCapCandidates();

    for (const { thread, activeRunId, hasActiveDelegates, hasActiveBackgroundWork } of candidates) {
      yield* Effect.gen(function* () {
        const cap = thread.consumptionCap ?? null;
        if (cap === null) {
          if (thread.consumptionCapHit != null) {
            yield* threads.dispatch(clearHit(thread.id, thread.consumptionCapHit.at, null));
          }
          return;
        }

        const threadUsage = yield* usage.read(thread.id);
        const usageModels = threadUsage.models.map(capModel);
        const windowsByInstance = yield* readWindows(
          quotaTargets(
            cap,
            usageModels,
            thread.providerInstanceId,
            thread.modelSelection?.model ?? null,
          ),
          nowMs,
        );
        const evaluation = evaluateConsumptionCap(
          cap,
          { models: usageModels, windowsByInstance },
          nowMs,
        );

        if (evaluation.breach === null) {
          if (evaluation.known && thread.consumptionCapHit != null) {
            yield* threads.dispatch(clearHit(thread.id, thread.consumptionCapHit.at, cap));
          }
          return;
        }

        const hitMatches = consumptionCapHitMatches(thread.consumptionCapHit, evaluation.breach);
        const hitAt = hitMatches ? thread.consumptionCapHit!.at : DateTime.formatIso(now);
        if (!hitMatches) {
          const hit: ThreadConsumptionCapHit = {
            at: hitAt,
            reason: evaluation.breach.reason,
            ...(activeRunId === null ? {} : { runId: activeRunId }),
          };
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`consumption-cap-hit:${thread.id}:${hitAt}`),
            threadId: thread.id,
            consumptionCapHit: hit,
            expectedConsumptionCap: cap,
          });
        }

        if (activeRunId !== null || hasActiveDelegates || hasActiveBackgroundWork) {
          yield* threads.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`consumption-cap-stop:${thread.id}:${hitAt}`),
            threadId: thread.id,
            reason: evaluation.breach.reason,
            consumptionCapGuard: { cap, hitAt },
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.consumption-cap.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("consumption-cap", sweep());
  }),
);
