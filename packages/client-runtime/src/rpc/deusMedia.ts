import {
  type EnvironmentAuthorizationError,
  DEUS_MAX_PCM_BYTES,
  DeusMediaOutput,
  DeusTransportError,
  WS_METHODS,
  type DeusAttachment,
  type DeusConversation,
  type DeusMediaControlInput,
  type DeusPcmInput,
} from "@t3tools/contracts";
import { decodeDeusPcm } from "@t3tools/shared/deusMediaWire";
import type { Done } from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  type EnvironmentRpcFailure,
  requestGuarded,
  RpcPermissionGuard,
  runStreamGuarded,
} from "./client.ts";

type MediaFailure =
  | EnvironmentRpcFailure<typeof WS_METHODS.deusMediaPush>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError;
export interface DeusMediaTransport {
  readonly push: (input: DeusPcmInput) => Effect.Effect<void, MediaFailure>;
  readonly control: (input: DeusMediaControlInput) => Effect.Effect<void, MediaFailure>;
  readonly renew: Effect.Effect<DeusAttachment, MediaFailure>;
  readonly detach: Effect.Effect<void, MediaFailure>;
  readonly output: Stream.Stream<DeusMediaOutput, MediaFailure>;
  readonly disconnected: Effect.Effect<void>;
}

export const makeDeusMediaTransport = Effect.fn("DeusMedia.makeTransport")(function* (
  attachment: DeusAttachment,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const permission = yield* RpcPermissionGuard;
  const current = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(current) || supervisor.target.environmentId !== attachment.environmentId)
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: attachment.environmentId,
      message: "The Deus attachment is not on the connected destination.",
    });
  const session = current.value;
  const bound = { ...supervisor, session: yield* SubscriptionRef.make(Option.some(session)) };
  const provide = <A, E>(effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
    effect.pipe(
      Effect.provideService(EnvironmentSupervisor, bound),
      Effect.provideService(RpcPermissionGuard, permission),
    );
  const disconnected = Effect.raceFirst(
    session.closed.pipe(Effect.ignore),
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter((next) => Option.isNone(next) || next.value !== session),
      Stream.runHead,
      Effect.asVoid,
    ),
  );
  return {
    push: (input) => provide(requestGuarded(WS_METHODS.deusMediaPush, input)),
    control: (input) => provide(requestGuarded(WS_METHODS.deusMediaControl, input)),
    renew: provide(requestGuarded(WS_METHODS.deusRenew, attachment)),
    detach: provide(requestGuarded(WS_METHODS.deusDetach, attachment)),
    output: runStreamGuarded(WS_METHODS.deusMediaSubscribe, attachment).pipe(
      Stream.provideService(EnvironmentSupervisor, bound),
      Stream.provideService(RpcPermissionGuard, permission),
    ),
    disconnected,
  } satisfies DeusMediaTransport;
});

const DEUS_CLIENT_MEDIA_LIMITS = {
  inputFrames: 4,
  outputFrames: 4,
  controlEvents: 16,
  inputInFlight: 1,
  renewEveryMs: 10000,
} as const;
const decodeOutput = Schema.decodeUnknownSync(DeusMediaOutput);
const mediaError = (reason: DeusTransportError["reason"]) =>
  new DeusTransportError({
    reason,
    message:
      reason === "backpressure"
        ? "Deus media reached its bounded queue; attach again explicitly. Metadata and workers remain available."
        : "The Deus media attachment ended; attach again explicitly. Metadata and workers remain available.",
  });

