import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  goalTurnPrompt,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
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
const objective = "all tests in packages/api pass";

const activeGoal = { objective, status: "active" } as const;

const appThread = (overrides: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id: threadId,
    goal: activeGoal,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    ...overrides,
  }) as unknown as OrchestrationV2AppThread;

const run = (id: string, status: OrchestrationV2Run["status"]) =>
  ({ id: RunId.make(id), status }) as unknown as OrchestrationV2Run;

const completedRun = (id: string): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
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
        getThreadRecords: () =>
          Effect.succeed({
            thread: input.thread ?? appThread(),
            runs: input.runs ?? [run("run-1", "completed")],
            messages: [],
            runtimeRequests: input.runtimeRequests ?? [],
          }),
      } as unknown as ProjectionStore.ProjectionStoreV2Shape),
    );
    yield* Effect.gen(function* () {
      const service = yield* GoalLoopService.make;
      yield* Fiber.join(yield* service.start());
    }).pipe(Effect.provide(layer));
    return dispatched;
  });

it.effect("continues an active goal after a completed turn", () =>
  Effect.gen(function* () {
    const dispatched = yield* dispatchedFor({ events: [completedRun("run-1")] });

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

it.effect("continues a goal that is resumed on an idle thread", () =>
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
