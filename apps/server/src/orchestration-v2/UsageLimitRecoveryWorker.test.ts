import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const verifySweep = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    const sweeps = yield* Queue.unbounded<void>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitFailuresWithoutReset: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () => Queue.offer(sweeps, undefined).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(EventSink.EventSinkV2)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: false,
              snoozeLimitedThreads: true,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, event);
      // The scheduler is mocked out, so only the committed failure can start this sweep.
      yield* Queue.take(sweeps);
    }).pipe(Effect.provide(layer));
  });

it.effect("sweeps when a failed run is committed", () =>
  verifySweep({
    type: "run.updated",
    threadId: ThreadId.make("thread:limited"),
    payload: { status: "failed" },
  } as never),
);

it.effect("sweeps when a usage-limit item is committed", () =>
  verifySweep({
    type: "turn-item.updated",
    threadId: ThreadId.make("thread:limited"),
    payload: { type: "error", failure: { class: "usage_limit" } },
  } as never),
);

it.effect("sweeps when a non-pending runtime request is committed", () =>
  verifySweep({
    type: "runtime-request.updated",
    threadId: ThreadId.make("thread:limited"),
    payload: { status: "cancelled" },
  } as never),
);

it.effect("recognizes only events that can change limit recovery", () =>
  Effect.sync(() => {
    const signal = (event: object) =>
      UsageLimitRecoveryWorker.isLimitRecoverySignal(event as never);
    assert.isTrue(signal({ type: "run.updated", payload: { status: "failed" } }));
    assert.isFalse(signal({ type: "run.updated", payload: { status: "running" } }));
    assert.isTrue(
      signal({
        type: "turn-item.updated",
        payload: { type: "error", failure: { class: "usage_limit" } },
      }),
    );
    assert.isFalse(
      signal({
        type: "turn-item.updated",
        payload: { type: "error", failure: { class: "provider_error" } },
      }),
    );
    assert.isTrue(signal({ type: "runtime-request.updated", payload: { status: "cancelled" } }));
    assert.isFalse(signal({ type: "runtime-request.updated", payload: { status: "pending" } }));
  }),
);
