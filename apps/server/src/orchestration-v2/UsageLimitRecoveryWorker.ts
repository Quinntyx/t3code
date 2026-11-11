import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

type LimitRecoveryThread = Omit<
  ProjectionStore.ProjectionLimitRecoveryCandidate,
  "hasLinkedPullRequest"
>;

export function limitRecoveryCommand(
  thread: LimitRecoveryThread,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  /** When the provider reported this thread's allowance back, if it did. */
  resetObservedAt?: number,
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
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
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
  // A report only speaks for the failures that came before it; a later one keeps its own clock.
  const resetObserved =
    resetObservedAt !== undefined &&
    DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) < resetObservedAt;
  const snoozedUntilMs =
    thread.snoozedUntil == null ? null : DateTime.toEpochMillis(thread.snoozedUntil);
  // A reset ends the wait and the snooze that only lasted until it; any other snooze still holds.
  const snoozeHolds =
    snoozedUntilMs !== null &&
    snoozedUntilMs > nowMs &&
    !(resetObserved && snoozedUntilMs === resetMs);
  if (!recovery.autoResume || (!resetObserved && resetMs > nowMs) || snoozeHolds) return null;
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
    ...(resetObserved ? { usageLimitResetObserved: true } : {}),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

const spent = (window: ServerProviderUsageWindow) => window.usedPercent >= 100;

/**
 * A provider reports the same windows on every probe, so a window with less spend than before, or
 * a reset clock that moved past it, means the allowance came back: a scheduled reset that arrived
 * early, or a redeemed reset credit.
 */
function limitResetObserved(
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits,
): boolean {
  if (
    previous === undefined ||
    previous.unavailable !== undefined ||
    // Another login's windows say nothing about the one that was spent.
    (previous.credentialFingerprint !== undefined &&
      next.credentialFingerprint !== undefined &&
      previous.credentialFingerprint !== next.credentialFingerprint)
  )
    return false;
  const before = new Map(previous.windows.map((window) => [window.id, window]));
  const after = new Map(next.windows.map((window) => [window.id, window]));
  // A window the probe stopped reporting may still be spent, so it cannot count as freed.
  for (const window of before.values()) {
    const reported = after.get(window.id);
    if (spent(window) && (reported === undefined || spent(reported))) return false;
  }
  return next.windows.some((window) => {
    const seen = before.get(window.id);
    if (seen === undefined) return false;
    // Probes and streamed usage round differently, so only a whole point means less spend.
    if (Math.round(window.usedPercent) < Math.round(seen.usedPercent)) return true;
    const wasReset = seen.resetsAt === undefined ? null : Date.parse(seen.resetsAt);
    const nowReset = window.resetsAt === undefined ? null : Date.parse(window.resetsAt);
    return wasReset !== null && nowReset !== null && nowReset > wasReset;
  });
}

const spentWindow = (limits: ServerProviderUsageLimits) => limits.windows.some(spent);

/**
 * A probe may report only the windows it read, so a spent window it stopped reporting is kept
 * until its reset clock passes. Otherwise a partial report would look like a freed allowance.
 */
