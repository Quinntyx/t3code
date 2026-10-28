import {
  DeusCursor,
  DeusStateError,
  type DeusInput,
  type DeusInputReceipt,
  type DeusOpenInput,
  type DeusResetConversationInput,
  type DeusSessionRef,
  type DeusSnapshot,
  type DeusSubscriptionInput,
  type DeusSubscriptionEvent,
  type DeusTask,
  type DeusTaskLaunchInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as DeusRepository from "./DeusRepository.ts";
import { type OrchestrationEventStoreError } from "../persistence/Errors.ts";
import { type LaunchAcknowledgment, type PendingIntent, type TaskReport } from "./decide.ts";

type Failure = DeusRepository.DeusRepositoryError;
export class DeusSessionService extends Context.Service<
  DeusSessionService,
  {
    readonly open: (input: DeusOpenInput) => Effect.Effect<DeusSnapshot, Failure>;
    readonly snapshot: (ref: DeusSessionRef) => Effect.Effect<DeusSnapshot, Failure>;
    readonly acceptInput: (input: DeusInput) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly resetConversation: (
      input: DeusResetConversationInput,
    ) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly prepareLaunch: (
      input: DeusTaskLaunchInput,
    ) => Effect.Effect<{ readonly receipt: DeusInputReceipt; readonly task: DeusTask }, Failure>;
    readonly acknowledgeLaunch: (
      input: LaunchAcknowledgment,
    ) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly recordReport: (input: TaskReport) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly subscribe: (
      input: DeusSubscriptionInput,
    ) => Effect.Effect<Stream.Stream<DeusSubscriptionEvent, Failure>, Failure, Scope.Scope>;
    readonly pending: Effect.Effect<ReadonlyArray<PendingIntent>, Failure>;
    readonly recover: Effect.Effect<ReadonlyArray<PendingIntent>, Failure>;
    readonly start: Effect.Effect<void, Failure | OrchestrationEventStoreError, Scope.Scope>;
  }
>()("t3/deus/DeusSessionService") {}

const make = Effect.gen(function* () {
  const repository = yield* DeusRepository.DeusRepository;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const subscribe = Effect.fn("DeusSessionService.subscribe")(function* (
    input: DeusSubscriptionInput,
  ) {
    const signals = yield* repository.subscribe;
    const initial = yield* repository.snapshot(input);
    if (input.after > initial.cursor)
      return yield* new DeusStateError({
        reason: "conflict",
        message: "Deus cursor is ahead of the session.",
      });
    let cursor = input.after === 0 ? initial.cursor : input.after;
    const catchUp = (): Stream.Stream<DeusSubscriptionEvent, Failure> =>
      Stream.unwrap(
        repository.readDeltas(input, cursor).pipe(
          Effect.map((deltas) => {
            if (deltas.length === 0) return Stream.empty;
            const page = Stream.fromIterable(deltas).pipe(
              Stream.map((delta): DeusSubscriptionEvent => ({ type: "delta", delta })),
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "delta") cursor = event.delta.cursor;
                }),
              ),
            );
            return Stream.concat(page, Stream.suspend(catchUp));
          }),
        ),
      );
    const live = Stream.fromSubscription(signals).pipe(
      Stream.flatMap(() => Stream.suspend(catchUp)),
    );
    return Stream.concat(
      input.after === DeusCursor.make(0)
        ? Stream.succeed<DeusSubscriptionEvent>({ type: "snapshot", snapshot: initial })
        : Stream.suspend(catchUp),
      live,
    );
  });
  const recover = repository.pending;
  const start = Effect.gen(function* () {
    const afterSequence = yield* events.latestApplicationSequence;
    const pending = yield* recover;
    yield* Effect.logInfo("Deus committed work retained; execution is unavailable", {
      pendingIntentCount: pending.length,
    });
    yield* events
      .streamProjectedApplicationEvents({
        afterSequence,
        filter: (event) => "type" in event && event.type === "project.deleted",
        project: (event) => event,
      })
      .pipe(
        Stream.runForEach((event) =>
          "type" in event && event.type === "project.deleted"
            ? repository.projectDeleted(event.payload.projectId)
            : Effect.void,
        ),
        Effect.orDie,
        Effect.forkScoped,
      );
  });
  return DeusSessionService.of({
    open: repository.open,
    snapshot: repository.snapshot,
    pending: repository.pending,
    recover,
    start,
    acceptInput: Effect.fn("DeusSessionService.acceptInput")(function (input) {
      return repository
        .commit({ type: "input", input })
        .pipe(Effect.map((result) => result.receipt));
    }),
    resetConversation: Effect.fn("DeusSessionService.resetConversation")(function (input) {
      return repository
        .commit({ type: "reset", input })
        .pipe(Effect.map((result) => result.receipt));
    }),
    prepareLaunch: Effect.fn("DeusSessionService.prepareLaunch")(function* (input) {
      const result = yield* repository.commit({ type: "launch", input });
      if (!result.task) return yield* Effect.die("Committed Deus launch is missing its task.");
      return { receipt: result.receipt, task: result.task };
    }),
    acknowledgeLaunch: Effect.fn("DeusSessionService.acknowledgeLaunch")(function (input) {
      return repository
        .commit({ type: "acknowledge-launch", input })
        .pipe(Effect.map((result) => result.receipt));
    }),
    recordReport: Effect.fn("DeusSessionService.recordReport")(function (input) {
      return repository
        .commit({ type: "report", input })
        .pipe(Effect.map((result) => result.receipt));
    }),
    subscribe,
  });
});
export const layer = Layer.effect(DeusSessionService, make);
