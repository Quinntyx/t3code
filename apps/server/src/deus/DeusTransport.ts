// @effect-diagnostics nodeBuiltinImport:off -- SEA Live process ownership is not release-verified.
import * as NodeSea from "node:sea";
import {
  AuthOrchestrationOperateScope,
  DEUS_PROTOCOL_VERSION,
  DeusError,
  DeusMemoryId,
  DeusModelError,
  DeusPermissionError,
  DeusRpcGroup,
  DeusTransportError,
  DeusUnavailableError,
  WS_METHODS,
  type DeusCapabilities,
  type DeusAttachmentInput,
  type DeusMediaOutput,
  type DeusMemory,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Authority from "./DeusAuthority.ts";
import * as Human from "./DeusHumanAuthority.ts";
import * as Lease from "./DeusMediaLease.ts";
import * as Sessions from "./DeusSessionService.ts";
import * as Repository from "./DeusRepository.ts";
import * as Coordinator from "./DeusCoordinator.ts";
import * as Bridge from "./DeusThreadBridge.ts";
import * as Tools from "./DeusTools.ts";
import * as Configuration from "./DeusConfiguration.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Ponder from "./DeusPonderService.ts";
import * as Live from "./DeusLiveService.ts";
import { DeusLiveError } from "./GeminiLiveAdapter.ts";
import { DeusTextError } from "./textProtocol.ts";
import { preview } from "./contextBounds.ts";

const unavailable = (reason: DeusUnavailableError["reason"] = "unsupported") =>
  new DeusUnavailableError({
    reason,
    message: "This Deus operation is disabled, unconfigured or unavailable on this runtime.",
  });
const permission = () =>
  new DeusPermissionError({
    message: "A current authenticated human action within its original grant is required.",
    requiredScope: AuthOrchestrationOperateScope,
  });
const isPublic = Schema.is(DeusError);
const isLive = Schema.is(DeusLiveError);
const isText = Schema.is(DeusTextError);
const isAuthority = Schema.is(Authority.DeusAuthorityError);
const publicDeusError = (error: unknown): DeusError => {
  if (isPublic(error)) return error;
  if (isAuthority(error))
    return error.reason === "capacity"
      ? new DeusTransportError({
          reason: "backpressure",
          message:
            "Too many active human actions. Complete or detach an active action before retrying.",
        })
      : permission();
  if (isLive(error)) {
    if (error.code === "authority") return permission();
    if (error.code === "configuration") return unavailable("not-configured");
    if (error.code === "bounds" || error.code === "stale" || error.code === "backpressure")
      return new DeusTransportError({
        reason:
          error.code === "bounds"
            ? "invalid-pcm"
            : error.code === "stale"
              ? "stale-response"
              : "backpressure",
        message:
          "Media is invalid, stale or saturated; reconnect explicitly. Workers are preserved.",
      });
  }
  if (isText(error) && error.code === "configuration") return unavailable("not-configured");
  return new DeusModelError({
    reason: "provider-failure",
    message: "Deus could not complete this operation. Accepted work is preserved.",
  });
};
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(publicDeusError));
const memoryResult = (entry: Memory.MemoryEntry, bounded: boolean): DeusMemory => ({
  id: DeusMemoryId.make(entry.id),
  revision: entry.revision,
  text: bounded ? preview(entry.text).text : entry.text,
  observationIds: entry.observationIds,
  ponderId: null,
  supersedes: entry.supersedes === null ? null : DeusMemoryId.make(entry.supersedes),
  removedAt: null,
  updatedAt: entry.updatedAt,
  provenance: { scope: entry.scope, sources: entry.sources, commit: entry.commit },
});
interface MediaState {
  readonly ready: Deferred.Deferred<void, DeusError>;
  sequence: number;
  sending: boolean;
  subscribed: boolean;
}
const make = Effect.gen(function* () {
  const human = yield* Human.DeusHumanAuthority;
  const leases = yield* Lease.DeusMediaLease;
  const sessions = yield* Sessions.DeusSessionService;
  const repository = yield* Repository.DeusRepository;
  const coordinator = yield* Coordinator.DeusCoordinator;
  const bridge = yield* Bridge.DeusThreadBridge;
  const configuration = yield* Configuration.DeusConfiguration;
  const memory = yield* Memory.DeusMemoryService;
  const ponder = yield* Ponder.DeusPonderService;
  const live = yield* Live.DeusLiveService;
  const secrets = yield* Secrets.SecretRequests;
  const tools = yield* Tools.DeusTools;
  const capabilities = configuration.status.pipe(
    Effect.map(({ settings, credentialPresent }): DeusCapabilities => {
      if (!settings.enabled)
        return { available: false, protocolVersion: DEUS_PROTOCOL_VERSION, reason: "disabled" };
      if (!settings.textModel || !credentialPresent)
        return {
          available: false,
          protocolVersion: DEUS_PROTOCOL_VERSION,
          reason: "not-configured",
        };
      return {
        available: true,
        protocolVersion: DEUS_PROTOCOL_VERSION,
        text: true,
        liveAudio: Boolean(settings.liveModel && settings.voice && !NodeSea.isSea()),
        learning: true,
        reportModes: ["SILENT", "WHEN_IDLE", "INTERRUPT"],
      };
    }),
    Effect.mapError(publicDeusError),
  );
  return {
    capabilities,
    connect: Effect.fn("DeusTransport.connect")(function* (principal: AuthenticatedSession) {
      const connection = yield* human.connect(principal).pipe(Effect.mapError(publicDeusError));
      const media = new Map<string, MediaState>();
      const owned = Effect.fn("DeusTransport.owned")(function* (ref: DeusAttachmentInput) {
        const lease = yield* leases.owner(connection, ref);
        const state = media.get(lease.attachment.attachmentId);
        if (!state)
          return yield* new DeusTransportError({
            reason: "disconnected",
            message: "This connection has no live media consumer.",
          });
        return { lease, state };
      });
      const settings = Effect.fn("DeusTransport.settings")(function* (
        input: Parameters<typeof repository.validateScope>[0],
      ) {
        yield* repository.validateScope(input);
        const status = yield* configuration.status;
        return {
          ...input,
          settings: status.settings,
          credentialConfigured: status.credentialPresent,
        };
      });
      return DeusRpcGroup.of({
        [WS_METHODS.deusGetCapabilities]: (input) =>
          run(repository.validateScope(input).pipe(Effect.andThen(capabilities))),
        [WS_METHODS.deusOpen]: (input) => run(sessions.open(input)),
        [WS_METHODS.deusGetSnapshot]: (input) => run(sessions.snapshot(input)),
        [WS_METHODS.deusSubscribe]: (input) =>
          Stream.unwrap(sessions.subscribe(input)).pipe(Stream.mapError(publicDeusError)),
        [WS_METHODS.deusSendInput]: ({ authority, ...input }) =>
          run(
            Effect.gen(function* () {
              const available = yield* capabilities;
              if (!available.available) return yield* unavailable(available.reason);
              yield* connection.bind(input, authority);
              return yield* coordinator
                .submit(input)
                .pipe(Effect.ensuring(connection.release(input)));
            }),
          ),
        [WS_METHODS.deusResetConversation]: (input) =>
          run(
            Effect.gen(function* () {
              yield* connection.check(input);
              yield* sessions.resetConversation(input);
              return yield* sessions.snapshot(input);
            }),
          ),
        [WS_METHODS.deusLaunchTask]: ({ authority, ...input }) =>
          run(
            Effect.gen(function* () {
              yield* connection.bind(input, authority);
              const task = yield* bridge
                .launch(input)
                .pipe(Effect.ensuring(connection.release(input)));
              const snapshot = yield* sessions.snapshot(input);
              return {
                task,
                receipt: {
                  inputId: input.inputId,
                  cursor: snapshot.cursor,
                  status: "accepted" as const,
                },
                answer: null,
              };
            }),
          ),
        [WS_METHODS.deusTaskAction]: ({ authority, ...input }) =>
          run(
            Effect.gen(function* () {
              yield* connection.check(input);
              return yield* tools.taskAction(input, authority, connection);
            }).pipe(Effect.provideService(Authority.DeusActionSource, input)),
          ),
        [WS_METHODS.deusMemorySearch]: (input) =>
          run(
            Effect.gen(function* () {
              const page = yield* memory.search(input);
              return yield* Effect.forEach(page.items, (item) =>
                memory
                  .read({ ...input, scope: item.scope, id: item.id, revision: item.revision })
                  .pipe(Effect.map((entry) => memoryResult(entry, true))),
              );
            }),
          ),
        [WS_METHODS.deusMemoryRead]: (input) =>
          run(
            memory
              .read({ ...input, id: input.memoryId, scope: input.scope ?? "project" })
              .pipe(Effect.map((entry) => memoryResult(entry, false))),
          ),
        [WS_METHODS.deusMemoryCorrect]: () => Effect.fail(unavailable()),
        [WS_METHODS.deusPonder]: (input) => run(ponder.runNow(input)),
        [WS_METHODS.deusGetLearning]: (input) => run(ponder.status(input)),
        [WS_METHODS.deusConfigureLearning]: (input) => run(ponder.configure(input)),
        [WS_METHODS.deusAttach]: ({ authority, ...input }) =>
          run(
            Effect.gen(function* () {
              const available = yield* capabilities;
              if (!available.available) return yield* unavailable(available.reason);
              if (!available.liveAudio)
                return yield* unavailable(NodeSea.isSea() ? "unsupported" : "not-configured");
              const lease = yield* leases.acquire(connection, input, authority);
              let state = media.get(lease.attachment.attachmentId);
              if (!state) {
                state = {
                  ready: yield* Deferred.make<void, DeusError>(),
                  sequence: 0,
                  sending: false,
                  subscribed: false,
                };
                media.set(lease.attachment.attachmentId, state);
                const snapshot = yield* sessions.snapshot(input);
                yield* Scope.addFinalizer(
                  lease.scope,
                  live.detach(lease.attachment).pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.sync(() => {
                        media.delete(lease.attachment.attachmentId);
                      }),
                    ),
                  ),
                );
                yield* Deferred.complete(
                  state.ready,
                  run(live.attach(lease.attachment, snapshot.cursor)),
                ).pipe(Effect.forkIn(lease.scope));
              }
              yield* Deferred.await(state.ready).pipe(
                Effect.onError(() =>
                  leases.release(connection, lease.attachment).pipe(Effect.ignore),
                ),
              );
              yield* leases.owner(connection, lease.attachment);
              return lease.attachment;
            }),
          ),
        [WS_METHODS.deusDetach]: (input) => run(leases.release(connection, input)),
        [WS_METHODS.deusRenew]: (input) => run(leases.renew(connection, input)),
        [WS_METHODS.deusMediaPush]: (input) =>
          run(
            Effect.gen(function* () {
              if ("_tag" in input) return yield* input;
              const { state } = yield* owned(input);
              if (state.sending)
                return yield* new DeusTransportError({
                  reason: "backpressure",
                  message: "One PCM batch is already in flight. Stop capture or reconnect.",
                });
              state.sending = true;
              yield* live.input(input).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    state.sending = false;
                  }),
                ),
              );
            }),
          ),
        [WS_METHODS.deusMediaControl]: (input) =>
          run(owned(input).pipe(Effect.andThen(live.control(input)))),
        [WS_METHODS.deusMediaSubscribe]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const { lease, state } = yield* owned(input);
              if (state.subscribed)
                return yield* new DeusTransportError({
                  reason: "backpressure",
                  message: "This attachment already has an output consumer.",
                });
              state.subscribed = true;
              yield* Effect.addFinalizer(() =>
                leases.release(connection, lease.attachment).pipe(Effect.ignore),
              );
              return Stream.fromEffectRepeat(
                Effect.gen(function* () {
                  yield* leases.owner(connection, input);
                  const output = yield* live.next(input);
                  yield* leases.owner(connection, input);
                  const envelope = {
                    ...output.attachment,
                    conversation: output.conversation,
                    turnId: output.turnId,
                    sequence: state.sequence++,
                  };
                  const event: DeusMediaOutput =
                    output.type === "media"
                      ? { ...output.media, ...envelope }
                      : output.type === "turn-end"
                        ? { ...envelope, type: "turn-end" }
                        : { ...envelope, type: "error", error: publicDeusError(output.error) };
                  return event;
                }),
              ).pipe(
                Stream.rechunk(1),
                Stream.takeUntil((event) => event.type === "error"),
              );
            }),
          ).pipe(Stream.mapError(publicDeusError)),
        [WS_METHODS.deusGetSettings]: (input) => run(settings(input)),
        [WS_METHODS.deusUpdateSettings]: (input) =>
          run(
            repository
              .validateScope(input)
              .pipe(
                Effect.andThen(configuration.update(input.patch)),
                Effect.andThen(settings(input)),
              ),
          ),
        [WS_METHODS.deusSetCredential]: (input) =>
          run(
            repository
              .validateScope(input)
              .pipe(
                Effect.andThen(
                  input.secretRef === null
                    ? configuration.removeCredential
                    : configuration
                        .setCredential({ secretRef: input.secretRef, projectId: input.projectId })
                        .pipe(Effect.provideService(Secrets.SecretRequests, secrets)),
                ),
                Effect.andThen(settings(input)),
              ),
          ),
      });
    }),
  };
});
export class DeusTransport extends Context.Service<DeusTransport, Effect.Success<typeof make>>()(
  "t3/deus/DeusTransport",
) {}
export const layer = Layer.effect(DeusTransport, make);
