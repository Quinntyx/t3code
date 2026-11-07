import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const layerProviderRegistry = (
  changes: Stream.Stream<ReadonlyArray<ServerProvider>> = Stream.never,
) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([]),
    streamChanges: changes,
  });

const verifySweep = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    const sweeps = yield* Queue.unbounded<void>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Queue.offer(sweeps, undefined).pipe(Effect.as([])),
          }),
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
          layerProviderRegistry(),
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

const window = (id: string, usedPercent: number, resetsAt = "2026-07-01T00:00:00.000Z") => ({
  id,
  kind: "session" as const,
  label: id,
  usedPercent,
  resetsAt,
});
const limits = (
  windows: ReadonlyArray<ReturnType<typeof window>>,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({ checkedAt: "2026-06-30T00:00:00.000Z", windows, ...extra });

const instanceId = ProviderInstanceId.make("codex");
const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
const report = (
  previous: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>,
  next: ServerProviderUsageLimits,
) => UsageLimitRecoveryWorker.observeLimitReport(previous, new Map([[instanceId, next]]), nowMs);
const changes = (
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits,
) => {
  const { observed, spent } = report(
    previous === undefined ? new Map() : new Map([[instanceId, previous]]),
    next,
  );
  return { observed, spent };
};

it("observes an instance whose allowance came back", () => {
  assert.deepEqual(changes(limits([window("primary", 100)]), limits([window("primary", 0)])), {
    observed: [instanceId],
    spent: [],
  });
  // A probe that never reached 100% still gives the allowance back.
  assert.deepEqual(
    changes(limits([window("primary", 99)]), limits([window("primary", 0)])).observed,
    [instanceId],
  );
  // A window that rolled over to a later reset clock came back even at the same spend.
  assert.deepEqual(
    changes(
      limits([window("primary", 40)]),
      limits([window("primary", 40, "2026-07-01T05:00:00.000Z")]),
    ).observed,
    [instanceId],
  );
});

it("holds an instance whose allowance is still spent", () => {
  // One window resetting does not free a model the other window still blocks.
  assert.deepEqual(
    changes(
      limits([window("primary", 100), window("weekly", 100)]),
      limits([window("primary", 0), window("weekly", 100)]),
    ),
    { observed: [], spent: [instanceId] },
  );
  // A probe that stops reporting a spent window has not shown that it came back.
  assert.deepEqual(
    changes(limits([window("primary", 100), window("weekly", 40)]), limits([window("weekly", 39)])),
    { observed: [], spent: [instanceId] },
  );
});

it("remembers a spent window a probe stopped reporting", () => {
  const first = report(new Map(), limits([window("primary", 100), window("weekly", 40)]));
  assert.deepEqual(first.spent, [instanceId]);
  const partial = report(first.limits, limits([window("weekly", 39)]));
  assert.deepEqual(partial.observed, []);
  assert.deepEqual(
    partial.limits
      .get(instanceId)
      ?.windows.map((entry) => entry.id)
      .sort(),
    ["primary", "weekly"],
  );
  // The window comes back reported and unspent, so the allowance really did return.
  const recovered = report(partial.limits, limits([window("primary", 0), window("weekly", 39)]));
  assert.deepEqual(recovered.observed, [instanceId]);
});

it("ignores the rounding gap between a probe and streamed usage", () => {
  assert.deepEqual(
    changes(limits([window("primary", 58)]), limits([window("primary", 57.99999999999999)])),
    { observed: [], spent: [] },
  );
});

it("ignores reports that do not move the allowance", () => {
  assert.deepEqual(changes(limits([window("primary", 100)]), limits([window("primary", 100)])), {
    observed: [],
    spent: [instanceId],
  });
  // The first report only establishes a baseline.
  assert.deepEqual(changes(undefined, limits([window("primary", 0)])), { observed: [], spent: [] });
  // An unreadable account keeps what was last known about it.
  assert.deepEqual(
    changes(
      limits([window("primary", 100)]),
      limits([], { unavailable: { reason: "probeFailed" } }),
    ),
    { observed: [], spent: [instanceId] },
  );
  // Another login's windows describe a different allowance.
  assert.deepEqual(
    changes(
      limits([window("primary", 100)], { credentialFingerprint: "first" }),
      limits([window("primary", 0)], { credentialFingerprint: "second" }),
    ),
    { observed: [], spent: [] },
  );
});

const waitingThread = (
  resetAt: string,
  overrides: Partial<ProjectionStore.ProjectionLimitRecoveryCandidate> = {},
): ProjectionStore.ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make("thread:waiting"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("run:waiting"),
  usageLimitResetAt: resetAt,
  latestRunCompletedAt: DateTime.makeUnsafe("2026-06-30T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-06-30T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  limitRecovery: {
    runId: RunId.make("run:waiting"),
    resetAt,
    autoResume: true,
    requestId: CommandId.make("recovery:choice"),
  },
  snoozedUntil: null,
  hasLinkedPullRequest: false,
  ...overrides,
});

const resetAt = "2026-07-01T00:00:00.000Z";
const beforeReset = Date.parse("2026-06-30T12:00:00.000Z");

it("waits for the recorded reset time until the provider reports one", () => {
  const thread = waitingThread(resetAt);
  assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, beforeReset));
  const command = UsageLimitRecoveryWorker.limitRecoveryCommand(
    thread,
    true,
    beforeReset,
    false,
    beforeReset,
  );
  assert.equal(command?.type, "message.dispatch");
  assert.isTrue(command?.type === "message.dispatch" && command.usageLimitResetObserved === true);
});

