import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type LimitRecoveryThread = Omit<
  ProjectionStore.ProjectionLimitRecoveryCandidate,
  "hasLinkedPullRequest"
>;

export function limitRecoveryCommand(
  thread: LimitRecoveryThread,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

// The usage-limit item and failed run may commit in either order. Both publish after their
// transaction; sweeping on each one lets the snooze land in the same shell batch instead of
// waiting for the next five-second tick.
export const isLimitRecoverySignal = (event: OrchestrationV2DomainEvent) =>
  (event.type === "turn-item.updated" &&
    event.payload.type === "error" &&
    event.payload.failure.class === "usage_limit") ||
  (event.type === "run.updated" && event.payload.status === "failed") ||
  (event.type === "runtime-request.updated" && event.payload.status !== "pending");

export function selectLimitRecoveryCandidates<T extends { readonly hasLinkedPullRequest: boolean }>(
  candidates: ReadonlyArray<T>,
  options: {
    readonly prioritizePullRequests: boolean;
    readonly activePullRequestThread: boolean;
  },
): ReadonlyArray<T> {
  if (!options.prioritizePullRequests) return candidates;
  const prioritized = candidates.filter((thread) => thread.hasLinkedPullRequest);
  if (prioritized.length > 0) return prioritized;
  // The pull-request threads already resumed are still working, so the rest wait.
  return options.activePullRequestThread ? [] : candidates;
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sweep = Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const prioritizePullRequests =
      preferences.autoResumeLimitedThreads && preferences.autoResumePullRequestThreadsFirst;
    const activePullRequestThread =
      prioritizePullRequests &&
      candidates.length > 0 &&
      candidates.every((thread) => !thread.hasLinkedPullRequest)
        ? yield* projections.hasActivePullRequestThread()
        : false;
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of selectLimitRecoveryCandidates(candidates, {
      prioritizePullRequests,
      activePullRequestThread,
    })) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
  // Coalesce event bursts into one follow-up sweep. A dirty flag is rechecked after each
  // sweep so an event that lands while a sweep is reading still gets its own pass.
  const dirty = yield* Ref.make(false);
  const wake = yield* Queue.dropping<void>(1);
  const requestSweep = Ref.set(dirty, true).pipe(
    Effect.andThen(Queue.offer(wake, undefined)),
    Effect.asVoid,
  );
  yield* forkParked(
    Stream.runForEach(Stream.fromQueue(wake), () =>
      Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(dirty, false))) return;
        yield* sweep().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("orchestration-v2.limit-recovery.event-sweep-failed", {
                  cause,
                }),
          ),
        );
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("orchestration-v2.limit-recovery.sweep-worker-failed", { cause }),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      isLimitRecoverySignal(event) ? requestSweep : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("orchestration-v2.limit-recovery.event-stream-failed", { cause }),
      ),
    ),
  );
  return sweep;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
