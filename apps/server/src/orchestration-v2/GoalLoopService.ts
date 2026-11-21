import {
  CommandId,
  MessageId,
  goalReviewPrompt,
  goalTurnPrompt,
  type OrchestrationV2RunStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { overloadedRun, stalledRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParkedFiber } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Reading the overload failure and the waiting cards is all the gates need. */
const GOAL_TURN_ITEM_TYPES = ["error", "secret_request", "email_request"] as const;

const isWaitingUserInputCard = (item: { readonly type: string; readonly status: string }) =>
  (item.type === "secret_request" || item.type === "email_request") && item.status === "waiting";

/**
 * T3 Code drives `/goal` itself where the provider has no native goal. Each turn ends with a
 * review delegate that judges the work, and only a goal it leaves open starts the next turn, so
 * the loop lives here rather than in an adapter. A provider with native goals never reaches this.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  /** The parent of a goal-review child thread, when this thread is one. */
  const reviewParentOf = Effect.fn("GoalLoopService.reviewParentOf")(function* (
    threadId: ThreadId,
  ) {
    const child = yield* projections.getThreadRecords(threadId, []);
    const parentThreadId = child.thread.lineage.parentThreadId;
    if (parentThreadId === null) return undefined;
    const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
    const review = parent.subagents.find(
      (task) => task.purpose === "goal_review" && task.childThreadId === threadId,
    );
    return review === undefined ? undefined : parentThreadId;
  });

  /** How an overload left this thread: still being retried, stopped by the user, or neither. */
  const overloadState = Effect.fn("GoalLoopService.overloadState")(function* (threadId: ThreadId) {
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["error", "run_interrupt_request"],
    });
    if (stalledRun(records.runs, records.turnItems) !== null) return "stalled" as const;
    return overloadedRun(records.runs, records.turnItems) === null ? null : ("stopped" as const);
  });

  const continueGoal = Effect.fn("GoalLoopService.continueGoal")(
    function* (threadId: ThreadId) {
      const records = yield* projections.getThreadRecords(
        threadId,
        ["runs", "runtimeRequests", "turnItems"],
        { turnItemTypes: GOAL_TURN_ITEM_TYPES },
      );
      const goal = records.thread.goal ?? null;
      if (goal?.status !== "active") return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (
        records.thread.archivedAt !== null ||
        records.thread.deletedAt !== null ||
        // Settling or snoozing is the user saying the thread should rest.
        records.thread.settledOverride === "settled" ||
        (records.thread.snoozedUntil != null &&
          DateTime.toEpochMillis(records.thread.snoozedUntil) > now) ||
        // The agent is waiting on an answer, not on more work.
        records.runtimeRequests.some((request) => request.status === "pending") ||
        // An overloaded latest run is the recovery worker's job; a goal turn here would replace
        // its retry, and after a Stop the user asked for rest.
        overloadedRun(records.runs, records.turnItems) !== null ||
        records.turnItems.some(isWaitingUserInputCard) ||
        records.runs.some((run) => LIVE_RUN_STATUSES.has(run.status))
      ) {
        return;
      }
      const latest = records.runs.at(-1);
      if (latest === undefined) return;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        // One continuation per finished turn, even across duplicate events.
        commandId: CommandId.make(`server:goal-continue:${threadId}:${latest.id}`),
        messageId: MessageId.make(`goal-continue:${threadId}:${latest.id}`),
        threadId,
        text: goalTurnPrompt(goal.objective),
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("goal continuation skipped", { threadId, cause }),
        ),
      ),
  );

  /**
   * A finished goal turn is judged before anything continues it. The reviewer is a delegate on
   * the same agent, so the working agent never decides on its own that the goal is met.
   */
  const reviewGoal = Effect.fn("GoalLoopService.reviewGoal")(
    function* (threadId: ThreadId) {
      const records = yield* projections.getThreadRecords(
        threadId,
        ["runs", "runtimeRequests", "turnItems"],
        { turnItemTypes: GOAL_TURN_ITEM_TYPES },
      );
      const goal = records.thread.goal ?? null;
      if (goal?.status !== "active") return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (
        records.thread.archivedAt !== null ||
        records.thread.deletedAt !== null ||
        records.thread.settledOverride === "settled" ||
        (records.thread.snoozedUntil != null &&
          DateTime.toEpochMillis(records.thread.snoozedUntil) > now) ||
        records.runtimeRequests.some((request) => request.status === "pending") ||
        // The recovery worker owns an overloaded latest run; reviewing it here would replace
        // its retry, and after a Stop the user asked for rest.
        overloadedRun(records.runs, records.turnItems) !== null ||
        records.turnItems.some(isWaitingUserInputCard) ||
        records.runs.some((run) => LIVE_RUN_STATUSES.has(run.status))
      ) {
        return;
      }
      const latest = records.runs.at(-1);
      if (latest === undefined || latest.status !== "completed" || latest.rootNodeId === null) {
        return;
      }
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        // One review per finished turn, even across duplicate events.
        commandId: CommandId.make(`server:goal-review:${threadId}:${latest.id}`),
        parentThreadId: threadId,
        parentRunId: latest.id,
        parentNodeId: latest.rootNodeId,
        task: goalReviewPrompt({ objective: goal.objective, threadId }),
        title: "Review the goal",
        modelSelection: records.thread.modelSelection,
        runtimeMode: records.thread.runtimeMode,
        interactionMode: records.thread.interactionMode,
        purpose: "goal_review",
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("goal review skipped", { threadId, cause })),
      ),
  );

  const start = Effect.fn("GoalLoopService.start")(function* () {
    return yield* forkParkedFiber(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "run.updated") {
          const status = event.payload.status;
          if (status === "completed") {
            return reviewParentOf(event.threadId).pipe(
              Effect.flatMap((parentThreadId) =>
                parentThreadId === undefined
                  ? reviewGoal(event.threadId)
                  : continueGoal(parentThreadId),
              ),
            );
          }
          // A reviewer that failed still leaves the goal to the next turn, unless the server is
          // retrying it: then its verdict is still coming.
          if (status === "failed") {
            return reviewParentOf(event.threadId).pipe(
              Effect.flatMap((parentThreadId) =>
                parentThreadId === undefined
                  ? Effect.void
                  : overloadState(event.threadId).pipe(
                      Effect.flatMap((state) =>
                        state === "stalled" ? Effect.void : continueGoal(parentThreadId),
                      ),
                    ),
              ),
            );
          }
          return Effect.void;
        }
        // Stopping a stalled reviewer's retries ends it with no run event, so its Stop mark is
        // what tells the goal the review will not come.
        if (event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request") {
          return reviewParentOf(event.threadId).pipe(
            Effect.flatMap((parentThreadId) =>
              parentThreadId === undefined
                ? Effect.void
                : overloadState(event.threadId).pipe(
                    Effect.flatMap((state) =>
                      state === "stopped" ? continueGoal(parentThreadId) : Effect.void,
                    ),
                  ),
            ),
          );
        }
        // A goal set or resumed on an idle thread starts its first turn here.
        if (event.type === "thread.metadata-updated" && event.payload.goal?.status === "active") {
          return continueGoal(event.threadId);
        }
        return Effect.void;
      }),
    );
  });
  return { start };
});
