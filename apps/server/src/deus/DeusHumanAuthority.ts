import {
  AuthOrchestrationOperateScope,
  type DeusInputId,
  type DeusSessionRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Repository from "./DeusRepository.ts";
import {
  DeusActionSource,
  DeusAuthorityError,
  type DeusAuthority,
  type DeusAuthorityRef,
} from "./DeusAuthority.ts";

export const DEUS_MAX_ACTIVE_BINDINGS = 128;
export type HumanCeiling = Effect.Success<ReturnType<DeusAuthority["Service"]["authorize"]>>;
export type HumanInput = DeusSessionRef & { readonly inputId: DeusInputId };
export interface HumanConnection {
  readonly id: string;
  readonly scope: Scope.Closeable;
  readonly check: (ref: DeusSessionRef) => Effect.Effect<void, DeusAuthorityError>;
  readonly release: (input: HumanInput) => Effect.Effect<void>;
  readonly bind: (
    input: HumanInput,
    ceiling: HumanCeiling,
    lifetime?: Scope.Scope,
  ) => Effect.Effect<void, DeusAuthorityError>;
}
export class DeusHumanAuthority extends Context.Service<
  DeusHumanAuthority,
  {
    readonly connect: (
      principal: AuthenticatedSession,
    ) => Effect.Effect<HumanConnection, DeusAuthorityError, Scope.Scope>;
    readonly authorize: DeusAuthority["Service"]["authorize"];
  }
>()("t3/deus/DeusHumanAuthority") {}
const inactive = () => new DeusAuthorityError({ reason: "inactive" });
const ranks = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };
const key = (ref: HumanInput) =>
  JSON.stringify([ref.environmentId, ref.projectId, ref.sessionId, ref.inputId]);
