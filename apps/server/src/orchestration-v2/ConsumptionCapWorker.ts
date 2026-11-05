import {
  CommandId,
  type ProviderInstanceId,
  type ThreadConsumptionCap,
  type ThreadConsumptionCapHit,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  capModel,
  consumptionCapHitMatches,
  evaluateConsumptionCap,
} from "../usage/consumptionCap.ts";
import * as ThreadUsageService from "../usage/ThreadUsageService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const clearHit = (threadId: ThreadId, hitAt: string, expectedCap: ThreadConsumptionCap | null) => ({
  type: "thread.metadata.update" as const,
  commandId: CommandId.make(`consumption-cap-clear:${threadId}:${hitAt}`),
  threadId,
  consumptionCapHit: null,
  expectedConsumptionCap: expectedCap,
});

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const usage = yield* ThreadUsageService.ThreadUsageService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const readWindows = Effect.fn("ConsumptionCapWorker.readWindows")(function* (
    instanceIds: ReadonlySet<ProviderInstanceId>,
  ) {
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
    for (const instanceId of instanceIds) {
      const instance = yield* instances.getInstance(instanceId);
      const snapshot = instance ? yield* instance.snapshot.getSnapshot : undefined;
      windowsByInstance.set(
        instanceId,
        (snapshot?.usageLimits?.windows ?? []).map((window) => ({
          id: window.id,
          kind: window.kind,
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt ?? null,
        })),
      );
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
        const windowsByInstance = yield* readWindows(
          new Set(cap.rules.map((rule) => rule.providerInstanceId)),
        );
        const evaluation = evaluateConsumptionCap(
          cap,
          {
            models: threadUsage.models.map(capModel),
            windowsByInstance,
          },
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
