import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const layerProviderRegistry = (
  changes: Stream.Stream<ReadonlyArray<ServerProvider>> = Stream.never,
) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([]),
    streamChanges: changes,
  });

const layerResetSources = (
  changes: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>> = Stream.never,
) =>
  Layer.mergeAll(
    IdAllocator.layer,
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed([]),
      streamChanges: changes,
    }),
    Layer.mock(EventSink.EventSinkV2)({}),
  );

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          layerResetSources(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitFailuresWithoutReset: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
          layerProviderRegistry(),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "running" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 60s does not wake it; the run update does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
      // A failed run sweeps as soon as it commits instead of waiting for the next tick.
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["provider", "hub"] as const)(
  "rechecks missing resets after an idle %s usage update",
  (source) =>
    Effect.gen(function* () {
      const queries = yield* Ref.make(0);
      const sweeps = yield* Queue.unbounded<void>();
      const changes = yield* Queue.unbounded<void>();
      const reports = Stream.fromQueue(changes);
      const providerReports = reports.pipe(
        Stream.as([
          {
            instanceId: ProviderInstanceId.make("limited"),
            usageLimits: limits([window("weekly", 100)]),
          },
        ] as unknown as ReadonlyArray<ServerProvider>),
      );
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            layerProviderRegistry(source === "provider" ? providerReports : Stream.never),
            layerResetSources(source === "hub" ? reports.pipe(Stream.as([])) : Stream.never),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getUsageLimitFailuresWithoutReset: () =>
                Ref.update(queries, (count) => count + 1).pipe(Effect.as([])),
              getLimitRecoveryCandidates: () => Queue.offer(sweeps, undefined).pipe(Effect.as([])),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                autoResumeLimitedThreads: false,
                snoozeLimitedThreads: false,
              } as never),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Queue.take(sweeps);
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Ref.get(queries), 1);
        yield* Queue.offer(changes, undefined);
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Ref.get(queries), 2);
      }).pipe(Effect.provide(layer));
    }),
);

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
            getLimitRecoveryWakeAt: () => Effect.succeed(null),
          }),
          layerResetSources(),
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
    assert.isTrue(
      signal({ type: "turn-item.updated", payload: { type: "subagent", status: "completed" } }),
    );
    assert.isFalse(
      signal({ type: "turn-item.updated", payload: { type: "subagent", status: "running" } }),
    );
  }),
);

const window = (id: string, usedPercent: number, resetsAt = "2026-07-01T00:00:00.000Z") => ({
  id,
  kind: "session" as const,
  label: id,
  usedPercent,
  resetsAt,
});
// A spend budget such as Claude's monthly spend: no reset clock to say when it stops blocking.
const budget = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
  id,
  kind: "monthly",
  label: id,
  usedPercent,
});
const limits = (
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({ checkedAt: "2026-06-30T00:00:00.000Z", windows, ...extra });

const HOUR_MS = 60 * 60 * 1000;
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
  const { observedWindows, spentWindows } = report(
    previous === undefined ? new Map() : new Map([[instanceId, previous]]),
    next,
  );
  return {
    observed: observedWindows.get(instanceId) ?? [],
    spent: spentWindows.get(instanceId) ?? [],
  };
};

it("observes windows whose allowance came back", () => {
  assert.deepEqual(changes(limits([window("primary", 100)]), limits([window("primary", 0)])), {
    observed: ["primary"],
    spent: [],
  });
  // A probe that never reached 100% still observes a reset to zero or a large drop near exhaustion.
  assert.deepEqual(
    changes(limits([window("primary", 99)]), limits([window("primary", 0)])).observed,
    ["primary"],
  );
  assert.deepEqual(
    changes(limits([window("primary", 95)]), limits([window("primary", 50)])).observed,
    ["primary"],
  );
  // A window that rolled over to a later reset clock came back even at the same spend.
  assert.deepEqual(
    changes(
      limits([window("primary", 40)]),
      limits([window("primary", 40, "2026-07-01T05:00:00.000Z")]),
    ).observed,
    ["primary"],
  );
});

