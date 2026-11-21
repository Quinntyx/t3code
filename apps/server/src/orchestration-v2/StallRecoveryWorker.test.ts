import { assert, describe, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, ThreadId, stallRetryDelayMs } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as StallRecoveryWorker from "./StallRecoveryWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const runId = RunId.make("run:stalled");
const startedAtMs = Date.parse("2026-07-01T09:00:00.000Z");

const candidate = (
  overrides: Partial<ProjectionStore.ProjectionStallRecoveryCandidate> = {},
): ProjectionStore.ProjectionStallRecoveryCandidate => ({
  id: ThreadId.make("thread:stalled"),
  lastErrorClass: "provider_error",
  latestRunId: runId,
  latestRunCompletedAtMs: startedAtMs - 60_000,
  stallContinuationOfRunId: null,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  stallRecovery: null,
  ...overrides,
});

describe("stallRetryDelayMs", () => {
  it("doubles from one minute and caps at an hour", () => {
    for (const [attempt, delay] of [
      [1, 60_000],
      [2, 120_000],
      [3, 240_000],
      [4, 480_000],
      [5, 960_000],
      [6, 1_920_000],
      [7, 3_600_000],
      [8, 3_600_000],
      [200, 3_600_000],
    ] as const) {
      assert.equal(stallRetryDelayMs(attempt), delay, `attempt ${attempt}`);
    }
  });
});

describe("stallRecoveryCommand", () => {
  it("arms the first retry a minute after the run ended", () => {
    const command = StallRecoveryWorker.stallRecoveryCommand(candidate(), false, startedAtMs);
    assert.equal(command?.type, "thread.metadata.update");
    assert.deepEqual(command?.type === "thread.metadata.update" ? command.stallRecovery : null, {
      runId,
      attempt: 1,
      nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
    });
  });

  it("arms from the run's own end, not the sweep's clock", () => {
    const command = StallRecoveryWorker.stallRecoveryCommand(
      candidate({ latestRunCompletedAtMs: startedAtMs }),
      false,
      startedAtMs,
    );
    assert.equal(
      command?.type === "thread.metadata.update" ? command.stallRecovery?.nextAttemptAt : null,
      DateTime.formatIso(DateTime.makeUnsafe(startedAtMs + 60_000)),
    );
  });

  it("waits for the armed time, then dispatches the retry", () => {
    const armed = candidate({
      stallRecovery: {
        runId,
        attempt: 1,
        nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
      },
    });
    assert.isNull(StallRecoveryWorker.stallRecoveryCommand(armed, false, startedAtMs - 1));
    const command = StallRecoveryWorker.stallRecoveryCommand(armed, false, startedAtMs);
    assert.equal(command?.type, "message.dispatch");
    assert.equal(
      command?.type === "message.dispatch" ? command.stallContinuationOfRunId : null,
      runId,
    );
    assert.isTrue(
      command?.type === "message.dispatch" &&
        command.createdBy === "agent" &&
        command.creationSource === "server",
    );
  });

  it("names the same retry twice while it is due", () => {
    const armed = candidate({
      stallRecovery: {
        runId,
        attempt: 3,
        nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
      },
    });
    const first = StallRecoveryWorker.stallRecoveryCommand(armed, false, startedAtMs);
    const second = StallRecoveryWorker.stallRecoveryCommand(armed, false, startedAtMs + 1_000);
    assert.equal(first?.commandId, second?.commandId);
  });

  it("arms attempt 2 after a retry that failed on the overload without progress", () => {
    const command = StallRecoveryWorker.stallRecoveryCommand(
      candidate({
        latestRunId: RunId.make("run:retry"),
        stallContinuationOfRunId: runId,
        stallRecovery: { runId, attempt: 1, nextAttemptAt: "2026-07-01T09:00:00.000Z" },
      }),
      false,
      startedAtMs,
    );
    assert.equal(
      command?.type === "thread.metadata.update" ? command.stallRecovery?.attempt : null,
      2,
    );
  });

  it("keeps the attempt count when the retry's failure lands before its overload item", () => {
    // The sweep runs on run.updated(failed) before the error item commits, then again when it
    // lands. Both see the retry of the recorded run, so the backoff count must not restart.
    const armed = candidate({
      latestRunId: RunId.make("run:retry"),
      stallContinuationOfRunId: runId,
      stallRecovery: {
        runId,
        attempt: 1,
        nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
      },
    });
    assert.equal(StallRecoveryWorker.nextStallAttempt(armed, false), 2);
    const command = StallRecoveryWorker.stallRecoveryCommand(armed, false, startedAtMs);
    assert.equal(
      command?.type === "thread.metadata.update" ? command.stallRecovery?.attempt : null,
      2,
    );
  });

  it("arms attempt 1 after a retry that made progress", () => {
    const command = StallRecoveryWorker.stallRecoveryCommand(
      candidate({
        latestRunId: RunId.make("run:retry"),
        stallContinuationOfRunId: runId,
        stallRecovery: { runId, attempt: 2, nextAttemptAt: "2026-07-01T09:00:00.000Z" },
      }),
      true,
      startedAtMs,
    );
    assert.equal(
      command?.type === "thread.metadata.update" ? command.stallRecovery?.attempt : null,
      1,
    );
  });

  it.each([
    ["archived", { archivedAt: DateTime.makeUnsafe(startedAtMs) }],
    ["settled", { settledOverride: "settled" as const }],
    [
      "waiting on the user",
      {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:stalled"),
          kind: "user_input" as const,
          createdAt: DateTime.makeUnsafe(startedAtMs),
        },
      },
    ],
  ] as const)("does nothing while the thread is %s", (_name, overrides) => {
    assert.isNull(
      StallRecoveryWorker.stallRecoveryCommand(candidate(overrides), false, startedAtMs),
    );
  });
});

