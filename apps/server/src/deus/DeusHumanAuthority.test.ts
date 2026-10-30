import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  DeusInputId,
  EventId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Lease from "./DeusMediaLease.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { DeusActionSource } from "./DeusAuthority.ts";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Repository from "./DeusRepository.ts";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Human from "./DeusHumanAuthority.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";

const environmentId = EnvironmentId.make("authority-fixture");
const projectId = ProjectId.make("project");
const open = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Authority fixture','/test/authority','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  const repository = yield* Repository.DeusRepository;
  const snapshot = yield* repository.open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  });
  return { ...snapshot.session, inputId: DeusInputId.make("human") };
});
const ceiling: Human.HumanCeiling = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
  allowWorktree: false,
};
const base = Lease.layer.pipe(
  Layer.provideMerge(Human.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(ApplicationEvents.layer),
  Layer.provideMerge(Sessions.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-authority-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const principal = Effect.gen(function* () {
  const sessions = yield* Sessions.SessionStore;
  const issued = yield* sessions.issue({
    subject: "human",
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
    runtimeModeCeiling: "auto",
  });
  return yield* sessions.verify(issued.token);
});

const finalizerCount = (scope: Scope.Scope) =>
  scope.state._tag === "Open"
    ? (scope.state.finalizers?.size ?? (scope.state.finalizer ? 1 : 0))
    : 0;

for (const derived of [false, true]) {
  it.effect(
    `does not install a grant after its connection closes during ${derived ? "derivation" : "binding"}`,
    () =>
      Effect.gen(function* () {
        const ref = yield* open;
        const authenticated = yield* principal;
        const repository = yield* Repository.DeusRepository;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let paused = false;
        yield* Effect.gen(function* () {
          const human = yield* Human.DeusHumanAuthority;
          const connection = yield* human.connect(authenticated);
          if (derived) yield* connection.bind(ref, ceiling);
          paused = true;
          const input = derived ? { ...ref, inputId: DeusInputId.make("closing-derived") } : ref;
          const binding = yield* (
            derived
              ? human.authorize(input).pipe(Effect.provideService(DeusActionSource, ref))
              : connection.bind(input, ceiling)
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Scope.close(connection.scope, Exit.void);
          yield* Deferred.succeed(resume, undefined);
          expect(Exit.isFailure(yield* Fiber.await(binding))).toBe(true);
          expect((yield* Fiber.join(binding).pipe(Effect.flip)).reason).toBe("inactive");
          expect((yield* human.authorize(input).pipe(Effect.flip)).reason).toBe("inactive");
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.fresh(Human.layer)),
          Effect.provideService(Repository.DeusRepository, {
            ...repository,
            snapshot: (input) =>
              paused
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(repository.snapshot(input)),
                  )
                : repository.snapshot(input),
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(base)),
  );
}

it.effect("reclaims completed root and derived grants beyond the historical binding cap", () =>
  Effect.gen(function* () {
    const human = yield* Human.DeusHumanAuthority;
    const ref = yield* open;
    const authenticated = yield* principal;
    const connection = yield* human.connect(authenticated);
    const baseline = finalizerCount(connection.scope);
    for (let index = 0; index < 2050; index++) {
      const lifetime = yield* Scope.fork(connection.scope);
      const input = { ...ref, inputId: DeusInputId.make(`completed:${index}`) };
      const derived = { ...ref, inputId: DeusInputId.make(`derived:${index}`) };
      yield* connection.bind(input, ceiling, lifetime);
      expect(
        yield* human.authorize(derived).pipe(Effect.provideService(DeusActionSource, input)),
      ).toEqual(ceiling);
      yield* Scope.close(lifetime, Exit.void);
      expect((yield* human.authorize(derived).pipe(Effect.flip)).reason).toBe("inactive");
    }
    expect(finalizerCount(connection.scope)).toBe(baseline);
    const second = yield* human.connect(authenticated);
    const old = { ...ref, inputId: DeusInputId.make("completed:0") };
    expect(
      (yield* second.bind(old, { ...ceiling, runtimeMode: "auto" }).pipe(Effect.flip)).reason,
    ).toBe("inactive");
    const fresh = { ...ref, inputId: DeusInputId.make("fresh-broader") };
    const resume = yield* Deferred.make<void>();
    const delayed = yield* Deferred.await(resume).pipe(
      Effect.andThen(human.authorize(fresh)),
      Effect.provideService(DeusActionSource, old),
      Effect.forkScoped,
    );
    yield* second.bind(fresh, { ...ceiling, runtimeMode: "auto" });
    yield* Deferred.succeed(resume, undefined);
    expect((yield* Fiber.join(delayed).pipe(Effect.flip)).reason).toBe("inactive");
    const restarted = yield* Human.DeusHumanAuthority.pipe(
      Effect.provide(Layer.fresh(Human.layer)),
    );
    const afterRestart = yield* restarted.connect(authenticated);
    expect((yield* afterRestart.bind(old, ceiling).pipe(Effect.flip)).reason).toBe("inactive");
    yield* Effect.logInfo(
      "authority lifecycle: 2050 completed roots + 2050 derived grants reclaimed; no owner finalizers; consumed IDs denied across reconnect/restart",
    );
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("bounds only concurrent grants and reclaims repeated closed connections", () =>
  Effect.gen(function* () {
    const human = yield* Human.DeusHumanAuthority;
    const ref = yield* open;
    const authenticated = yield* principal;
    const connection = yield* human.connect(authenticated);
    for (let index = 0; index < Human.DEUS_MAX_ACTIVE_BINDINGS; index++)
      yield* connection.bind({ ...ref, inputId: DeusInputId.make(`active:${index}`) }, ceiling);
    expect(
      (yield* connection
        .bind({ ...ref, inputId: DeusInputId.make("saturated") }, ceiling)
        .pipe(Effect.flip)).reason,
    ).toBe("capacity");
    yield* connection.release({ ...ref, inputId: DeusInputId.make("active:0") });
    yield* connection.bind({ ...ref, inputId: DeusInputId.make("capacity-reclaimed") }, ceiling);
    yield* Scope.close(connection.scope, Exit.void);
    const owner = yield* Scope.Scope;
    const baseline = finalizerCount(owner);
    for (let index = 0; index < 2050; index++) {
      const next = yield* human.connect(authenticated);
      const input = { ...ref, inputId: DeusInputId.make(`connection:${index}`) };
      yield* next.bind(input, ceiling);
      yield* human
        .authorize({ ...ref, inputId: DeusInputId.make(`connection-derived:${index}`) })
        .pipe(Effect.provideService(DeusActionSource, input));
      yield* Scope.close(next.scope, Exit.void);
    }
    expect(finalizerCount(owner)).toBe(baseline);
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("reclaims more than 4096 released attachment requests on one connection", () =>
  Effect.gen(function* () {
    const human = yield* Human.DeusHumanAuthority;
    const leases = yield* Lease.DeusMediaLease;
    const ref = yield* open;
    const connection = yield* human.connect(yield* principal);
    const baseline = finalizerCount(connection.scope);
    let generation = 0;
    for (let index = 0; index < 4100; index++) {
      const input = { ...ref, inputId: DeusInputId.make(`attachment:${index}`), takeover: false };
      const lease = yield* leases.acquire(connection, input, ceiling);
      expect(lease.attachment.generation).toBeGreaterThan(generation);
      generation = lease.attachment.generation;
      yield* leases.release(connection, lease.attachment);
    }
    expect(finalizerCount(connection.scope)).toBe(baseline);
    expect(
      (yield* leases
        .acquire(
          connection,
          {
            ...ref,
            inputId: DeusInputId.make("attachment:0"),
            takeover: false,
          },
          ceiling,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("stale-generation");
    yield* Effect.logInfo(
      "media lifecycle: 4100 attach/detach cycles; zero retained owner finalizers; original request cannot reopen",
    );
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("authorizes only an authenticated original human action, not a session or receipt", () =>
  Effect.gen(function* () {
    const human = yield* Human.DeusHumanAuthority;
    const ref = yield* open;
    const connection = yield* human.connect(yield* principal);
    expect((yield* human.authorize(ref).pipe(Effect.flip)).reason).toBe("inactive");
    yield* connection.bind(ref, ceiling);
    expect(yield* human.authorize(ref)).toEqual(ceiling);
    expect(
      (yield* human
        .authorize({ ...ref, inputId: DeusInputId.make("persisted-only") })
        .pipe(Effect.flip)).reason,
    ).toBe("inactive");
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "leases contend across connections sharing a principal, renew, take over and release without reviving stale owners",
  () =>
    Effect.gen(function* () {
      const ref = yield* open;
      const human = yield* Human.DeusHumanAuthority;
      const leases = yield* Lease.DeusMediaLease;
      const authenticated = yield* principal;
      const first = yield* human.connect(authenticated);
      const second = yield* human.connect(authenticated);
      expect(first.id).not.toBe(second.id);
      const request = { ...ref, takeover: false };
      const lease = yield* leases.acquire(first, request, ceiling);
      expect((yield* leases.acquire(first, request, ceiling)).attachment).toEqual(lease.attachment);
      expect(
        (yield* leases
          .acquire(second, { ...request, inputId: DeusInputId.make("contender") }, ceiling)
          .pipe(Effect.flip)).reason,
      ).toBe("occupied");
      expect((yield* leases.owner(second, lease.attachment).pipe(Effect.flip)).reason).toBe(
        "not-owner",
      );
      const renewed = yield* leases.renew(first, lease.attachment);
      expect(renewed.generation).toBe(lease.attachment.generation);
      const ended = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(
        lease.scope,
        Deferred.succeed(ended, undefined).pipe(Effect.asVoid),
      );
      const replacement = yield* leases.acquire(
        second,
        { ...request, inputId: DeusInputId.make("takeover"), takeover: true },
        ceiling,
      );
      yield* Deferred.await(ended);
      expect(replacement.attachment.generation).toBeGreaterThan(lease.attachment.generation);
      expect((yield* leases.release(first, lease.attachment).pipe(Effect.flip)).reason).toBe(
        "stale-generation",
      );
      expect((yield* human.authorize(ref).pipe(Effect.flip)).reason).toBe("inactive");
      expect((yield* leases.owner(second, replacement.attachment)).attachment).toEqual(
        replacement.attachment,
      );
      yield* leases.release(second, replacement.attachment);
      expect((yield* leases.owner(second, replacement.attachment).pipe(Effect.flip)).reason).toBe(
        "expired",
      );
      expect(
        (yield* leases
          .acquire(
            second,
            { ...request, inputId: DeusInputId.make("takeover"), takeover: true },
            ceiling,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("stale-generation");
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "renewal extends one lease and expiry closes a never-ready acquisition and its original grants",
  () =>
    Effect.gen(function* () {
      const ref = yield* open;
      const human = yield* Human.DeusHumanAuthority;
      const leases = yield* Lease.DeusMediaLease;
      const connection = yield* human.connect(yield* principal);
      const lease = yield* leases.acquire(connection, { ...ref, takeover: false }, ceiling);
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const pending = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
        Effect.forkIn(lease.scope),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Lease.DEUS_LEASE_MS - 1);
      const renewed = yield* leases.renew(connection, lease.attachment);
      expect(renewed.expiresAt > lease.attachment.expiresAt).toBe(true);
      yield* TestClock.adjust(1);
      yield* leases.owner(connection, renewed);
      yield* TestClock.adjust(Lease.DEUS_LEASE_MS);
      yield* Deferred.await(stopped);
      yield* Fiber.await(pending);
      expect((yield* leases.owner(connection, renewed).pipe(Effect.flip)).reason).toBe("expired");
      expect((yield* human.authorize(ref).pipe(Effect.flip)).reason).toBe("inactive");
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "destination revocation and original ceilings are rechecked for delayed derived actions",
  () =>
    Effect.gen(function* () {
      const ref = yield* open;
      const human = yield* Human.DeusHumanAuthority;
      const authenticated = yield* principal;
      const connection = yield* human.connect(authenticated);
      yield* connection.bind(ref, ceiling);
      const child = { ...ref, inputId: DeusInputId.make("derived-tool") };
      expect(
        yield* human.authorize(child).pipe(Effect.provideService(DeusActionSource, ref)),
      ).toEqual(ceiling);
      expect(
        (yield* connection
          .bind(
            { ...ref, inputId: DeusInputId.make("over-limit") },
            { ...ceiling, runtimeMode: "full-access" },
          )
          .pipe(Effect.flip)).reason,
      ).toBe("mode-limit");
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.revoke({
        sessionId: authenticated.sessionId,
        revokedAt: yield* DateTime.now,
      });
      expect((yield* human.authorize(child).pipe(Effect.flip)).reason).toBe("inactive");
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "project deletion closes an idle attachment without waiting for another media request",
  () =>
    Effect.gen(function* () {
      const ref = yield* open;
      const human = yield* Human.DeusHumanAuthority;
      const leases = yield* Lease.DeusMediaLease;
      const connection = yield* human.connect(yield* principal);
      const lease = yield* leases.acquire(connection, { ...ref, takeover: false }, ceiling);
      const ended = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(
        lease.scope,
        Deferred.succeed(ended, undefined).pipe(Effect.asVoid),
      );
      const sql = yield* SqlClient.SqlClient;
      const deletedAt = IsoDateTime.make("2026-01-01T00:00:01.000Z");
      yield* sql`UPDATE projection_projects SET deleted_at = ${deletedAt} WHERE project_id = ${projectId}`;
      const events = yield* ApplicationEvents.OrchestrationEventStore;
      const event = yield* events.appendProjectEvent({
        eventId: EventId.make("delete-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.deleted",
        occurredAt: deletedAt,
        commandId: null,
        correlationId: null,
        causationEventId: null,
        metadata: {},
        payload: { projectId, deletedAt },
      });
      yield* events.publishCommitted([event]);
      yield* Deferred.await(ended);
      expect((yield* leases.validate(lease.attachment).pipe(Effect.flip)).reason).toBe("expired");
    }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect("a derived action cannot borrow another input's broader authority", () =>
  Effect.gen(function* () {
    const human = yield* Human.DeusHumanAuthority;
    const ref = yield* open;
    const connection = yield* human.connect(yield* principal);
    yield* connection.bind(ref, ceiling);
    const broader = { ...ref, inputId: DeusInputId.make("different-human-input") };
    yield* connection.bind(broader, {
      runtimeMode: "auto",
      interactionMode: "default",
      allowWorktree: true,
    });
    expect(
      (yield* human
        .authorize(broader)
        .pipe(Effect.provideService(DeusActionSource, ref), Effect.flip)).reason,
    ).toBe("inactive");
  }).pipe(Effect.scoped, Effect.provide(base)),
);

it.effect(
  "disconnect revokes old work and another connection cannot upgrade or replay its grant",
  () =>
    Effect.gen(function* () {
      const human = yield* Human.DeusHumanAuthority;
      const ref = yield* open;
      const authenticated = yield* principal;
      const firstScope = yield* Scope.make();
      const first = yield* human
        .connect(authenticated)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* first.bind(ref, ceiling);
      const second = yield* human.connect(authenticated);
      expect(
        (yield* second.bind(ref, { ...ceiling, runtimeMode: "auto" }).pipe(Effect.flip)).reason,
      ).toBe("inactive");
      yield* Scope.close(firstScope, Exit.void);
      expect((yield* human.authorize(ref).pipe(Effect.flip)).reason).toBe("inactive");
      expect((yield* second.bind(ref, ceiling).pipe(Effect.flip)).reason).toBe("inactive");
    }).pipe(Effect.scoped, Effect.provide(base)),
);