const mergeLimits = (
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageLimits => {
  if (previous === undefined || previous.unavailable !== undefined) return next;
  if (next.unavailable !== undefined) return previous;
  if (
    previous.credentialFingerprint !== undefined &&
    next.credentialFingerprint !== undefined &&
    previous.credentialFingerprint !== next.credentialFingerprint
  )
    return next;
  const reported = new Set(next.windows.map((window) => window.id));
  const carried = previous.windows.filter(
    (window) =>
      !reported.has(window.id) &&
      spent(window) &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  );
  return carried.length === 0 ? next : { ...next, windows: [...next.windows, ...carried] };
};

/**
 * Folds one provider report into what was last known per instance, and says which instances gained
 * allowance and which spent it again. An unreadable probe says nothing either way.
 */
export function observeLimitReport(
  previous: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>,
  next: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>,
  nowMs: number,
): {
  readonly observed: ReadonlyArray<ProviderInstanceId>;
  readonly spent: ReadonlyArray<ProviderInstanceId>;
  readonly limits: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>;
} {
  const observed: Array<ProviderInstanceId> = [];
  const spent: Array<ProviderInstanceId> = [];
  const limits = new Map<ProviderInstanceId, ServerProviderUsageLimits>();
  for (const [instanceId, reported] of next) {
    const current = mergeLimits(previous.get(instanceId), reported, nowMs);
    limits.set(instanceId, current);
    if (current.unavailable !== undefined) continue;
    if (spentWindow(current)) spent.push(instanceId);
    else if (limitResetObserved(previous.get(instanceId), current)) observed.push(instanceId);
  }
  return { observed, spent, limits };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

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

const limitsByInstance = (providers: ReadonlyArray<ServerProvider>) =>
  new Map(
    providers.flatMap((provider) =>
      provider.usageLimits === undefined
        ? []
        : [[provider.instanceId, provider.usageLimits] as const],
    ),
  );

const logUnlessInterrupted = (message: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause });

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const due = DueHint.make();
  // When each instance's allowance came back before the reset time its waiting threads recorded.
  // A thread that failed after that report keeps its own clock, so one report cannot retry it
  // twice, and a window that is spent again clears the instance.
  const resetObservedAt = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(new Map());
  const sweep = Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const resets = yield* Ref.get(resetObservedAt);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      resetObserved: resets.size > 0,
    });
    // Only a thread with a command competes for the first allowance; a waiting one that must keep
    // its own clock cannot hold the others back.
    const ready = candidates.flatMap((thread) => {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        resets.get(thread.providerInstanceId),
      );
      return command === null
        ? []
        : [{ hasLinkedPullRequest: thread.hasLinkedPullRequest, thread, command }];
    });
    const prioritizePullRequests =
      preferences.autoResumeLimitedThreads && preferences.autoResumePullRequestThreadsFirst;
    const activePullRequestThread =
      prioritizePullRequests &&
      ready.length > 0 &&
      ready.every((entry) => !entry.hasLinkedPullRequest)
        ? yield* projections.hasActivePullRequestThread()
        : false;
    const selected = selectLimitRecoveryCandidates(ready, {
      prioritizePullRequests,
      activePullRequestThread,
    });
    for (const { thread, command } of selected) {
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
    // A sweep that acted, or failed to, re-checks on the next tick. Threads held behind a working
    // pull-request thread wait for its run event to invalidate the hint.
    if (selected.length > 0) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
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
            logUnlessInterrupted("orchestration-v2.limit-recovery.event-sweep-failed"),
          ),
        );
      }),
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.sweep-worker-failed"),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      isLimitRecoverySignal(event)
        ? requestSweep
        : affectsLimitRecovery(event)
          ? due.invalidate
          : Effect.void,
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.event-stream-failed"),
      ),
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  const seen = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>>(
    limitsByInstance(yield* providers.getProviders),
  );
  yield* forkParked(
    Stream.runForEach(providers.streamChanges, (providers) =>
      Effect.gen(function* () {
        const next = limitsByInstance(providers);
        const at = DateTime.toEpochMillis(yield* DateTime.now);
        const { observed, spent } = yield* Ref.modify(seen, (previous) => {
          const report = observeLimitReport(previous, next, at);
          return [report, report.limits] as const;
        });
        if (observed.length === 0 && spent.length === 0) return;
        yield* Ref.update(resetObservedAt, (current) => {
          const updated = new Map(current);
          for (const instanceId of spent) updated.delete(instanceId);
          for (const instanceId of observed) updated.set(instanceId, at);
          return updated;
        });
        if (observed.length > 0) yield* requestSweep;
      }),
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.provider-stream-failed"),
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