it("keeps an unarmed thread arming instead of resuming it early", () => {
  const thread = waitingThread(resetAt, { limitRecovery: null });
  const command = UsageLimitRecoveryWorker.limitRecoveryCommand(
    thread,
    true,
    beforeReset,
    false,
    beforeReset,
  );
  assert.equal(command?.type, "thread.metadata.update");
});

it("ends a snooze that only lasted until the reset", () => {
  const thread = waitingThread(resetAt, { snoozedUntil: DateTime.makeUnsafe(resetAt) });
  const command = UsageLimitRecoveryWorker.limitRecoveryCommand(
    thread,
    true,
    beforeReset,
    false,
    beforeReset,
  );
  assert.equal(command?.type, "message.dispatch");
});

it("holds a snooze that outlasts the reset", () => {
  const thread = waitingThread(resetAt, {
    snoozedUntil: DateTime.makeUnsafe("2026-07-01T02:00:00.000Z"),
  });
  assert.isNull(
    UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, beforeReset, false, beforeReset),
  );
});

it("holds a thread whose resume the user cancelled", () => {
  const thread = waitingThread(resetAt, {
    limitRecovery: {
      runId: RunId.make("run:waiting"),
      resetAt,
      autoResume: false,
      requestId: CommandId.make("recovery:choice"),
    },
  });
  assert.isNull(
    UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, beforeReset, false, beforeReset),
  );
});

it("leaves a thread that failed after the report on its own clock", () => {
  const thread = waitingThread(resetAt, {
    latestRunCompletedAt: DateTime.makeUnsafe("2026-06-30T13:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-06-30T13:00:00.000Z"),
  });
  assert.isNull(
    UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, beforeReset, false, beforeReset),
  );
});

it.effect("resumes a waiting thread as soon as the provider reports the limit back", () =>
  Effect.gen(function* () {
    const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const now = yield* DateTime.now;
    const thread = waitingThread(DateTime.formatIso(DateTime.add(now, { hours: 1 })), {
      latestRunCompletedAt: DateTime.subtract(now, { minutes: 5 }),
      updatedAt: DateTime.subtract(now, { minutes: 5 }),
    });
    // A pull-request thread that failed after the report keeps its own clock, so it must not
    // hold the first allowance back from the thread that can use it.
    const blocking = waitingThread(DateTime.formatIso(DateTime.add(now, { hours: 1 })), {
      id: ThreadId.make("thread:pull-request"),
      hasLinkedPullRequest: true,
      latestRunCompletedAt: DateTime.add(now, { minutes: 1 }),
      updatedAt: DateTime.add(now, { minutes: 1 }),
    });
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            // The projection only offers waiting threads when the sweep asks for them.
            getLimitRecoveryCandidates: (options) =>
              Effect.succeed(options.resetObserved === true ? [blocking, thread] : []),
            hasActivePullRequestThread: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              autoResumePullRequestThreadsFirst: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
          layerProviderRegistry(Stream.fromQueue(providerChanges)),
        ),
      ),
    );
    const instance = (usedPercent: number) =>
      [
        {
          instanceId: thread.providerInstanceId,
          usageLimits: limits([window("primary", usedPercent)]),
        },
      ] as unknown as ReadonlyArray<ServerProvider>;
    yield* Effect.gen(function* () {
      yield* Queue.offer(providerChanges, instance(100));
      // A thread that failed after the report keeps its own clock, so this one is not retried.
      yield* Queue.offer(providerChanges, instance(0));
      const command = yield* Queue.take(dispatched);
      assert.equal(command.type, "message.dispatch");
      assert.equal("threadId" in command ? command.threadId : null, thread.id);
      assert.isTrue(
        command.type === "message.dispatch" && command.usageLimitResetObserved === true,
      );
      assert.equal(
        command.type === "message.dispatch" ? command.usageLimitContinuationOfRunId : null,
        thread.latestRunId,
      );
    }).pipe(Effect.provide(layer));
  }),
);

const limited = (id: string, hasLinkedPullRequest: boolean) => ({ id, hasLinkedPullRequest });
const limitedThreads = [
  limited("without-pull-request", false),
  limited("with-pull-request", true),
  limited("also-with-pull-request", true),
];
const selected = (
  candidates: ReadonlyArray<ReturnType<typeof limited>>,
  prioritizePullRequests: boolean,
  activePullRequestThread: boolean,
) =>
  UsageLimitRecoveryWorker.selectLimitRecoveryCandidates(candidates, {
    prioritizePullRequests,
    activePullRequestThread,
  }).map((candidate) => candidate.id);

it("resumes every limited thread when pull requests do not come first", () => {
  assert.deepEqual(
    selected(limitedThreads, false, false),
    limitedThreads.map((row) => row.id),
  );
  assert.deepEqual(
    selected(limitedThreads, false, true),
    limitedThreads.map((row) => row.id),
  );
  assert.deepEqual(selected([limitedThreads[0]!], false, true), ["without-pull-request"]);
});

it("resumes only pull-request threads while any of them are limited", () => {
  assert.deepEqual(selected(limitedThreads, true, false), [
    "with-pull-request",
    "also-with-pull-request",
  ]);
});

it("holds other limited threads while a pull-request thread is still working", () => {
  assert.deepEqual(selected(limitedThreads, true, true), [
    "with-pull-request",
    "also-with-pull-request",
  ]);
  assert.deepEqual(selected([limitedThreads[0]!], true, true), []);
});

it("resumes other limited threads once pull-request work finishes", () => {
  assert.deepEqual(selected([limitedThreads[0]!], true, false), ["without-pull-request"]);
});
