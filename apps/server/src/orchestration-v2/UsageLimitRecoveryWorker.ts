import {
  CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ThreadId,
} from "@t3tools/contracts";
import { waitingOnAgents } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  exhaustedUsageWindow,
  usageLimitResetAt,
  usageLimitSourceResetAt,
  usageWindowsForModel,
} from "@t3tools/shared/usageLimits";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

type LimitRecoveryThread = Omit<
  ProjectionStore.ProjectionLimitRecoveryCandidate,
  | "hasLinkedPullRequest"
  | "latestRunModel"
  | "threadModel"
  | "latestRunUsageLimitContinuationOfRunId"
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
    thread.pendingRuntimeRequest !== null ||
    // getLimitRecoveryCandidates already filters active agents in SQL; keep this pure guard for direct callers.
    waitingOnAgents(thread)
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

/** Minimum forward jump in `resetsAt` to count as a period rollover rather than API clock jitter. */
const MIN_RESET_ADVANCE_MS = 5 * 60 * 1000;
/** Minimum spend before a drop to 0% counts as a reset rather than tiny rolling usage expiring. */
const MIN_UNSPENT_RESET_TO_ZERO_PERCENT = 10;
/** High-water spend threshold where a large drop still indicates a limit came back without seeing 100%. */
const NEAR_EXHAUSTED_PERCENT = 90;
/** Minimum percentage-point drop required at 90-99% so small rolling decay does not trigger a reset. */
const MIN_NEAR_EXHAUSTED_DROP_PERCENT = 25;
/** Tolerance for matching a retried continuation failure back to the reset window of its early resume. */
const SAME_RESET_WINDOW_MS = 5 * 60 * 1000;

const FALLBACK_WINDOW_DURATION_MINS: Readonly<
  Record<ServerProviderUsageWindow["kind"], number | undefined>
> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
  other: undefined,
};

function minResetAdvanceMs(
  seen: ServerProviderUsageWindow,
  window: ServerProviderUsageWindow,
): number {
  const durationMins =
    window.windowDurationMins ??
    seen.windowDurationMins ??
    FALLBACK_WINDOW_DURATION_MINS[window.kind] ??
    FALLBACK_WINDOW_DURATION_MINS[seen.kind];
  if (durationMins === undefined || !Number.isFinite(durationMins) || durationMins <= 0) {
    return MIN_RESET_ADVANCE_MS;
  }
  return Math.max(MIN_RESET_ADVANCE_MS, Math.floor((durationMins * 60 * 1000) / 2));
}

function windowResetObserved(
  seen: ServerProviderUsageWindow,
  window: ServerProviderUsageWindow,
): boolean {
  if (spent(window)) return false;
  const drop = seen.usedPercent - window.usedPercent;
  if (spent(seen)) {
    // Probes and streamed usage round differently; require a full percentage point drop so
    // half-point float fluctuations (e.g. 100 -> 99.49) do not trigger a reset.
    if (drop >= 1) return true;
  } else if (
    // A probe that never saw 100% still observes a real reset (such as 99% -> 0%, 40% -> 0%, or
    // 95% -> 50% on a redeemed credit), while small rolling decay (94% -> 93% or 1.7% -> 0%) is ignored.
    (Math.round(window.usedPercent) === 0 &&
      seen.usedPercent >= MIN_UNSPENT_RESET_TO_ZERO_PERCENT) ||
    (seen.usedPercent >= NEAR_EXHAUSTED_PERCENT && drop >= MIN_NEAR_EXHAUSTED_DROP_PERCENT)
  ) {
    return true;
  }
  // An idle 0% window drifting forward or a window whose spend is rising is not proof of recovery.
  if (seen.usedPercent < 1 || window.usedPercent > seen.usedPercent) return false;
  const wasReset = seen.resetsAt === undefined ? null : Date.parse(seen.resetsAt);
  const nowReset = window.resetsAt === undefined ? null : Date.parse(window.resetsAt);
  return (
    wasReset !== null &&
    nowReset !== null &&
    Number.isFinite(wasReset) &&
    Number.isFinite(nowReset) &&
    nowReset - wasReset >= minResetAdvanceMs(seen, window)
  );
}

