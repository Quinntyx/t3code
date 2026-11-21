import {
  CommandId,
  type EnvironmentId,
  type OrchestratorMcpFailure,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadWatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { runOutcome } from "./RestartBackgroundNote.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { sameThreadWatchTarget, threadWatchWake, type ThreadWatchOutcome } from "./threadWatch.ts";

/** How long one follow of a thread in a linked environment waits there before looking again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** How a follower retries an unreachable environment. */
const FollowRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/orchestration-v2/ThreadWatchReactor/FollowRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);

/**
 * Gone there, or no link left to reach it by (a forgotten link reads as a bad request):
 * following again cannot change that.
 */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "invalid_request" ||
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

/**
 * Wakes a thread once when a thread it watches ends its run, stops to ask for input, or is
 * deleted, then ends the watch. Threads in linked environments are followed over the link.
 */
export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWatchReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const followRetry = yield* FollowRetrySchedule;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  const following = new Set<string>();

  // A watch already ended, by an earlier check or a Stop, rejects the end; nothing is lost.
  const end = (
    watcherThreadId: ThreadId,
    watch: OrchestrationV2ThreadWatch,
    outcome: ThreadWatchOutcome,
  ) => {
    const wake = threadWatchWake(watcherThreadId, watch, outcome);
    return engine
      .dispatch({
        type: "thread.thread-watch.sync",
        commandId: CommandId.make(`server:${wake.messageId}`),
        threadId: watcherThreadId,
        watch,
        watching: false,
        wake,
      })
      .pipe(Effect.catchTags({ OrchestratorDispatchError: () => Effect.void }));
  };

  const outcomeHere = Effect.fn("ThreadWatchReactor.outcomeHere")(function* (
    watch: OrchestrationV2ThreadWatch,
  ) {
    const target = yield* projections
      .getThreadRecords(watch.threadId, ["runtimeRequests"])
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }));
    if (target === undefined || target.thread.deletedAt !== null) {
      return { kind: "gone" } as const;
    }
    // Only a question asked since the wait began: one the watcher was already woken for
    // would wake it again each time it waits.
    const startedAt = Date.parse(watch.startedAt);
    if (
      target.runtimeRequests.some(
        (request) =>
          request.status === "pending" &&
          request.kind !== "auth_refresh" &&
          request.responseCapability.type === "live" &&
          DateTime.toEpochMillis(request.createdAt) >= startedAt,
      )
    ) {
      return { kind: "needs_input" } as const;
    }
    const waited = yield* threads
      .waitForThread({
        projectId: target.thread.projectId,
        threadId: watch.threadId,
        runId: watch.runId,
        timeoutMs: 0,
      })
      .pipe(
        Effect.catchTags({
          ThreadManagementRunNotFoundError: () => Effect.succeed({ run: null, timedOut: false }),
        }),
      );
    if (waited.timedOut) return undefined;
    return waited.run === null
      ? ({ kind: "gone" } as const)
      : ({ kind: "ended", status: runOutcome(waited.run) } as const);
  });

  /** The watcher's provider, while it still has this watch. */
  const watcherOf = (watcherThreadId: ThreadId, watch: OrchestrationV2ThreadWatch) =>
    projections.getThread(watcherThreadId).pipe(
      Effect.map((thread) =>
        thread.deletedAt === null &&
        (thread.threadWatches ?? []).some(
          (candidate) =>
            sameThreadWatchTarget(candidate, watch) && candidate.startedAt === watch.startedAt,
        )
          ? thread
          : undefined,
      ),
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
    );

  /** One wait there; true once the watch has ended. */
  const followOnce = Effect.fn("ThreadWatchReactor.followOnce")(function* (
    watcherThreadId: ThreadId,
    watch: OrchestrationV2ThreadWatch & { readonly environmentId: EnvironmentId },
  ) {
    const watcher = yield* watcherOf(watcherThreadId, watch);
    if (watcher === undefined) return true;
    const scope = {
      environmentId: hereId,
      requestNamespace: `thread-watch:${watcherThreadId}`,
      thread: {
        threadId: watcherThreadId,
        providerSessionId: `thread-watch:${watch.threadId}`,
        providerInstanceId: watcher.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
    };
    const waited = yield* forwarding
      .waitForThread(scope, watch.environmentId, {
        threadId: watch.threadId,
        runId: watch.runId,
        timeoutMs: FOLLOW_WAIT_MS,
      })
      .pipe(Effect.catchIf(isFinal, () => Effect.undefined));
    if (waited === undefined || waited.status === "idle") {
      yield* end(watcherThreadId, watch, { kind: "gone" });
      return true;
    }
    if (waited.timedOut) return false;
    yield* end(watcherThreadId, watch, { kind: "ended", status: waited.status });
    return true;
  });

  const follow = (watcherThreadId: ThreadId, watch: OrchestrationV2ThreadWatch) =>
    Effect.suspend(() => {
      const { environmentId } = watch;
      const key = `${watcherThreadId}|${environmentId}|${watch.threadId}|${watch.startedAt}`;
      if (environmentId === undefined || following.has(key)) return Effect.void;
      following.add(key);
      return followOnce(watcherThreadId, { ...watch, environmentId }).pipe(
        // Anything short of final, there or here, is worth another look after a pause.
        Effect.retry({ schedule: followRetry }),
        Effect.repeat({ while: (done) => !done }),
        Effect.ignoreCause({ log: true }),
        Effect.ensuring(Effect.sync(() => following.delete(key))),
        Effect.forkIn(followers),
        Effect.asVoid,
      );
    });

  const check = Effect.fn("ThreadWatchReactor.check")(function* (
    watcherThreadId: ThreadId,
    watch: OrchestrationV2ThreadWatch,
  ) {
    if (watch.environmentId !== undefined) return yield* follow(watcherThreadId, watch);
    const outcome = yield* outcomeHere(watch);
    if (outcome !== undefined) yield* end(watcherThreadId, watch, outcome);
  });

  // Every thread's watches, kept from the events that carry them, so a run ending reads nothing.
  const watchesByWatcher = new Map<ThreadId, ReadonlyArray<OrchestrationV2ThreadWatch>>();
  const remember = (
    watcherThreadId: ThreadId,
    watches: ReadonlyArray<OrchestrationV2ThreadWatch>,
  ) =>
    watches.length === 0
      ? watchesByWatcher.delete(watcherThreadId)
      : watchesByWatcher.set(watcherThreadId, watches);

  const checkWatches = (
    watcherThreadId: ThreadId,
    watches: ReadonlyArray<OrchestrationV2ThreadWatch>,
  ) =>
    Effect.forEach(
      watches,
      (watch) =>
        check(watcherThreadId, watch).pipe(
          // A wake missed to a passing failure would wait for the next restart.
          Effect.retry({ schedule: followRetry, times: 5 }),
          Effect.catchCause((cause) =>
            Effect.logWarning("checking a thread watch failed", {
              watcherThreadId,
              threadId: watch.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const checkWatchersOf = (targetThreadId: ThreadId) =>
    Effect.forEach(
      Array.from(watchesByWatcher),
      ([watcherThreadId, watches]) =>
        checkWatches(
          watcherThreadId,
          watches.filter(
            (watch) => watch.threadId === targetThreadId && watch.environmentId === undefined,
          ),
        ),
      { discard: true },
    );

  // Runs for every domain event; most return before any read.
  const handle: ThreadWatchReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      switch (event.type) {
        case "run.updated":
          if (ThreadManagement.isTerminalRunStatus(event.payload.status)) {
            yield* checkWatchersOf(event.threadId);
          }
          return;
        case "runtime-request.updated":
          if (event.payload.status === "pending") yield* checkWatchersOf(event.threadId);
          return;
        case "turn-item.updated":
          // A Stop on a stalled thread ends it with no further run event.
          if (event.payload.type === "run_interrupt_request") {
            yield* checkWatchersOf(event.threadId);
          }
          return;
        case "thread.deleted":
          watchesByWatcher.delete(event.threadId);
          yield* checkWatchersOf(event.threadId);
          return;
        case "thread.metadata-updated": {
          const watches = event.payload.threadWatches ?? [];
          const known = watchesByWatcher.get(event.threadId) ?? [];
          remember(event.threadId, watches);
          // A new watch: its thread may have ended before it was recorded.
          yield* checkWatches(
            event.threadId,
            watches.filter(
              (watch) =>
                !known.some(
                  (seen) =>
                    sameThreadWatchTarget(seen, watch) && seen.startedAt === watch.startedAt,
                ),
            ),
          );
          return;
        }
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread watch event failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start: ThreadWatchReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Events from before the sweep replay after it, so a run that ends during it is seen.
        const afterSequence = yield* eventSink.latestSequence();
        yield* Stream.runForEach(engine.streamStoredEventsFrom({ afterSequence }), (stored) =>
          handle(stored.event),
        ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(followers));
        const watchers = yield* projections.getThreadWatchers();
        for (const watcher of watchers) {
          if (!watchesByWatcher.has(watcher.id)) remember(watcher.id, watcher.threadWatches);
        }
        yield* Effect.forEach(
          watchers,
          (watcher) => checkWatches(watcher.id, watcher.threadWatches),
          { discard: true },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return ThreadWatchReactor.of({ start, handle });
});

export const layer = Layer.effect(ThreadWatchReactor, make);
