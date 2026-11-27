import {
  CommandId,
  MessageId,
  RunId,
  isUpstreamOverloadFailure,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  stallRetryDelayMs,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const STALL_TEXT = "Continue where you left off.";

const identityOf = (
  thread: Pick<ProjectionStore.ProjectionStallRecoveryCandidate, "id">,
  runId: string,
) => `${thread.id}:${runId}`;

/**
 * The next attempt number for a run the upstream overload just ended. Only the retry of the
 * recorded run continues the count, and only when that retry never got anywhere; every other
 * overload is a new stall and starts over.
 */
export function nextStallAttempt(
  thread: Pick<
    ProjectionStore.ProjectionStallRecoveryCandidate,
    "stallRecovery" | "stallContinuationOfRunId"
  >,
  madeProgress: boolean,
): number {
  const recovery = thread.stallRecovery;
  if (recovery == null || thread.stallContinuationOfRunId !== recovery.runId || madeProgress) {
    return 1;
  }
  return recovery.attempt + 1;
}

/**
 * Arms or re-arms a run's retry schedule. The armed time is part of the id: a refusal is
 * receipted, so re-arming the same attempt needs an id of its own.
 */
const stallArmCommand = (
  thread: Pick<ProjectionStore.ProjectionStallRecoveryCandidate, "id">,
  runId: string,
  attempt: number,
  nextAttemptAt: string,
): OrchestrationV2Command => ({
  type: "thread.metadata.update",
  commandId: CommandId.make(`stall-arm:${identityOf(thread, runId)}:${attempt}:${nextAttemptAt}`),
  threadId: thread.id,
  stallRecovery: { runId: RunId.make(runId), attempt, nextAttemptAt },
});

/**
 * The command a stalled thread needs now: arm its first retry, or dispatch the next one once
 * `nextAttemptAt` arrives. Null while it is waiting or once something stopped the loop.
 */
export function stallRecoveryCommand(
  thread: ProjectionStore.ProjectionStallRecoveryCandidate,
  madeProgress: boolean,
  nowMs: number,
): OrchestrationV2Command | null {
  const runId = thread.latestRunId;
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const recovery = thread.stallRecovery;
  if (recovery?.runId !== runId) {
    const attempt = nextStallAttempt(thread, madeProgress);
    return stallArmCommand(
      thread,
      runId,
      attempt,
      DateTime.formatIso(
        DateTime.makeUnsafe((thread.latestRunCompletedAtMs ?? nowMs) + stallRetryDelayMs(attempt)),
      ),
    );
  }
  if (Date.parse(recovery.nextAttemptAt) > nowMs) return null;
  // A rejection is receipted, so a retry that can go out again needs its own id. The armed time
  // is what the worker changes when a temporary blocker refuses this one.
  const deliveryIdentity = `${identityOf(thread, runId)}:${recovery.attempt}:${recovery.nextAttemptAt}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`stall-retry:${deliveryIdentity}`),
    messageId: MessageId.make(`stall-retry:${deliveryIdentity}`),
    threadId: thread.id,
    stallContinuationOfRunId: runId,
    text: STALL_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// A failed run and its overload failure may commit in either order; both publish after their
// transaction, so sweeping on each lands the arm in the same batch. Retry-now and unarchive/unsettle
// also trigger an immediate sweep instead of waiting for the next periodic scheduler tick.
export const isStallRecoverySignal = (event: OrchestrationV2DomainEvent) =>
  (event.type === "turn-item.updated" &&
    event.payload.type === "error" &&
    isUpstreamOverloadFailure(event.payload.failure)) ||
  (event.type === "run.updated" && event.payload.status === "failed") ||
  (event.type === "runtime-request.updated" && event.payload.status !== "pending") ||
  (event.type === "thread.metadata-updated" && event.payload.stallRecovery != null) ||
  event.type === "thread.unarchived" ||
  event.type === "thread.unsettled";

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsStallRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.");

const logUnlessInterrupted = (message: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause });

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const due = DueHint.make();
  const sweep = Effect.fn("StallRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const candidates = yield* projections.getStallRecoveryCandidates();
    let acted = 0;
    for (const candidate of candidates) {
      const madeProgress = yield* projections.stallRunMadeProgress(candidate.latestRunId);
      const command = stallRecoveryCommand(candidate, madeProgress, nowMs);
      if (command === null) continue;
      acted += 1;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.stallRecovery != null) {
          yield* orchestrator.autoArmStallRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            stallRecovery: command.stallRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.stall-recovery.dispatch-failed", {
            threadId: candidate.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted > 0) return;
    const wakeAt = yield* projections.getStallRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
  // Coalesce event bursts into one follow-up sweep. A dirty flag is rechecked after each
  // sweep so an event that lands while a sweep is reading still gets its own pass.
  const dirty = yield* Ref.make(false);
  const wake = yield* Queue.dropping<void>(1);
  const requestSweep = due.invalidate.pipe(
    Effect.andThen(Ref.set(dirty, true)),
    Effect.andThen(Queue.offer(wake, undefined)),
    Effect.asVoid,
  );
  yield* forkParked(
    Stream.runForEach(Stream.fromQueue(wake), () =>
      Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(dirty, false))) return;
        yield* sweep().pipe(
          Effect.catchCause(
            logUnlessInterrupted("orchestration-v2.stall-recovery.event-sweep-failed"),
          ),
        );
      }),
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.stall-recovery.sweep-worker-failed"),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      isStallRecoverySignal(event)
        ? requestSweep
        : affectsStallRecovery(event)
          ? due.invalidate
          : Effect.void,
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.stall-recovery.event-stream-failed"),
      ),
    ),
  );
  return sweep;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("stall-recovery", sweep());
  }),
);