it("tracks spent and recovered windows independently", () => {
  // One window resetting while another stays spent reports both windows accurately.
  assert.deepEqual(
    changes(
      limits([window("primary", 100), window("weekly", 100)]),
      limits([window("primary", 0), window("weekly", 100)]),
    ),
    { observed: ["primary"], spent: ["weekly"] },
  );
  // A probe that stops reporting a spent window carries it forward as still spent.
  assert.deepEqual(
    changes(limits([window("primary", 100), window("weekly", 40)]), limits([window("weekly", 39)])),
    { observed: [], spent: ["primary"] },
  );
});

it("remembers a spent window a probe stopped reporting", () => {
  const first = report(new Map(), limits([window("primary", 100), window("weekly", 40)]));
  assert.deepEqual(first.spentWindows.get(instanceId), ["primary"]);
  const partial = report(first.limits, limits([window("weekly", 39)]));
  assert.isUndefined(partial.observedWindows.get(instanceId));
  assert.deepEqual(
    partial.limits
      .get(instanceId)
      ?.windows.map((entry) => entry.id)
      .sort(),
    ["primary", "weekly"],
  );
  // The window comes back reported and unspent, so the allowance really did return.
  const recovered = report(partial.limits, limits([window("primary", 0), window("weekly", 39)]));
  assert.deepEqual(recovered.observedWindows.get(instanceId), ["primary"]);
  assert.isUndefined(recovered.spentWindows.get(instanceId));
});

it("does not keep a spent window that has no reset clock", () => {
  const first = report(new Map(), limits([window("five_hour", 100), budget("monthly_spend", 100)]));
  assert.deepEqual(first.spentWindows.get(instanceId), ["five_hour", "monthly_spend"]);
  // The budget stops being reported and never had a clock, so it cannot hold the instance spent
  // forever; the session window coming back is the allowance returning.
  const recovered = report(first.limits, limits([window("five_hour", 0)]));
  assert.deepEqual(recovered.observedWindows.get(instanceId), ["five_hour"]);
  assert.isUndefined(recovered.spentWindows.get(instanceId));
  assert.deepEqual(
    recovered.limits.get(instanceId)?.windows.map((entry) => entry.id),
    ["five_hour"],
  );
});

it("ignores the rounding gap between a probe and streamed usage", () => {
  assert.deepEqual(
    changes(limits([window("primary", 58)]), limits([window("primary", 57.99999999999999)])),
    { observed: [], spent: [] },
  );
  assert.deepEqual(changes(limits([window("primary", 100)]), limits([window("primary", 99.49)])), {
    observed: [],
    spent: [],
  });
  assert.deepEqual(
    changes(limits([window("primary", 95.51)]), limits([window("primary", 95.49)])),
    { observed: [], spent: [] },
  );
});

