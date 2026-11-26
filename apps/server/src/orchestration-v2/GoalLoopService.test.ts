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

/** A failed run and the root error that ended it, which is what decides a stall. */
const overloadedRunFact = (id = "run-1", stopped = false) => ({
  runs: [run(id, "failed")],
  turnItems: [
    {
      type: "error" as const,
      status: "failed",
      runId: RunId.make(id),
      nodeId: NodeId.make("node-root"),
      failure: { class: "provider_error", overloaded: true },
    },
    ...(stopped
      ? [
          {
            type: "run_interrupt_request" as const,
            status: "completed",
            runId: RunId.make(id),
          },
        ]
      : []),
  ],
});

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
  readonly messages?: ReadonlyArray<{
    readonly role: string;
    readonly createdBy: string;
    readonly createdAt: DateTime.Utc;
  }>;
  readonly runtimeRequests?: ReadonlyArray<{ readonly status: string }>;
  readonly turnItems?: ReadonlyArray<{
    readonly type: string;
    readonly status: string;
    readonly startedAt?: DateTime.Utc;
    readonly updatedAt?: DateTime.Utc;
  }>;
  readonly providerThreads?: ReadonlyArray<{
    readonly pendingBackgroundTasks?: ReadonlyArray<unknown>;
  }>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly review?: ReturnType<typeof overloadedRunFact>;
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
                  runs: input.review?.runs ?? [run("review-run-1", "completed")],
                  messages: [],
                  runtimeRequests: [],
                  turnItems: input.review?.turnItems ?? [],
                  providerThreads: [],
                  subagents: [],
                }
              : {
                  thread: input.thread ?? appThread(),
                  runs: input.runs ?? [run("run-1", "completed")],
                  messages: input.messages ?? [],
                  runtimeRequests: input.runtimeRequests ?? [],
                  turnItems: input.turnItems ?? [],
                  providerThreads: input.providerThreads ?? [],
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

it.effect.each([
  { label: "waits for a stalled review's retry", stopped: false, expected: [] },
  {
    label: "continues once the review's retries are stopped",
    stopped: true,
    expected: ["message.dispatch"],
  },
])("$label", ({ stopped, expected }) =>
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
      review: overloadedRunFact("review-run-1", stopped),
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      expected,
    );
  }),
);

it.effect.each([
  {
    label: "continues when a stalled review's retries are stopped",
    review: overloadedRunFact("review-run-1", true),
    expected: ["message.dispatch"],
  },
  // An ordinary Stop on a review ends with its own run event; the mark alone decides nothing.
  { label: "leaves a Stop on a review that was not overloaded alone", expected: [] },
])("$label", ({ review, expected }) =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [
        {
          type: "turn-item.updated",
          threadId: reviewThreadId,
          payload: { type: "run_interrupt_request" },
        } as unknown as OrchestrationV2DomainEvent,
      ],
      subagents: [reviewTask()],
      ...(review === undefined ? {} : { review }),
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      expected,
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

it.effect("reviews a completed retry whose stale record still names the run it replaced", () =>
  Effect.gen(function* () {
    // The retry finished, but the schedule was never cleaned up; the run itself decides.
    const dispatched = yield* dispatchedFor({
      events: [completedRun("run-2")],
      runs: [run("run-1", "failed"), run("run-2", "completed")],
      thread: appThread({
        stallRecovery: {
          runId: RunId.make("run-1"),
          attempt: 1,
          nextAttemptAt: "2099-01-01T00:10:00.000Z",
        },
      }),
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["delegated_task.request"],
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
      ["a stalled thread", { ...overloadedRunFact(), thread: appThread() }],
      // A Stop ended the retries; the user asked for rest, so no goal turn starts.
      ["a stopped overload", { ...overloadedRunFact("run-1", true), thread: appThread() }],
      ["an email draft", { turnItems: [{ type: "email_request", status: "waiting" }] }],
      ["a secret request", { turnItems: [{ type: "secret_request", status: "waiting" }] }],
      ["a feedback request", { turnItems: [{ type: "feedback_request", status: "waiting" }] }],
      [
        "an unanswered link request",
        {
          turnItems: [
            {
              type: "link_request",
              status: "waiting",
              updatedAt: DateTime.makeUnsafe(2_000),
            },
          ],
          messages: [{ role: "user", createdBy: "user", createdAt: DateTime.makeUnsafe(1_000) }],
        },
      ],
      ["an earlier live run", { runs: [run("run-0", "running"), run("run-1", "completed")] }],
      ["a live run", { runs: [run("run-1", "completed"), run("run-2", "running")] }],
      ["a queued run", { runs: [run("run-1", "completed"), run("run-2", "queued")] }],
      [
        "a thread watch",
        {
          thread: appThread({
            threadWatches: [
              {
                threadId: ThreadId.make("thread-watched"),
                runId: RunId.make("run-watched"),
                startedAt: "2026-11-23T00:00:00.000Z",
              },
            ],
          }),
        },
      ],
      [
        "a consumption cap hit",
        {
          thread: appThread({
            consumptionCapHit: {
              at: "2026-11-23T00:00:00.000Z",
              reason: "Session usage 90% reached 80% cap.",
            },
          }),
        },
      ],
      ["an active async subagent", { turnItems: [{ type: "subagent", status: "running" }] }],
      [
        "pending provider background tasks",
        {
          providerThreads: [
            {
              pendingBackgroundTasks: [
                { taskId: "bg-1", kind: "background_task", description: "build" },
              ],
            },
          ],
        },
      ],
      [
        "an awaited PR watch",
        {
          thread: appThread({
            pullRequests: [
              {
                host: "github.com",
                repository: "org/repo",
                number: 1,
                url: "https://github.com/org/repo/pull/1",
                watch: { until: "merged" },
              },
            ] as unknown as OrchestrationV2AppThread["pullRequests"],
          }),
        },
      ],
      ["no runs", { runs: [] }],
    ] as const
  ).map(([label, input]) => ({ label, input })),
)("leaves $label alone", ({ input }) =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [completedRun("run-1"), goalUpdated("active")],
      ...input,
    });

    assert.deepEqual(dispatched, []);
  }),
);

it.effect("continues past a link_request once the user posts a newer message", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({
      events: [completedRun("run-1")],
      turnItems: [
        {
          type: "link_request",
          status: "waiting",
          updatedAt: DateTime.makeUnsafe(1_000),
        },
      ],
      messages: [{ role: "user", createdBy: "user", createdAt: DateTime.makeUnsafe(2_000) }],
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["delegated_task.request"],
    );
  }),
);

it.effect("ignores unrelated metadata updates on interrupted threads and unawaited commands", () =>
  Effect.gen(function* () {
    const afterInterrupt = yield* dispatchedFor({
      events: [goalUpdated("active")],
      runs: [run("run-1", "interrupted")],
    });
    assert.deepEqual(afterInterrupt, []);

    const withUnawaitedCommand = yield* dispatchedFor({
      events: [completedRun("run-1")],
      turnItems: [{ type: "command_execution", status: "running" }],
    });
    assert.deepEqual(
      withUnawaitedCommand.map((command) => command.type),
      ["delegated_task.request"],
    );
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
