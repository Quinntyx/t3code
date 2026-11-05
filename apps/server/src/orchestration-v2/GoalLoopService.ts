import {
  CommandId,
  MessageId,
  goalTurnPrompt,
  type OrchestrationV2RunStatus,
  type ThreadId,
} from "@t3tools/contracts";
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

/**
 * T3 Code drives `/goal` itself where the provider has no native goal. Each completed turn
 * starts the next one until the agent reports the goal met, so the loop lives here rather
 * than in an adapter. A provider with native goals keeps its own loop and never reaches this.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const continueGoal = Effect.fn("GoalLoopService.continueGoal")(
    function* (threadId: ThreadId) {
      const records = yield* projections.getThreadRecords(threadId, ["runs", "runtimeRequests"]);
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

  const start = Effect.fn("GoalLoopService.start")(function* () {
    return yield* forkParkedFiber(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "run.updated") {
          return event.payload.status === "completed" ? continueGoal(event.threadId) : Effect.void;
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