describe("nextStallAttempt", () => {
  const recovery = (attempt: number) => ({
    runId,
    attempt,
    nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
  });

  it("starts a new stall at attempt 1", () => {
    assert.equal(StallRecoveryWorker.nextStallAttempt(candidate(), false), 1);
    // An overload many runs after the recorded one is a new stall, not a continuation.
    assert.equal(
      StallRecoveryWorker.nextStallAttempt(
        candidate({ latestRunId: RunId.make("run:later"), stallRecovery: recovery(4) }),
        false,
      ),
      1,
    );
  });

  it("counts up only from the recorded run's own retry that got nowhere", () => {
    assert.equal(
      StallRecoveryWorker.nextStallAttempt(
        candidate({ stallContinuationOfRunId: runId, stallRecovery: recovery(2) }),
        false,
      ),
      3,
    );
    assert.equal(
      StallRecoveryWorker.nextStallAttempt(
        candidate({ stallContinuationOfRunId: runId, stallRecovery: recovery(2) }),
        true,
      ),
      1,
    );
    assert.equal(
      StallRecoveryWorker.nextStallAttempt(
        candidate({
          stallContinuationOfRunId: RunId.make("run:older"),
          stallRecovery: recovery(2),
        }),
        false,
      ),
      1,
    );
  });
});

it("recognizes only events that can change stall recovery", () => {
  const signal = (event: object) => StallRecoveryWorker.isStallRecoverySignal(event as never);
  const error = (failure: object) => ({
    type: "turn-item.updated",
    payload: { type: "error", failure },
  });
  assert.isTrue(signal({ type: "run.updated", payload: { status: "failed" } }));
  assert.isFalse(signal({ type: "run.updated", payload: { status: "running" } }));
  assert.isTrue(signal(error({ class: "provider_error", overloaded: true })));
  assert.isFalse(signal(error({ class: "provider_error" })));
  assert.isTrue(signal({ type: "runtime-request.updated", payload: { status: "cancelled" } }));
  assert.isFalse(signal({ type: "runtime-request.updated", payload: { status: "pending" } }));
});

const dueArm = (atMs: number) => ({
  runId,
  attempt: 1,
  nextAttemptAt: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
});

/**
 * Runs the worker over a projection the test advances, and records what it sends. Its scheduler
 * registration is kept, so the test fires sweeps one at a time.
 */
const sweepHarness = (thread: () => ProjectionStore.ProjectionStallRecoveryCandidate) =>
  Effect.gen(function* () {
    const registration = yield* Queue.unbounded<Effect.Effect<void>>();
    const armed = yield* Queue.unbounded<number>();
    const dispatched = yield* Queue.unbounded<string>();
    const layer = StallRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Scheduler.Scheduler, {
            register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                yield* Queue.offer(
                  registration,
                  Effect.provideContext(work, context).pipe(Effect.orDie),
                );
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getStallRecoveryCandidates: () => Effect.sync(() => [thread()]),
            stallRunMadeProgress: () => Effect.succeed(false),
            // The projection reports when the armed retry is due, so an idle sweep can skip SQL.
            getStallRecoveryWakeAt: () =>
              Effect.sync(() => {
                const armedAt = thread().stallRecovery?.nextAttemptAt;
                return armedAt == null ? null : Date.parse(armedAt);
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Queue.offer(dispatched, command.commandId).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            autoArmStallRecovery: (arm) =>
              Queue.offer(armed, Date.parse(arm.stallRecovery.nextAttemptAt)).pipe(Effect.asVoid),
          }),
        ),
      ),
    );
    return { layer, registration, armed, dispatched };
  });

it.effect("arms the first retry and dispatches it only once it is due", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startedAtMs);
    let thread = candidate({ latestRunCompletedAtMs: startedAtMs });
    const harness = yield* sweepHarness(() => thread);
    yield* Effect.gen(function* () {
      const sweep = yield* Queue.take(harness.registration);
      // The first sweep arms a retry a minute after the run ended.
      yield* sweep;
      assert.equal(yield* Queue.take(harness.armed), startedAtMs + 60_000);
      thread = candidate({
        latestRunCompletedAtMs: startedAtMs,
        stallRecovery: dueArm(startedAtMs + 60_000),
      });
      yield* TestClock.adjust("59 seconds");
      // Not due yet, so the sweep sends nothing.
      yield* sweep;
      assert.isTrue(Option.isNone(yield* Queue.poll(harness.dispatched)));
      yield* TestClock.adjust("1 second");
      yield* sweep;
      assert.equal(
        yield* Queue.take(harness.dispatched),
        `stall-retry:${thread.id}:${runId}:1:${dueArm(startedAtMs + 60_000).nextAttemptAt}`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a fresh worker over the same projection sends the same retry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startedAtMs);
    const projection = candidate({ stallRecovery: dueArm(startedAtMs) });
    const runOnce = () =>
      Effect.gen(function* () {
        const harness = yield* sweepHarness(() => projection);
        return yield* Effect.gen(function* () {
          yield* yield* Queue.take(harness.registration);
          return yield* Queue.take(harness.dispatched);
        }).pipe(Effect.provide(harness.layer));
      });
    const first = yield* runOnce();
    assert.equal(first, yield* runOnce());
    assert.equal(
      first,
      `stall-retry:${projection.id}:${runId}:1:${dueArm(startedAtMs).nextAttemptAt}`,
    );
  }),
);