interface ConnectionState {
  readonly id: string;
  readonly principal: AuthenticatedSession;
  active: boolean;
}
interface Binding {
  readonly input: HumanInput;
  readonly connection: ConnectionState;
  readonly ceiling: HumanCeiling;
  readonly alive: { current: boolean };
  readonly scope: Scope.Closeable;
  readonly keys: Set<string>;
}
const make = Effect.gen(function* () {
  const repository = yield* Repository.DeusRepository;
  const sessions = yield* Sessions.SessionStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const lane = yield* Semaphore.make(1);
  const serviceScope = yield* Scope.Scope;
  const bindings = new Map<string, Binding>();
  const claim = Effect.fn("DeusHumanAuthority.claim")(function* (input: HumanInput) {
    const rows =
      yield* sql`INSERT INTO deus_authority_claims (environment_id, project_id, input_id, session_id)
      VALUES (${input.environmentId}, ${input.projectId}, ${input.inputId}, ${input.sessionId})
      ON CONFLICT DO NOTHING RETURNING input_id`.pipe(Effect.mapError(inactive));
    if (!rows.length) return yield* inactive();
  });
  const validate = Effect.fn("DeusHumanAuthority.validate")(function* (
    connection: ConnectionState,
    operate = true,
  ) {
    const now = (yield* DateTime.now).epochMilliseconds;
    const original = connection.principal;
    if (
      !connection.active ||
      original.subject === "mcp-client" ||
      (operate && !original.scopes.includes(AuthOrchestrationOperateScope)) ||
      (original.expiresAt && DateTime.toEpochMillis(original.expiresAt) <= now)
    )
      return yield* inactive();
    const stored = yield* authSessions
      .getById({ sessionId: original.sessionId })
      .pipe(Effect.mapError(inactive));
    if (
      Option.isNone(stored) ||
      stored.value.subject !== original.subject ||
      stored.value.method !== original.method ||
      stored.value.revokedAt !== null ||
      stored.value.expiresAt.epochMilliseconds <= now ||
      (operate && !stored.value.scopes.includes(AuthOrchestrationOperateScope))
    )
      return yield* inactive();
  });
  const authorize = Effect.fn("DeusHumanAuthority.authorize")(function* (ref: DeusAuthorityRef) {
    const source = yield* DeusActionSource;
    const direct = ref.inputId ? bindings.get(key({ ...ref, inputId: ref.inputId })) : undefined;
    const inherited = source?.inputId
      ? bindings.get(key({ ...source, inputId: source.inputId }))
      : undefined;
    if (
      (source?.inputId && !inherited) ||
      (direct && inherited && direct.alive !== inherited.alive)
    )
      return yield* inactive();
    const binding = inherited ?? direct;
    if (
      !binding ||
      !binding.alive.current ||
      binding.input.environmentId !== ref.environmentId ||
      binding.input.projectId !== ref.projectId ||
      binding.input.sessionId !== ref.sessionId
    )
      return yield* inactive();
    yield* validate(binding.connection);
    yield* repository.snapshot(ref).pipe(Effect.mapError(inactive));
    if (!binding.alive.current || !binding.connection.active) return yield* inactive();
    if (ref.inputId && !direct) {
      if (bindings.size >= DEUS_MAX_ACTIVE_BINDINGS)
        return yield* new DeusAuthorityError({ reason: "capacity" });
      const input = { ...ref, inputId: ref.inputId };
      yield* claim(input);
      if (!binding.alive.current || !binding.connection.active) return yield* inactive();
      binding.keys.add(key(input));
      bindings.set(key(input), { ...binding, input });
    }
    return { ...binding.ceiling };
  }, lane.withPermits(1));
  return DeusHumanAuthority.of({
    authorize,
    connect: Effect.fn("DeusHumanAuthority.connect")(function* (principal) {
      const connection: ConnectionState = {
        id: yield* crypto.randomUUIDv4().pipe(Effect.mapError(inactive)),
        principal: { ...principal, scopes: [...principal.scopes] },
        active: true,
      };
      yield* validate(connection, false);
      const scope = yield* Scope.fork(yield* Scope.Scope);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          connection.active = false;
        }),
      );
      yield* sessions
        .awaitInvalidation(principal.sessionId)
        .pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(scope, Exit.void).pipe(Effect.forkIn(serviceScope))),
          Effect.forkIn(scope),
        );
      return {
        id: connection.id,
        scope,
        check: Effect.fn("DeusHumanAuthority.check")(function* (ref) {
          yield* validate(connection);
          yield* repository.snapshot(ref).pipe(Effect.mapError(inactive));
        }),
        release: Effect.fn("DeusHumanAuthority.release")(function* (input) {
          const binding = bindings.get(key(input));
          if (binding?.connection === connection) yield* Scope.close(binding.scope, Exit.void);
        }),
        bind: Effect.fn("DeusHumanAuthority.bind")(function (input, ceiling, lifetime) {
          return Effect.gen(function* () {
            yield* validate(connection);
            yield* repository.snapshot(input).pipe(Effect.mapError(inactive));
            if (ranks[ceiling.runtimeMode] > ranks[principal.runtimeModeCeiling ?? "full-access"])
              return yield* new DeusAuthorityError({ reason: "mode-limit" });
            const existing = bindings.get(key(input));
            if (existing) {
              if (
                !existing.alive.current ||
                existing.connection !== connection ||
                existing.ceiling.runtimeMode !== ceiling.runtimeMode ||
                existing.ceiling.interactionMode !== ceiling.interactionMode ||
                existing.ceiling.allowWorktree !== ceiling.allowWorktree
              )
                return yield* inactive();
              return;
            }
            if (bindings.size >= DEUS_MAX_ACTIVE_BINDINGS)
              return yield* new DeusAuthorityError({ reason: "capacity" });
            const persisted =
              yield* sql`SELECT 1 FROM deus_receipts WHERE environment_id = ${input.environmentId} AND project_id = ${input.projectId} AND input_id = ${input.inputId} LIMIT 1`.pipe(
                Effect.mapError(inactive),
              );
            if (persisted.length) return yield* inactive();
            yield* claim(input);
            const alive = { current: true };
            const keys = new Set([key(input)]);
            const bindingScope = yield* Scope.fork(lifetime ?? scope);
            yield* Scope.addFinalizer(
              bindingScope,
              Effect.sync(() => {
                alive.current = false;
                for (const bindingKey of keys) bindings.delete(bindingKey);
                keys.clear();
              }),
            );
            if (!alive.current || !connection.active) return yield* inactive();
            bindings.set(key(input), {
              input: { ...input },
              connection,
              ceiling: { ...ceiling },
              alive,
              scope: bindingScope,
              keys,
            });
          }).pipe(lane.withPermits(1));
        }),
      };
    }),
  });
});
export const layer = Layer.effect(DeusHumanAuthority, make);