export const makeDeusMediaController = Effect.fn("DeusMedia.makeController")(function* (
  initial: DeusAttachment,
  transport: DeusMediaTransport,
  onEpoch?: (epoch: number) => void,
  conversation?: DeusConversation,
) {
  let attachment = initial;
  let turnId: string | undefined;
  let turnEnded = false;
  let closed = false,
    muted = false,
    controlBusy = false,
    revision = 0,
    sequence = 0,
    outputSequence = -1;
  let inputQueued = 0,
    outputQueued = 0,
    inputInFlight = 0,
    maxInputInFlight = 0,
    inputHighWater = 0,
    outputHighWater = 0,
    droppedInput = 0,
    rejectedOutput = 0;
  const pending = yield* Queue.dropping<{ readonly data: string; readonly revision: number }, Done>(
    DEUS_CLIENT_MEDIA_LIMITS.inputFrames,
  );
  const audio = yield* Queue.dropping<
    {
      readonly bytes: Uint8Array;
      readonly epoch: number;
      readonly conversation?: DeusConversation;
      readonly turnId?: string;
    },
    Done
  >(DEUS_CLIENT_MEDIA_LIMITS.outputFrames);
  const events = yield* Queue.dropping<Exclude<DeusMediaOutput, { type: "pcm" }>, Done>(
    DEUS_CLIENT_MEDIA_LIMITS.controlEvents,
  );
  const stopped = yield* Deferred.make<void>();
  const finished = yield* Deferred.make<void>();
  const expires = yield* SubscriptionRef.make(Date.parse(initial.expiresAt));
  const workers: Array<Fiber.Fiber<void, never>> = [];
  const clear = Effect.gen(function* () {
    yield* Queue.clear(pending);
    yield* Queue.clear(audio);
    inputQueued = 0;
    outputQueued = 0;
    revision++;
  });
  const stop = Effect.fn("DeusMedia.stop")(function* (error?: DeusTransportError) {
    if (closed) return;
    closed = true;
    yield* clear;
    if (error) {
      yield* Queue.clear(events);
      Queue.offerUnsafe(events, {
        ...attachment,
        sequence: Math.max(0, outputSequence + 1),
        type: "error",
        error,
      });
    }
    yield* Queue.end(pending);
    yield* Queue.end(audio);
    yield* Queue.end(events);
    yield* Deferred.succeed(stopped, undefined);
  });
  const fork = Effect.fn("DeusMedia.fork")(function* <E>(effect: Effect.Effect<void, E>) {
    workers.push(
      yield* effect.pipe(
        Effect.catchCause(() => stop(mediaError("disconnected"))),
        Effect.raceFirst(Deferred.await(stopped)),
        Effect.forkScoped,
      ),
    );
  });
  yield* fork(
    Effect.forever(
      Effect.gen(function* () {
        const frame = yield* Queue.take(pending);
        inputQueued--;
        if (closed || muted || controlBusy || frame.revision !== revision) return;
        const sentRevision = revision;
        inputInFlight++;
        maxInputInFlight = Math.max(maxInputInFlight, inputInFlight);
        yield* transport
          .push({
            ...attachment,
            sequence: sequence++,
            type: "pcm",
            encoding: "pcm16le",
            channels: 1,
            sampleRate: 16000,
            data: frame.data,
          })
          .pipe(
            Effect.catchCause(() =>
              sentRevision === revision ? stop(mediaError("disconnected")) : Effect.void,
            ),
            Effect.ensuring(
              Effect.sync(() => {
                inputInFlight--;
              }),
            ),
          );
      }),
    ),
  );
  yield* fork(
    transport.output.pipe(
      Stream.runForEach((raw) =>
        Effect.gen(function* () {
          const decoded = yield* Effect.try({
            try: () => decodeOutput(raw),
            catch: () => mediaError("invalid-pcm"),
          }).pipe(Effect.option);
          if (Option.isNone(decoded)) {
            rejectedOutput++;
            return;
          }
          const event = decoded.value;
          if (
            closed ||
            event.environmentId !== attachment.environmentId ||
            event.projectId !== attachment.projectId ||
            event.sessionId !== attachment.sessionId ||
            event.attachmentId !== attachment.attachmentId ||
            event.generation !== attachment.generation ||
            (conversation !== undefined &&
              (event.conversation !== conversation || !event.turnId)) ||
            (event.turnId !== undefined &&
              turnId !== undefined &&
              ((event.turnId === turnId && turnEnded) ||
                (event.turnId !== turnId && !turnEnded))) ||
            event.sequence <= outputSequence ||
            event.responseEpoch < attachment.responseEpoch ||
            (event.responseEpoch > attachment.responseEpoch &&
              !(
                event.type === "control" &&
                event.state === "interrupted" &&
                event.responseEpoch === attachment.responseEpoch + 1
              ))
          ) {
            rejectedOutput++;
            return;
          }
          if (event.turnId !== undefined && event.turnId !== turnId) {
            turnId = event.turnId;
            turnEnded = false;
          }
          if (event.type === "turn-end") turnEnded = true;
          if (event.responseEpoch > attachment.responseEpoch) {
            attachment = { ...attachment, responseEpoch: event.responseEpoch };
            onEpoch?.(attachment.responseEpoch);
            yield* clear;
          }
          if (event.type === "pcm") {
            const decodedPcm = yield* Effect.try({
              try: () => decodeDeusPcm(event.data),
              catch: () => mediaError("invalid-pcm"),
            }).pipe(Effect.option);
            if (Option.isNone(decodedPcm)) {
              rejectedOutput++;
              return;
            }
            const bytes = decodedPcm.value;
            outputSequence = event.sequence;
            if (
              !Queue.offerUnsafe(audio, {
                bytes,
                epoch: event.responseEpoch,
                ...(event.conversation !== undefined ? { conversation: event.conversation } : {}),
                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
              })
            )
              return yield* stop(mediaError("backpressure"));
            outputQueued++;
            outputHighWater = Math.max(outputHighWater, outputQueued);
          } else {
            outputSequence = event.sequence;
            if (!Queue.offerUnsafe(events, event)) return yield* stop(mediaError("backpressure"));
            if (
              event.type === "error" ||
              (event.type === "control" && event.state === "disconnected")
            )
              yield* stop();
          }
        }),
      ),
      Effect.andThen(() => stop(mediaError("disconnected"))),
    ),
  );
  yield* fork(
    Effect.forever(
      Effect.sleep(DEUS_CLIENT_MEDIA_LIMITS.renewEveryMs).pipe(
        Effect.andThen(transport.renew),
        Effect.flatMap((renewed) => {
          if (
            renewed.attachmentId !== attachment.attachmentId ||
            renewed.generation !== attachment.generation ||
            renewed.environmentId !== attachment.environmentId ||
            renewed.projectId !== attachment.projectId ||
            renewed.sessionId !== attachment.sessionId
          )
            return stop(mediaError("disconnected"));
          attachment = { ...attachment, expiresAt: renewed.expiresAt };
          return SubscriptionRef.set(expires, Date.parse(renewed.expiresAt));
        }),
      ),
    ),
  );
  yield* fork(
    SubscriptionRef.changes(expires).pipe(
      Stream.switchMap((at) =>
        Stream.fromEffect(
          DateTime.now.pipe(
            Effect.flatMap((now) => Effect.sleep(Math.max(0, at - now.epochMilliseconds))),
            Effect.andThen(() => stop(mediaError("disconnected"))),
          ),
        ),
      ),
      Stream.runDrain,
    ),
  );
  yield* fork(transport.disconnected.pipe(Effect.andThen(() => stop(mediaError("disconnected")))));
  yield* Deferred.await(stopped).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        yield* Effect.forEach(workers, Fiber.interrupt, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* transport.detach.pipe(
          Effect.ignore,
          Effect.raceFirst(transport.disconnected),
          Effect.timeoutOption("1 second"),
        );
        yield* Deferred.succeed(finished, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  const dispose = stop().pipe(Effect.andThen(Deferred.await(finished)));
  yield* Effect.addFinalizer(() => dispose);
  const takeFrame = Queue.take(audio).pipe(
    Effect.flatMap((frame) => {
      outputQueued--;
      return !closed && frame.epoch === attachment.responseEpoch
        ? Effect.succeed(frame)
        : Effect.interrupt;
    }),
  );
  return {
    offer: Effect.fn("DeusMedia.offer")((bytes: Uint8Array) =>
      Effect.sync(() => {
        if (
          closed ||
          muted ||
          controlBusy ||
          bytes.byteLength === 0 ||
          bytes.byteLength > DEUS_MAX_PCM_BYTES ||
          bytes.byteLength % 2 !== 0
        ) {
          droppedInput++;
          return false;
        }
        const accepted = Queue.offerUnsafe(pending, { data: Base64.encode(bytes), revision });
        if (accepted) {
          inputQueued++;
          inputHighWater = Math.max(inputHighWater, inputQueued);
        } else droppedInput++;
        return accepted;
      }),
    ),
    control: Effect.fn("DeusMedia.control")(function* (action: DeusMediaControlInput["action"]) {
      if (closed || controlBusy) return false;
      controlBusy = true;
      const input = { ...attachment, sequence: sequence++, action };
      yield* clear;
      if (action === "mute") muted = true;
      if (action === "interrupt-response") {
        attachment = { ...attachment, responseEpoch: attachment.responseEpoch + 1 };
        onEpoch?.(attachment.responseEpoch);
      }
      return yield* transport.control(input).pipe(
        Effect.as(true),
        Effect.tap(() =>
          Effect.sync(() => {
            if (action === "resume") muted = false;
          }),
        ),
        Effect.catchCause(() => stop(mediaError("disconnected")).pipe(Effect.as(false))),
        Effect.ensuring(
          Effect.sync(() => {
            controlBusy = false;
          }),
        ),
      );
    }),
    takeFrame,
    takeAudio: takeFrame.pipe(Effect.map((frame) => frame.bytes)),
    events,
    closed: Deferred.await(finished),
    dispose,
    stats: () => ({
      closed,
      muted,
      responseEpoch: attachment.responseEpoch,
      inputQueued,
      outputQueued,
      inputInFlight,
      maxInputInFlight,
      inputHighWater,
      outputHighWater,
      droppedInput,
      rejectedOutput,
    }),
  };
});