/**
 * A provider reports the same windows on every probe, so a window that recovers from exhaustion
 * or rolls over to a new period means the allowance came back: a scheduled reset that arrived
 * early, or a redeemed reset credit.
 */
function observedResetWindowIds(
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits,
): ReadonlyArray<string> {
  if (
    previous === undefined ||
    previous.unavailable !== undefined ||
    // Another login's windows say nothing about the one that was spent.
    (previous.credentialFingerprint !== undefined &&
      next.credentialFingerprint !== undefined &&
      previous.credentialFingerprint !== next.credentialFingerprint)
  )
    return [];
  const before = new Map(previous.windows.map((window) => [window.id, window]));
  const ids: Array<string> = [];
  for (const window of next.windows) {
    const seen = before.get(window.id);
    if (seen !== undefined && windowResetObserved(seen, window)) {
      ids.push(window.id);
    }
  }
  return ids;
}

const spentWindow = (limits: ServerProviderUsageLimits) => limits.windows.some(spent);

/**
 * A probe may report only the windows it read, so a spent window it stopped reporting is kept
 * until its reset clock passes. Otherwise a partial report would look like a freed allowance. A
 * window with no clock is not kept: it could never show that it stopped blocking.
 */
const mergeLimits = (
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageLimits => {
  if (previous === undefined || previous.unavailable !== undefined) return next;
  if (next.unavailable !== undefined) {
    switch (next.unavailable.reason) {
      case "probeFailed":
        return previous;
      case "unsupported":
        return next;
    }
  }
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
      window.resetsAt !== undefined &&
      Date.parse(window.resetsAt) > nowMs,
  );
  return carried.length === 0 ? next : { ...next, windows: [...next.windows, ...carried] };
};

/**
 * Folds one provider report into what was last known per instance, and says which windows
 * gained allowance and which are currently spent. An unreadable probe says nothing either way.
 */
export function observeLimitReport(
  previous: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>,
  next: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>,
  nowMs: number,
): {
  readonly observedWindows: ReadonlyMap<ProviderInstanceId, ReadonlyArray<string>>;
  readonly spentWindows: ReadonlyMap<ProviderInstanceId, ReadonlyArray<string>>;
  readonly limits: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>;
} {
  const observedWindows = new Map<ProviderInstanceId, ReadonlyArray<string>>();
  const spentWindows = new Map<ProviderInstanceId, ReadonlyArray<string>>();
  const limits = new Map<ProviderInstanceId, ServerProviderUsageLimits>();
  for (const [instanceId, reported] of next) {
    const current = mergeLimits(previous.get(instanceId), reported, nowMs);
    limits.set(instanceId, current);
    if (current.unavailable !== undefined) continue;
    const spentIds = current.windows.filter(spent).map((window) => window.id);
    if (spentIds.length > 0) spentWindows.set(instanceId, spentIds);
    const resetIds = observedResetWindowIds(previous.get(instanceId), current);
    if (resetIds.length > 0) observedWindows.set(instanceId, resetIds);
  }
  return { observedWindows, spentWindows, limits };
}

interface ObservedProviderState {
  readonly version: number;
  readonly seen: ReadonlyMap<ProviderInstanceId, ServerProviderUsageLimits>;
  readonly drivers: ReadonlyMap<ProviderInstanceId, ServerProvider["driver"]>;
  readonly accountKeys: ReadonlyMap<ProviderInstanceId, string>;
  readonly resetObservedWindows: ReadonlyMap<ProviderInstanceId, ReadonlyMap<string, number>>;
}