it("ignores reports that do not move the allowance", () => {
  assert.deepEqual(changes(limits([window("primary", 100)]), limits([window("primary", 100)])), {
    observed: [],
    spent: ["primary"],
  });
  // The first report only establishes a baseline.
  assert.deepEqual(changes(undefined, limits([window("primary", 0)])), { observed: [], spent: [] });
  // An unreadable account keeps what was last known about it.
  assert.deepEqual(
    changes(
      limits([window("primary", 100)]),
      limits([], { unavailable: { reason: "probeFailed" } }),
    ),
    { observed: [], spent: ["primary"] },
  );
  // Another login's windows describe a different allowance.
  assert.deepEqual(
    changes(
      limits([window("primary", 100)], { credentialFingerprint: "first" }),
      limits([window("primary", 0)], { credentialFingerprint: "second" }),
    ),
    { observed: [], spent: [] },
  );
  // Small API clock jitter on resetsAt is not a window rollover, even when duration is omitted on sparse updates.
  assert.deepEqual(
    changes(
      limits([
        { ...window("3p-weekly", 80, "2026-07-01T00:00:00.000Z"), windowDurationMins: 10080 },
      ]),
      limits([window("3p-weekly", 80, "2026-07-01T01:00:00.000Z")]),
    ),
    { observed: [], spent: [] },
  );
  // An idle 0% rolling window moving its reset clock forward is wall-clock drift, not a reset.
  assert.deepEqual(
    changes(
      limits([{ ...window("go_rolling", 0, "2026-07-01T00:00:00.000Z"), windowDurationMins: 300 }]),
      limits([{ ...window("go_rolling", 0, "2026-07-01T05:00:00.000Z"), windowDurationMins: 300 }]),
    ),
    { observed: [], spent: [] },
  );
  // Small rolling decay on an unspent window (even at 90-99%) does not mean a blocking limit reset.
  assert.deepEqual(
    changes(limits([window("go_rolling", 94)]), limits([window("go_rolling", 93)])),
    {
      observed: [],
      spent: [],
    },
  );
  assert.deepEqual(changes(limits([window("gemini-5h", 1.7)]), limits([window("gemini-5h", 0)])), {
    observed: [],
    spent: [],
  });
  assert.deepEqual(
    changes(limits([window("gemini-weekly", 35)]), limits([window("gemini-weekly", 34)])),
    { observed: [], spent: [] },
  );
  assert.deepEqual(
    changes(limits([window("go_rolling", 30)]), limits([window("go_rolling", 15)])),
    { observed: [], spent: [] },
  );
  // A resetsAt jump while spend is rising does not prove allowance came back.
  assert.deepEqual(
    changes(
      limits([{ ...window("primary", 1, "2026-07-01T00:00:00.000Z"), windowDurationMins: 300 }]),
      limits([{ ...window("primary", 2, "2026-07-01T05:00:00.000Z"), windowDurationMins: 300 }]),
    ),
    { observed: [], spent: [] },
  );
  // A monthly window omitting windowDurationMins still uses a monthly rollover threshold.
  assert.deepEqual(
    changes(
      limits([
        {
          id: "go_monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 40,
          resetsAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
      limits([
        {
          id: "go_monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 40,
          resetsAt: "2026-08-01T01:00:00.000Z",
        },
      ]),
    ),
    { observed: [], spent: [] },
  );
  // An unsupported report (logout / API key / no subscription) clears prior limits instead of
  // retaining them as probeFailed does, so a later login's 0% reading is only a fresh baseline.
  const afterLogout = report(
    new Map([[instanceId, limits([window("primary", 100)])]]),
    limits([], { unavailable: { reason: "unsupported" } }),
  );
  assert.isDefined(afterLogout.limits.get(instanceId)?.unavailable);
  assert.isUndefined(
    report(afterLogout.limits, limits([window("primary", 0)])).observedWindows.get(instanceId),
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
  latestRunProviderInstanceId: overrides.providerInstanceId ?? ProviderInstanceId.make("codex"),
  latestRunModel: null,
  threadModel: null,
  latestRunUsageLimitContinuationOfRunId: null,
  usageLimitResetAt: resetAt,
  latestRunCompletedAt: DateTime.makeUnsafe("2026-06-30T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-06-30T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
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

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  return waitingThread(DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)), {
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    limitRecovery: null,
  });
};

const resetAt = "2026-07-01T00:00:00.000Z";

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("keeps an unarmed thread arming instead of resuming it early", () => {
    const thread = waitingThread(resetAt, { limitRecovery: null });
    const command = limitRecoveryCommand(thread, true, nowMs, false, nowMs);
    assert.equal(command?.type, "thread.metadata.update");
  });

  it("defers arming, auto-snoozing, and resuming while active subagents or workflows are running", () => {
    const unarmed = waitingThread(resetAt, { limitRecovery: null });
    assert.isNull(
      limitRecoveryCommand(
        {
          ...unarmed,
          pendingBackgroundTasks: [{ taskId: "wf-1", kind: "subagent" }],
        },
        true,
        nowMs,
        true,
      ),
    );
    const armed = waitingThread(resetAt);
    assert.isNull(
      limitRecoveryCommand(
        {
          ...armed,
          pendingBackgroundTasks: [{ taskId: "wf-1", kind: "subagent" }],
        },
        true,
        Date.parse(resetAt),
      ),
    );
  });
});

it("waits for the recorded reset time until the provider reports one", () => {
  const thread = waitingThread(resetAt);
  assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  const command = limitRecoveryCommand(thread, true, nowMs, false, nowMs);
  assert.equal(command?.type, "message.dispatch");
  assert.isTrue(command?.type === "message.dispatch" && command.usageLimitResetObserved === true);
  assert.isTrue(
    command?.type === "message.dispatch" &&
      command.createdBy === "agent" &&
      command.creationSource === "server",
  );
});

it("ends a snooze that only lasted until the reset", () => {
  const thread = waitingThread(resetAt, { snoozedUntil: DateTime.makeUnsafe(resetAt) });
  const command = limitRecoveryCommand(thread, true, nowMs, false, nowMs);
  assert.equal(command?.type, "message.dispatch");
});

it("holds a snooze that outlasts the reset", () => {
  const thread = waitingThread(resetAt, {
    snoozedUntil: DateTime.makeUnsafe("2026-07-01T02:00:00.000Z"),
  });
  assert.isNull(limitRecoveryCommand(thread, true, nowMs, false, nowMs));
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
  assert.isNull(limitRecoveryCommand(thread, true, nowMs, false, nowMs));
});

it("leaves a thread that failed after the report on its own clock", () => {
  const thread = waitingThread(resetAt, {
    latestRunCompletedAt: DateTime.makeUnsafe("2026-06-30T13:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-06-30T13:00:00.000Z"),
  });
  assert.isNull(limitRecoveryCommand(thread, true, nowMs, false, nowMs));
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
            getUsageLimitFailuresWithoutReset: () => Effect.succeed([]),
            // The projection only offers waiting threads when the sweep asks for them.
            getLimitRecoveryCandidates: (options) =>
              Effect.succeed(options.resetObserved === true ? [blocking, thread] : []),
            getLimitRecoveryWakeAt: () => Effect.succeed(null),
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
          layerResetSources(),
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

it.effect(
  "matches observed resets to the failed run's quota pool and stops early-resume loops",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T00:00:00.000Z"));
      const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const domainEvents = yield* Queue.unbounded<{
        readonly event: OrchestrationV2DomainEvent;
        readonly onPull?: Deferred.Deferred<void>;
      }>();
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const now = yield* DateTime.now;
      const futureResetAt = DateTime.formatIso(DateTime.add(now, { hours: 2 }));
      const piInstanceId = ProviderInstanceId.make("pi_main");
      const agInstanceId = ProviderInstanceId.make("antigravity_main");
      const piProxyThread = waitingThread(futureResetAt, {
        id: ThreadId.make("thread:pi-proxy"),
        providerInstanceId: piInstanceId,
        latestRunId: RunId.make("run:pi-proxy:1"),
        latestRunModel: "cliproxyapi/gpt-6.2-sol",
        threadModel: "cliproxyapi/gpt-6.2-sol",
        latestRunUsageLimitContinuationOfRunId: null,
        latestRunCompletedAt: DateTime.subtract(now, { minutes: 5 }),
        updatedAt: DateTime.subtract(now, { minutes: 5 }),
        limitRecovery: {
          runId: RunId.make("run:pi-proxy:1"),
          resetAt: futureResetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:pi-proxy"),
        },
      });
      const piSwitchedThread = waitingThread(futureResetAt, {
        id: ThreadId.make("thread:pi-switched"),
        providerInstanceId: piInstanceId,
        latestRunId: RunId.make("run:pi-switched:1"),
        latestRunModel: "opencode-go/big-pickle",
        threadModel: "cliproxyapi/gpt-6.2-sol",
        latestRunUsageLimitContinuationOfRunId: null,
        latestRunCompletedAt: DateTime.subtract(now, { minutes: 5 }),
        updatedAt: DateTime.subtract(now, { minutes: 5 }),
        limitRecovery: {
          runId: RunId.make("run:pi-switched:1"),
          resetAt: futureResetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:pi-switched"),
        },
      });
      const piGoThread = waitingThread(futureResetAt, {
        id: ThreadId.make("thread:pi-go"),
        providerInstanceId: piInstanceId,
        latestRunId: RunId.make("run:pi-go:1"),
        latestRunModel: "opencode-go/big-pickle",
        threadModel: "opencode-go/big-pickle",
        latestRunUsageLimitContinuationOfRunId: null,
        latestRunCompletedAt: DateTime.subtract(now, { minutes: 5 }),
        updatedAt: DateTime.subtract(now, { minutes: 5 }),
        limitRecovery: {
          runId: RunId.make("run:pi-go:1"),
          resetAt: futureResetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:pi-go"),
        },
      });
      const agGeminiThread = waitingThread(futureResetAt, {
        id: ThreadId.make("thread:ag-gemini"),
        providerInstanceId: agInstanceId,
        latestRunId: RunId.make("run:ag-gemini:1"),
        latestRunModel: "gemini-4-neon",
        threadModel: "gemini-4-neon",
        latestRunUsageLimitContinuationOfRunId: null,
        latestRunCompletedAt: DateTime.subtract(now, { minutes: 5 }),
        updatedAt: DateTime.subtract(now, { minutes: 5 }),
        limitRecovery: {
          runId: RunId.make("run:ag-gemini:1"),
          resetAt: futureResetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:ag-gemini"),
        },
      });
      // Place non-matching threads before piGoThread so any false match dispatches first.
      const candidatesRef = yield* Ref.make<
        ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>
      >([piProxyThread, piSwitchedThread, agGeminiThread, piGoThread]);
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getUsageLimitFailuresWithoutReset: () => Effect.succeed([]),
              getLimitRecoveryCandidates: (options) =>
                Ref.get(candidatesRef).pipe(
                  Effect.map((rows) =>
                    options.resetObserved === true ||
                    DateTime.toEpochMillis(options.now) >= Date.parse(futureResetAt)
                      ? rows
                      : [],
                  ),
                ),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
              hasActivePullRequestThread: () => Effect.succeed(false),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromEffect(
                Queue.take(domainEvents).pipe(
                  Effect.tap((entry) =>
                    entry.onPull === undefined
                      ? Effect.void
                      : Deferred.succeed(entry.onPull, undefined),
                  ),
                  Effect.map((entry) => entry.event),
                ),
              ).pipe(Stream.forever),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                autoResumeLimitedThreads: true,
                autoResumePullRequestThreadsFirst: false,
                snoozeLimitedThreads: false,
              } as never),
              streamChanges: Stream.never,
            }),
            layerProviderRegistry(Stream.fromQueue(providerChanges)),
            layerResetSources(),
          ),
        ),
      );
      const snapshot = (input: {
        readonly goRolling: number;
        readonly gemini5h: number;
        readonly thirdPartyWeekly: number;
      }) =>
        [
          {
            instanceId: piInstanceId,
            driver: ProviderDriverKind.make("pi"),
            usageLimits: limits([window("go_rolling", input.goRolling, futureResetAt)], {
              ownerDriver: ProviderDriverKind.make("opencode"),
            }),
          },
          {
            instanceId: agInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            usageLimits: limits([
              window("gemini-5h", input.gemini5h, futureResetAt),
              window("3p-weekly", input.thirdPartyWeekly, futureResetAt),
            ]),
          },
        ] as unknown as ReadonlyArray<ServerProvider>;
      yield* Effect.gen(function* () {
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 100, gemini5h: 100, thirdPartyWeekly: 100 }),
        );
        // OpenCode Go resets and 3p-weekly resets while gemini-5h stays spent:
        // only pi-go matches; pi-proxy (cliproxyapi/*), pi-switched (switched to unmonitored model),
        // and ag-gemini (gemini-*) must stay waiting.
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 0, gemini5h: 100, thirdPartyWeekly: 0 }),
        );
        const first = yield* Queue.take(dispatched);
        assert.equal("threadId" in first ? first.threadId : null, piGoThread.id);
        assert.equal(yield* Queue.size(dispatched), 0);

        // Now pi-go fails again immediately on run 2 (continuation of run 1) for the same reset window (2s jitter).
        const jitteredResetAt = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(futureResetAt), { seconds: 2 }),
        );
        yield* TestClock.adjust("5 seconds");
        const failedAgainAt = yield* DateTime.now;
        const piGoContinuationFailed = {
          ...piGoThread,
          latestRunId: RunId.make("run:pi-go:2"),
          latestRunUsageLimitContinuationOfRunId: piGoThread.latestRunId,
          usageLimitResetAt: jitteredResetAt,
          latestRunCompletedAt: failedAgainAt,
          updatedAt: failedAgainAt,
          limitRecovery: {
            runId: RunId.make("run:pi-go:2"),
            resetAt: jitteredResetAt,
            autoResume: true,
            requestId: CommandId.make("recovery:pi-go:2"),
          },
        };
        yield* Ref.set(candidatesRef, [piProxyThread, piGoContinuationFailed, agGeminiThread]);
        // Cancelling an unstarted queued message must not clear the early-resume loop guard.
        const unstartedCancelApplied = yield* Deferred.make<void>();
        yield* Queue.offer(domainEvents, {
          event: {
            type: "run.updated",
            threadId: piGoThread.id,
            payload: { status: "cancelled", startedAt: null },
          } as unknown as OrchestrationV2DomainEvent,
        });
        yield* Queue.offer(domainEvents, {
          event: {
            type: "turn-item.updated",
            threadId: piGoThread.id,
            payload: { type: "assistant_message" },
          } as unknown as OrchestrationV2DomainEvent,
          onPull: unstartedCancelApplied,
        });
        yield* Deferred.await(unstartedCancelApplied);
        yield* TestClock.adjust("1 second");
        // Even if go_rolling flaps 100 -> 0 again, pi-go must not early-resume again for the same continuation.
        // Meanwhile gemini-5h resets 100 -> 0 (while 3p-weekly is back to 100): ag-gemini DOES resume.
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 100, gemini5h: 100, thirdPartyWeekly: 100 }),
        );
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 0, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        const second = yield* Queue.take(dispatched);
        assert.equal("threadId" in second ? second.threadId : null, agGeminiThread.id);
        assert.equal(yield* Queue.size(dispatched), 0);

        // A completed run on pi-go clears the early-resume guard so a later recovery can early-resume.
        const completedApplied = yield* Deferred.make<void>();
        yield* Queue.offer(domainEvents, {
          event: {
            type: "run.updated",
            threadId: piGoThread.id,
            payload: { status: "completed", startedAt: failedAgainAt },
          } as unknown as OrchestrationV2DomainEvent,
        });
        yield* Queue.offer(domainEvents, {
          event: {
            type: "turn-item.updated",
            threadId: piGoThread.id,
            payload: { type: "assistant_message" },
          } as unknown as OrchestrationV2DomainEvent,
          onPull: completedApplied,
        });
        yield* Deferred.await(completedApplied);
        yield* Ref.set(candidatesRef, [piProxyThread, piGoContinuationFailed]);
        yield* TestClock.adjust("1 second");
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 100, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 0, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        const afterCompleted = yield* Queue.take(dispatched);
        assert.equal("threadId" in afterCompleted ? afterCompleted.threadId : null, piGoThread.id);
        assert.isTrue(
          afterCompleted.type === "message.dispatch" &&
            afterCompleted.usageLimitResetObserved === true,
        );

        // A later manual run on pi-go (not a continuation of run 1) is NOT suppressed by run 1's guard.
        yield* TestClock.adjust("5 seconds");
        const manualFailedAt = yield* DateTime.now;
        const piGoManualFailed = {
          ...piGoContinuationFailed,
          latestRunId: RunId.make("run:pi-go:3"),
          latestRunUsageLimitContinuationOfRunId: null,
          latestRunCompletedAt: manualFailedAt,
          updatedAt: manualFailedAt,
          limitRecovery: {
            runId: RunId.make("run:pi-go:3"),
            resetAt: jitteredResetAt,
            autoResume: true,
            requestId: CommandId.make("recovery:pi-go:3"),
          },
        };
        yield* Ref.set(candidatesRef, [piProxyThread, piGoManualFailed]);
        yield* TestClock.adjust("1 second");
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 100, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 0, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        const manualResumed = yield* Queue.take(dispatched);
        assert.equal("threadId" in manualResumed ? manualResumed.threadId : null, piGoThread.id);
        assert.isTrue(
          manualResumed.type === "message.dispatch" &&
            manualResumed.usageLimitResetObserved === true,
        );

        // Once the real reset clock passes, pi-proxy and pi-switched still auto-resume normally.
        yield* Ref.set(candidatesRef, [piProxyThread, piSwitchedThread]);
        yield* TestClock.setTime(Date.parse(jitteredResetAt));
        yield* Queue.offer(
          providerChanges,
          snapshot({ goRolling: 0, gemini5h: 0, thirdPartyWeekly: 100 }),
        );
        const third = yield* Queue.take(dispatched);
        const fourth = yield* Queue.take(dispatched);
        assert.deepEqual(
          [
            "threadId" in third ? third.threadId : null,
            "threadId" in fourth ? fourth.threadId : null,
          ],
          [piProxyThread.id, piSwitchedThread.id],
        );
        assert.isFalse(third.type === "message.dispatch" && third.usageLimitResetObserved === true);
        assert.isFalse(
          fourth.type === "message.dispatch" && fourth.usageLimitResetObserved === true,
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("drops reset observations on logout/account clear and rechecks mid-sweep updates", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T00:00:00.000Z"));
    const providerChanges = yield* Queue.unbounded<{
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly onPull?: Deferred.Deferred<void>;
    }>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const sqlStarted = yield* Deferred.make<void>();
    const releaseSql = yield* Deferred.make<void>();
    const gateFirstSql = yield* Ref.make(false);
    const sweeps = yield* Queue.unbounded<boolean>();
    const now = yield* DateTime.now;
    const futureResetAt = DateTime.formatIso(DateTime.add(now, { hours: 2 }));
    const codexId = ProviderInstanceId.make("codex_main");
    const makeCandidate = (runId: string, failedAt: DateTime.Utc) =>
      waitingThread(futureResetAt, {
        id: ThreadId.make("thread:codex-race"),
        providerInstanceId: codexId,
        latestRunId: RunId.make(runId),
        latestRunModel: "gpt-5.3-codex",
        threadModel: "gpt-5.3-codex",
        latestRunUsageLimitContinuationOfRunId: null,
        latestRunCompletedAt: failedAt,
        updatedAt: failedAt,
        limitRecovery: {
          runId: RunId.make(runId),
          resetAt: futureResetAt,
          autoResume: true,
          requestId: CommandId.make(`recovery:${runId}`),
        },
      });
    const candidatesRef = yield* Ref.make<
      ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>
    >([makeCandidate("run:codex:1", DateTime.subtract(now, { minutes: 5 }))]);
    // Pull one report at a time so an `onPull` barrier resolves only after the prior report's
    // providerState Ref.update has committed.
    const providerStream = Stream.fromEffect(
      Queue.take(providerChanges).pipe(
        Effect.tap((entry) =>
          entry.onPull === undefined ? Effect.void : Deferred.succeed(entry.onPull, undefined),
        ),
        Effect.map((entry) => entry.providers),
      ),
    ).pipe(Stream.forever);
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitFailuresWithoutReset: () => Effect.succeed([]),
            getLimitRecoveryCandidates: (options) =>
              Effect.gen(function* () {
                if (options.resetObserved === true && (yield* Ref.getAndSet(gateFirstSql, false))) {
                  yield* Deferred.succeed(sqlStarted, undefined);
                  yield* Deferred.await(releaseSql);
                }
                yield* Queue.offer(sweeps, options.resetObserved === true);
                return options.resetObserved === true ? yield* Ref.get(candidatesRef) : [];
              }),
            getLimitRecoveryWakeAt: () => Effect.succeed(null),
            hasActivePullRequestThread: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              autoResumePullRequestThreadsFirst: false,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
          layerProviderRegistry(providerStream),
          layerResetSources(),
        ),
      ),
    );
    const codexSnapshot = (
      usedPercent?: number | "unsupported" | "probeFailed",
      options?: {
        readonly fingerprint?: string;
        readonly email?: string;
        readonly workspaceId?: string;
        readonly unauthenticated?: boolean;
      },
    ) =>
      [
        {
          instanceId: codexId,
          driver: ProviderDriverKind.make("codex"),
          auth: {
            status: options?.unauthenticated ? "unauthenticated" : "authenticated",
            ...(options?.email === undefined ? {} : { email: options.email }),
            ...(options?.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          },
          ...(usedPercent === undefined
            ? {}
            : usedPercent === "unsupported" || usedPercent === "probeFailed"
              ? { usageLimits: limits([], { unavailable: { reason: usedPercent } }) }
              : {
                  usageLimits: limits(
                    [window("primary", usedPercent, futureResetAt)],
                    options?.fingerprint === undefined
                      ? {}
                      : { credentialFingerprint: options.fingerprint },
                  ),
                }),
        },
      ] as unknown as ReadonlyArray<ServerProvider>;
    yield* Effect.gen(function* () {
      // 1. Mid-sweep invalidation: a reset triggers a sweep, then the window turns 100% spent
      //    while SQL is in flight. The pre-dispatch recheck must cancel the stale early dispatch.
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "a@example.com" }),
      });
      yield* Queue.take(sweeps);
      yield* Ref.set(gateFirstSql, true);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "a@example.com" }),
      });
      yield* Deferred.await(sqlStarted);
      const spentApplied = yield* Deferred.make<void>();
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "a@example.com" }),
      });
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "a@example.com" }),
        onPull: spentApplied,
      });
      yield* Deferred.await(spentApplied);
      yield* Deferred.succeed(releaseSql, undefined);
      assert.equal(yield* Queue.take(sweeps), true);
      // Coalesced follow-up sweep after the 100% update runs with no reset observations.
      assert.equal(yield* Queue.take(sweeps), false);
      assert.equal(yield* Queue.size(dispatched), 0);

      // 2. Direct account switch without credentialFingerprint (e.g. native Codex email switch)
      //    must drop prior limits and reset markers so switching from 100% acct A to 0% acct B
      //    does not fire a false reset.
      yield* Ref.set(candidatesRef, [
        makeCandidate("run:codex:2", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "b@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      assert.equal(yield* Queue.size(dispatched), 0);

      // 3. Explicit logout / unsupported usageLimits clears resetObservedWindows and seen limits.
      yield* Ref.set(candidatesRef, []);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "b@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "b@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), true);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot("unsupported", { unauthenticated: true }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Ref.set(candidatesRef, [
        makeCandidate("run:codex:3", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "c@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      assert.equal(yield* Queue.size(dispatched), 0);

      // 4. Transient probeFailed on an unchanged account with both credentialFingerprint and
      //    auth.email retains baseline limits so the subsequent 100 -> 0 recovery still fires.
      yield* Ref.set(candidatesRef, [
        makeCandidate("run:codex:4", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "c@example.com", fingerprint: "fp-c" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot("probeFailed", { email: "c@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, {
          email: "c@example.com",
          workspaceId: "ws-c",
          fingerprint: "fp-c",
        }),
      });
      assert.equal(yield* Queue.take(sweeps), true);
      const recovered = yield* Queue.take(dispatched);
      assert.isTrue(
        recovered.type === "message.dispatch" && recovered.usageLimitResetObserved === true,
      );

      // 5. Losing or gaining account identity on a usable snapshot (e.g. account -> anonymous or
      //    anonymous -> account) invalidates baselines and reset markers so an anonymous gap can
      //    never fabricate or carry a reset across accounts.
      yield* Ref.set(candidatesRef, [
        makeCandidate("run:codex:5", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "d@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      assert.equal(yield* Queue.size(dispatched), 0);
      // Even if the anonymous snapshot itself observes 100 -> 0, switching to identified account E
      // clears the anonymous reset marker instead of carrying it into E.
      yield* Ref.set(candidatesRef, []);
      yield* Queue.offer(providerChanges, { providers: codexSnapshot(100) });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, { providers: codexSnapshot(0) });
      assert.equal(yield* Queue.take(sweeps), true);
      yield* Ref.set(candidatesRef, [
        makeCandidate("run:codex:6", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "e@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      assert.equal(yield* Queue.size(dispatched), 0);

      // 6. A thread whose failed run belonged to another provider instance (same model) must not
      //    early-resume on this instance's reset.
      yield* Ref.set(candidatesRef, [
        {
          ...makeCandidate("run:codex:7", DateTime.subtract(yield* DateTime.now, { minutes: 1 })),
          latestRunProviderInstanceId: ProviderInstanceId.make("codex_other"),
        },
      ]);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(100, { email: "e@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), false);
      yield* Queue.offer(providerChanges, {
        providers: codexSnapshot(0, { email: "e@example.com" }),
      });
      assert.equal(yield* Queue.take(sweeps), true);
      assert.equal(yield* Queue.size(dispatched), 0);
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
