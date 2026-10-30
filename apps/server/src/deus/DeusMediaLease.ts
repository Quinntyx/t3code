import {
  DeusAttachmentId,
  DeusLeaseError,
  type DeusAttachment,
  type DeusAttachmentInput,
  type DeusAttachInput,
  type DeusSessionRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as Repository from "./DeusRepository.ts";
import {
  DeusActionSource,
  type DeusAuthority,
  DeusAuthorityError,
  type DeusAuthorityRef,
} from "./DeusAuthority.ts";
import {
  DeusHumanAuthority,
  type HumanInput,
  type HumanCeiling,
  type HumanConnection,
} from "./DeusHumanAuthority.ts";

export const DEUS_LEASE_MS = 30_000;
export interface MediaLease {
  readonly attachment: DeusAttachment;
  readonly scope: Scope.Closeable;
}
type Failure = DeusLeaseError | DeusAuthorityError;
export class DeusMediaLease extends Context.Service<
  DeusMediaLease,
  {
    readonly acquire: (
      connection: HumanConnection,
      input: DeusAttachInput,
      ceiling: HumanCeiling,
    ) => Effect.Effect<MediaLease, Failure>;
    readonly owner: (
      connection: HumanConnection,
      input: DeusAttachmentInput,
    ) => Effect.Effect<MediaLease, Failure>;
    readonly renew: (
      connection: HumanConnection,
      input: DeusAttachmentInput,
    ) => Effect.Effect<DeusAttachment, Failure>;
    readonly release: (
      connection: HumanConnection,
      input: DeusAttachmentInput,
    ) => Effect.Effect<void, Failure>;
    readonly validate: (attachment: DeusAttachmentInput) => Effect.Effect<void, Failure>;
    readonly authorize: DeusAuthority["Service"]["authorize"];
  }
>()("t3/deus/DeusMediaLease") {}
const leaseError = (reason: DeusLeaseError["reason"]) =>
  new DeusLeaseError({
    reason,
    message: "The media attachment is occupied, expired or no longer owned by this connection.",
  });
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const key = (ref: DeusSessionRef) => encodeKey([ref.environmentId, ref.projectId, ref.sessionId]);
interface State {
  attachment: DeusAttachment;
  readonly input: HumanInput;
  readonly connection: HumanConnection;
  readonly scope: Scope.Closeable;
  expires: number;
  closed: boolean;
}
const make = Effect.gen(function* () {
  const human = yield* DeusHumanAuthority;
  const repository = yield* Repository.DeusRepository;
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Scope.Scope;
  const lane = yield* Semaphore.make(1);
  const current = new Map<string, State>();
  const sql = yield* SqlClient.SqlClient;
  const view = (state: State): MediaLease => ({
    attachment: { ...state.attachment },
    scope: state.scope,
  });
  const close = Effect.fn("DeusMediaLease.close")(function* (state: State) {
    state.closed = true;
    if (current.get(key(state.attachment)) === state) current.delete(key(state.attachment));
    yield* Scope.close(state.scope, Exit.void);
  });
  const lookup = Effect.fn("DeusMediaLease.lookup")(function* (ref: DeusAttachmentInput) {
    const state = current.get(key(ref));
    if (!state || state.closed) return yield* leaseError("expired");
    if (
      state.attachment.attachmentId !== ref.attachmentId ||
      state.attachment.generation !== ref.generation
    )
      return yield* leaseError("stale-generation");
    if (state.expires <= (yield* DateTime.now).epochMilliseconds) {
      yield* close(state);
      return yield* leaseError("expired");
    }
    yield* state.connection.check(ref).pipe(Effect.onError(() => close(state)));
    return state;
  });
  const owner = Effect.fn("DeusMediaLease.owner")(function* (
    connection: HumanConnection,
    input: DeusAttachmentInput,
  ) {
    const state = yield* lookup(input);
    if (state.connection !== connection) return yield* leaseError("not-owner");
    return state;
  });
  const authorize = Effect.fn("DeusMediaLease.authorize")(function* (ref: DeusAuthorityRef) {
    const attachmentId = ref.attachmentId ?? ref.origin?.attachmentId;
    if (!attachmentId) return yield* human.authorize(ref);
    const state = current.get(key(ref));
    if (!state || state.attachment.attachmentId !== attachmentId)
      return yield* new DeusAuthorityError({ reason: "inactive" });
    yield* lookup(state.attachment).pipe(
      Effect.mapError(() => new DeusAuthorityError({ reason: "inactive" })),
    );
    return yield* human.authorize(ref).pipe(Effect.provideService(DeusActionSource, state.input));
  });
  const expiry = (state: State): Effect.Effect<void> =>
    Effect.suspend(() =>
      DateTime.now.pipe(
        Effect.flatMap((now) => {
          if (state.closed) return Effect.void;
          const remaining = state.expires - now.epochMilliseconds;
          return remaining > 0
            ? Effect.sleep(remaining).pipe(Effect.andThen(expiry(state)))
            : close(state).pipe(Effect.forkIn(serviceScope), Effect.asVoid);
        }),
      ),
    );
  const changes = yield* repository.subscribe;
  yield* Effect.forever(
    PubSub.take(changes).pipe(
      Effect.andThen(
        Effect.forEach(
          current.values(),
          (state) =>
            state.connection.check(state.attachment).pipe(Effect.catch(() => close(state))),
          { discard: true },
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);
  const afterSequence = yield* applicationEvents.latestApplicationSequence;
  yield* applicationEvents
    .streamProjectedApplicationEvents({
      afterSequence,
      project: (event) => event,
      filter: (event) => !("event" in event) && event.type === "project.deleted",
    })
    .pipe(
      Stream.runForEach((event) => {
        if ("event" in event || event.type !== "project.deleted") return Effect.void;
        return Effect.forEach(
          [...current.values()].filter((state) => state.attachment.projectId === event.aggregateId),
          close,
          { discard: true },
        );
      }),
      Effect.catch(() => Effect.forEach(current.values(), close, { discard: true })),
      Effect.forkScoped,
    );
  yield* Effect.addFinalizer(() => Effect.forEach(current.values(), close, { discard: true }));
  return DeusMediaLease.of({
    authorize,
    validate: Effect.fn("DeusMediaLease.validate")((input) => lookup(input).pipe(Effect.asVoid)),
    owner: Effect.fn("DeusMediaLease.ownerView")((connection, input) =>
      owner(connection, input).pipe(Effect.map(view)),
    ),
    renew: Effect.fn("DeusMediaLease.renew")(function* (connection, input) {
      const state = yield* owner(connection, input);
      state.expires = (yield* DateTime.now).epochMilliseconds + DEUS_LEASE_MS;
      state.attachment = {
        ...state.attachment,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(state.expires)),
      };
      return { ...state.attachment };
    }),
    release: Effect.fn("DeusMediaLease.release")(function* (connection, input) {
      yield* close(yield* owner(connection, input));
    }),
    acquire: Effect.fn("DeusMediaLease.acquire")(function (connection, input, ceiling) {
      return Effect.gen(function* () {
        yield* connection.check(input);
        const existing = current.get(key(input));
        if (existing?.input.inputId === input.inputId) {
          const owned = yield* owner(connection, existing.attachment);
          yield* connection.bind(input, ceiling);
          return view(owned);
        }
        if (
          existing &&
          !existing.closed &&
          existing.expires > (yield* DateTime.now).epochMilliseconds &&
          !input.takeover
        )
          return yield* leaseError("occupied");
        if (current.size >= 32 && !existing)
          return yield* new DeusAuthorityError({ reason: "capacity" });
        const consumed = yield* sql`SELECT input_id FROM deus_authority_claims
          WHERE environment_id = ${input.environmentId} AND project_id = ${input.projectId}
          AND input_id = ${input.inputId}`.pipe(
          Effect.mapError(() => leaseError("stale-generation")),
        );
        if (consumed.length) return yield* leaseError("stale-generation");
        const scope = yield* Scope.fork(connection.scope);
        yield* connection
          .bind(input, ceiling, scope)
          .pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        const generations = yield* sql<{
          generation: number;
        }>`INSERT INTO deus_media_generations (session_id, generation)
          VALUES (${input.sessionId}, 1) ON CONFLICT(session_id)
          DO UPDATE SET generation = generation + 1 RETURNING generation`.pipe(
          Effect.mapError(() => leaseError("stale-generation")),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const generation = generations[0]!.generation;
        const expires = (yield* DateTime.now).epochMilliseconds + DEUS_LEASE_MS;
        const attachment: DeusAttachment = {
          environmentId: input.environmentId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          attachmentId: DeusAttachmentId.make(
            yield* crypto
              .randomUUIDv4()
              .pipe(Effect.mapError(() => new DeusAuthorityError({ reason: "inactive" }))),
          ),
          generation,
          responseEpoch: 0,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
        };
        const state: State = { attachment, input, connection, scope, expires, closed: false };
        current.set(key(input), state);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            state.closed = true;
            if (current.get(key(input)) === state) current.delete(key(input));
          }),
        );
        if (existing) yield* close(existing);
        yield* expiry(state).pipe(Effect.forkIn(scope));
        return view(state);
      }).pipe(lane.withPermits(1), Effect.uninterruptible);
    }),
  });
});
export const layer = Layer.effect(DeusMediaLease, make);
