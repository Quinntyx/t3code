import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  goalReviewPrompt,
  goalTurnPrompt,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GoalLoopService from "./GoalLoopService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread-goal-loop");
const reviewThreadId = ThreadId.make("thread-goal-review");
const objective = "all tests in packages/api pass";

const activeGoal = { objective, status: "active" } as const;

const modelSelection = {
  instanceId: "provider-instance",
  model: "model",
} as unknown as OrchestrationV2AppThread["modelSelection"];

const appThread = (overrides: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id: threadId,
    goal: activeGoal,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    ...overrides,
  }) as unknown as OrchestrationV2AppThread;

const reviewThread = () =>
  appThread({
    id: reviewThreadId,
    goal: null,
    lineage: {
      parentThreadId: threadId,
      relationshipToParent: "subagent",
      rootThreadId: threadId,
    },
  });

const reviewTask = () =>
  ({
    id: "task-goal-review",
    purpose: "goal_review",
    childThreadId: reviewThreadId,
  }) as unknown as OrchestrationV2Subagent;

const run = (id: string, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(id),
    status,
    rootNodeId: "node-root",
  }) as unknown as OrchestrationV2Run;

const completedRun = (id: string, thread = threadId): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId: thread,
    payload: run(id, "completed"),
  }) as unknown as OrchestrationV2DomainEvent;

const goalUpdated = (status: string): OrchestrationV2DomainEvent =>
  ({
    type: "thread.metadata-updated",
    threadId,
    payload: { goal: { objective, status } },
  }) as unknown as OrchestrationV2DomainEvent;

/** Runs the loop over fixed events and returns the commands it dispatched. */
const dispatchedFor = (input: {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly thread?: OrchestrationV2AppThread;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly runtimeRequests?: ReadonlyArray<{ readonly status: string }>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
}) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2Command> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.fromIterable(input.events),
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      } as unknown as Orchestrator.OrchestratorV2Shape),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadRecords: (id: ThreadId) =>
          Effect.succeed(
            id === reviewThreadId
              ? {
                  thread: reviewThread(),
                  runs: [run("review-run-1", "completed")],
                  messages: [],
                  runtimeRequests: [],
                  subagents: [],
                }
              : {
                  thread: input.thread ?? appThread(),
                  runs: input.runs ?? [run("run-1", "completed")],
                  messages: [],
                  runtimeRequests: input.runtimeRequests ?? [],
                  subagents: input.subagents ?? [],
                },
          ),
      } as unknown as ProjectionStore.ProjectionStoreV2Shape),
    );
    yield* Effect.gen(function* () {
      const service = yield* GoalLoopService.make;
      yield* Fiber.join(yield* service.start());
    }).pipe(Effect.provide(layer));
    return dispatched;
  });

it.effect("reviews an active goal after a completed turn", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({ events: [completedRun("run-1")] });

    assert.deepEqual(dispatched, [
      {
        type: "delegated_task.request",
        commandId: CommandId.make(`server:goal-review:${threadId}:run-1`),
        parentThreadId: threadId,
        parentRunId: RunId.make("run-1"),
        parentNodeId: NodeId.make("node-root"),
        task: goalReviewPrompt({ objective, threadId }),
        title: "Review the goal",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        purpose: "goal_review",
        createdBy: "agent",
        creationSource: "server",
      },
    ]);
  }),
);

it.effect("continues the parent when the review leaves the goal open", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [completedRun("review-run-1", reviewThreadId)],
      subagents: [reviewTask()],
    });

    assert.deepEqual(dispatched, [
      {
        type: "message.dispatch",
        commandId: CommandId.make(`server:goal-continue:${threadId}:run-1`),
        messageId: MessageId.make(`goal-continue:${threadId}:run-1`),
        threadId,
        text: goalTurnPrompt(objective),
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
    ]);
  }),
);

it.effect("stops when the review closes the goal", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [completedRun("review-run-1", reviewThreadId)],
      thread: appThread({ goal: { objective, status: "complete" } }),
      subagents: [reviewTask()],
    });

    assert.deepEqual(dispatched, []);
  }),
);

it.effect("continues the parent when the review failed", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [
        {
          type: "run.updated",
          threadId: reviewThreadId,
          payload: run("review-run-1", "failed"),
        } as unknown as OrchestrationV2DomainEvent,
      ],
      subagents: [reviewTask()],
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["message.dispatch"],
    );
  }),
);

it.effect("starts a goal that is resumed on an idle thread", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({ events: [goalUpdated("active")] });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["message.dispatch"],
    );
  }),
);

it.effect.each(
  (
    [
      ["a paused goal", { thread: appThread({ goal: { objective, status: "paused" } }) }],
      ["a completed goal", { thread: appThread({ goal: { objective, status: "complete" } }) }],
      ["no goal", { thread: appThread({ goal: null }) }],
      ["an archived thread", { thread: appThread({ archivedAt: DateTime.makeUnsafe(0) }) }],
      ["a settled thread", { thread: appThread({ settledOverride: "settled" }) }],
      [
        "a snoozed thread",
        { thread: appThread({ snoozedUntil: DateTime.makeUnsafe(4_102_444_800_000) }) },
      ],
      ["a pending question", { runtimeRequests: [{ status: "pending" }] }],
      ["a live run", { runs: [run("run-1", "completed"), run("run-2", "running")] }],
      ["a queued run", { runs: [run("run-1", "completed"), run("run-2", "queued")] }],
      ["no runs", { runs: [] }],
    ] as const
  ).map(([label, input]) => ({ label, input })),
)("leaves $label alone", ({ input }) =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [completedRun("run-1")],
      ...input,
    });

    assert.deepEqual(dispatched, []);
  }),
);

it.effect("ignores a turn that did not complete", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [
        {
          type: "run.updated",
          threadId,
          payload: run("run-1", "interrupted"),
        } as unknown as OrchestrationV2DomainEvent,
      ],
    });

    assert.deepEqual(dispatched, []);
  }),
);