function providerAccountKey(
  provider: Pick<ServerProvider, "auth" | "usageLimits">,
): string | undefined {
  const fingerprint = provider.usageLimits?.credentialFingerprint;
  const auth = provider.auth;
  const parts = [
    fingerprint ? `fp:${fingerprint}` : undefined,
    auth?.workspaceId ? `ws:${auth.workspaceId}` : undefined,
    auth?.profileId ? `profile:${auth.profileId}` : undefined,
    auth?.email ? `email:${auth.email.toLowerCase()}` : undefined,
    auth?.endpoint ? `endpoint:${auth.endpoint}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("|");
}

function accountKeysByInstance(providers: ReadonlyArray<ServerProvider>) {
  return new Map(
    providers.flatMap((provider) => {
      if (provider.auth?.status === "unauthenticated") return [];
      const key = providerAccountKey(provider);
      return key === undefined ? [] : [[provider.instanceId, key] as const];
    }),
  );
}

/**
 * Returns the latest observed reset time among windows that govern the failed run's model (and
 * verifies the thread has not switched to a different model), or undefined if no applicable
 * window recovered or an applicable window is still spent.
 */
function observedResetAtForThread(input: {
  readonly latestRunModel: string | null;
  readonly threadModel: string | null;
  readonly driver: ServerProvider["driver"] | undefined;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly observedWindows: ReadonlyMap<string, number> | undefined;
  readonly nowMs: number;
}): number | undefined {
  const { latestRunModel, threadModel, driver, usageLimits, observedWindows, nowMs } = input;
  if (
    observedWindows === undefined ||
    observedWindows.size === 0 ||
    usageLimits === undefined ||
    usageLimits.unavailable !== undefined
  ) {
    return undefined;
  }
  if (latestRunModel !== null && threadModel !== null && latestRunModel !== threadModel) {
    return undefined;
  }
  const model = latestRunModel ?? threadModel;
  let applicable: ReadonlyArray<ServerProviderUsageWindow>;
  if (model !== null) {
    if (driver === undefined) return undefined;
    const provider = { driver, usageLimits };
    applicable = usageWindowsForModel(provider, model);
    if (applicable.length === 0) return undefined;
    if (exhaustedUsageWindow(provider, nowMs, model) !== undefined) return undefined;
  } else {
    if (spentWindow(usageLimits)) return undefined;
    applicable = usageLimits.windows;
  }
  let latest: number | undefined;
  for (const window of applicable) {
    const observedAt = observedWindows.get(window.id);
    if (observedAt !== undefined && (latest === undefined || observedAt > latest)) {
      latest = observedAt;
    }
  }
  return latest;
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type === "provider-thread.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

// The usage-limit item and failed run may commit in either order. Both publish after their
// transaction; sweeping on each one lets the snooze land in the same shell batch instead of
// waiting for the next five-second tick.
export const isLimitRecoverySignal = (event: OrchestrationV2DomainEvent) =>
  (event.type === "turn-item.updated" &&
    event.payload.type === "error" &&
    event.payload.failure.class === "usage_limit") ||
  (event.type === "turn-item.updated" &&
    event.payload.type === "subagent" &&
    !isOrchestrationV2WorkActive(event.payload.status)) ||
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
      provider.usageLimits === undefined || provider.auth?.status === "unauthenticated"
        ? []
        : [[provider.instanceId, provider.usageLimits] as const],
    ),
  );

const driversByInstance = (providers: ReadonlyArray<ServerProvider>) =>
  new Map(providers.map((provider) => [provider.instanceId, provider.driver] as const));

const logUnlessInterrupted = (message: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause });

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const due = DueHint.make();
  // Atomic versioned snapshot of provider limits, drivers, account identities, and per-window
  // reset timestamps so sweeps never tear across updates or keep observations across account changes.
  const initialProviders = yield* providers.getProviders;
  const providerState = yield* Ref.make<ObservedProviderState>({
    version: 0,
    seen: limitsByInstance(initialProviders),
    drivers: driversByInstance(initialProviders),
    accountKeys: accountKeysByInstance(initialProviders),
    resetObservedWindows: new Map(),
  });
  // Tracks the last early reset-observed resume per thread so an immediate continuation failure
  // in the same reset window waits for its recorded clock instead of looping.
  const earlyResumed = yield* Ref.make<
    ReadonlyMap<ThreadId, { readonly continuedFromRunId: RunId; readonly resetMs: number }>
  >(new Map());
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const evaluateResetObserved = (
    state: ObservedProviderState,
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    earlyAttempted: ReadonlyMap<
      ThreadId,
      { readonly continuedFromRunId: RunId; readonly resetMs: number }
    >,
    nowMs: number,
  ): number | undefined => {
    const resetMs =
      thread.usageLimitResetAt == null ? Number.NaN : Date.parse(thread.usageLimitResetAt);
    const priorEarly = earlyAttempted.get(thread.id);
    if (
      priorEarly !== undefined &&
      thread.latestRunUsageLimitContinuationOfRunId === priorEarly.continuedFromRunId &&
      Number.isFinite(resetMs) &&
      Math.abs(priorEarly.resetMs - resetMs) <= SAME_RESET_WINDOW_MS
    ) {
      return undefined;
    }
    return observedResetAtForThread({
      latestRunModel: thread.latestRunModel,
      threadModel: thread.threadModel,
      driver: state.drivers.get(thread.providerInstanceId),
      usageLimits: state.seen.get(thread.providerInstanceId),
      observedWindows: state.resetObservedWindows.get(thread.providerInstanceId),
      nowMs,
    });
  };
  const sweep = Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const state = yield* Ref.get(providerState);
    const earlyAttempted = yield* Ref.get(earlyResumed);
    const failures = yield* projections.getUsageLimitFailuresWithoutReset();
    if (failures.length > 0) {
      const sources = yield* usageSources.current;
      for (const { run, item } of failures) {
        yield* Effect.gen(function* () {
          const instance = yield* instances.getInstance(run.providerInstanceId);
          if (instance === undefined) return;
          const snapshot = yield* instance.snapshot.getSnapshot;
          const model = run.modelSelection.model;
          const resetAt =
            usageLimitResetAt(snapshot, nowMs, model) ??
            usageLimitSourceResetAt(sources, snapshot, nowMs, model);
          if (resetAt === null) return;
          yield* eventSink.writeWithEffects({
            fillUsageLimitResetAtOnly: true,
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: item.threadId }),
                type: "turn-item.updated",
                threadId: item.threadId,
                runId: run.id,
                nodeId: item.nodeId ?? undefined,
                driver: instance.driverKind,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...item, failure: { ...item.failure, resetAt } },
              },
            ],
            effects: [],
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.reset-reconciliation-failed", {
              threadId: item.threadId,
              cause,
            }),
          ),
        );
      }
    }
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      resetObserved: state.resetObservedWindows.size > 0,
    });
    // Only a thread with a command competes for the first allowance; a waiting one that must keep
    // its own clock cannot hold the others back.
    const ready = candidates.flatMap((thread) => {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        evaluateResetObserved(state, thread, earlyAttempted, nowMs),
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
          let dispatchCommand = command;
          if (
            dispatchCommand.type === "message.dispatch" &&
            dispatchCommand.usageLimitResetObserved === true
          ) {
            // Re-verify against the latest provider snapshot so an update arriving during SQL
            // reads cannot leave a stale early resume dispatching into a spent or switched pool.
            const latestState = yield* Ref.get(providerState);
            if (latestState.version !== state.version) {
              const latestEarly = yield* Ref.get(earlyResumed);
              const refreshed = limitRecoveryCommand(
                thread,
                preferences.autoResumeLimitedThreads,
                nowMs,
                preferences.snoozeLimitedThreads,
                evaluateResetObserved(latestState, thread, latestEarly, nowMs),
              );
              if (refreshed?.type !== "message.dispatch") return;
              dispatchCommand = refreshed;
            }
          }
          yield* threads.dispatch(dispatchCommand);
          if (
            dispatchCommand.type === "message.dispatch" &&
            dispatchCommand.usageLimitContinuationOfRunId !== undefined &&
            thread.usageLimitResetAt != null
          ) {
            const resetMs = Date.parse(thread.usageLimitResetAt);
            const continuedFromRunId = dispatchCommand.usageLimitContinuationOfRunId;
            yield* Ref.update(earlyResumed, (current) => {
              const updated = new Map(current);
              if (dispatchCommand.usageLimitResetObserved === true && Number.isFinite(resetMs)) {
                updated.set(thread.id, { continuedFromRunId, resetMs });
              } else {
                updated.delete(thread.id);
              }
              for (const [id, entry] of updated) {
                if (entry.resetMs + SAME_RESET_WINDOW_MS < nowMs) updated.delete(id);
              }
              return updated;
            });
          }
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
      Effect.gen(function* () {
        if (
          event.type === "run.updated" &&
          (event.payload.status === "completed" ||
            (event.payload.status === "cancelled" && event.payload.startedAt !== null))
        ) {
          yield* Ref.update(earlyResumed, (current) => {
            if (!current.has(event.threadId)) return current;
            const updated = new Map(current);
            updated.delete(event.threadId);
            return updated;
          });
        }
        if (isLimitRecoverySignal(event)) yield* requestSweep;
        else if (affectsLimitRecovery(event)) yield* due.invalidate;
      }),
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.event-stream-failed"),
      ),
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  yield* forkParked(
    Stream.runForEach(providers.streamChanges, (providerList) =>
      Effect.gen(function* () {
        const nextLimits = limitsByInstance(providerList);
        const nextDrivers = driversByInstance(providerList);
        const nextAccountKeys = accountKeysByInstance(providerList);
        const at = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Ref.update(providerState, (current) => {
          // Drop prior baselines for any instance whose account identity changed (even on drivers
          // without credentialFingerprint, such as Codex, Claude, or Cursor).
          const previousSeen = new Map<ProviderInstanceId, ServerProviderUsageLimits>();
          const switchedInstances = new Set<ProviderInstanceId>();
          for (const [instanceId, prevLimits] of current.seen) {
            const prevKey = current.accountKeys.get(instanceId);
            const nextKey = nextAccountKeys.get(instanceId);
            if (prevKey !== undefined && nextKey !== undefined && prevKey !== nextKey) {
              switchedInstances.add(instanceId);
              continue;
            }
            previousSeen.set(instanceId, prevLimits);
          }
          const report = observeLimitReport(previousSeen, nextLimits, at);
          // Rebuild observations only for instances still present with usable limits so logout,
          // unsupported probes, provider removal, or account switches never leave stale markers.
          const resetObservedWindows = new Map<ProviderInstanceId, ReadonlyMap<string, number>>();
          for (const [instanceId, limits] of report.limits) {
            if (limits.unavailable !== undefined || switchedInstances.has(instanceId)) continue;
            const prev = previousSeen.get(instanceId);
            if (
              prev?.credentialFingerprint !== undefined &&
              limits.credentialFingerprint !== undefined &&
              prev.credentialFingerprint !== limits.credentialFingerprint
            ) {
              continue;
            }
            const nextWindowMap = new Map(current.resetObservedWindows.get(instanceId));
            for (const windowId of report.spentWindows.get(instanceId) ?? []) {
              nextWindowMap.delete(windowId);
            }
            for (const windowId of report.observedWindows.get(instanceId) ?? []) {
              nextWindowMap.set(windowId, at);
            }
            if (nextWindowMap.size > 0) resetObservedWindows.set(instanceId, nextWindowMap);
          }
          return {
            version: current.version + 1,
            seen: report.limits,
            drivers: nextDrivers,
            accountKeys: nextAccountKeys,
            resetObservedWindows,
          };
        });
        yield* requestSweep;
      }),
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.provider-stream-failed"),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(usageSources.streamChanges, () => requestSweep).pipe(
      Effect.catchCause(
        logUnlessInterrupted("orchestration-v2.limit-recovery.usage-source-stream-failed"),
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
