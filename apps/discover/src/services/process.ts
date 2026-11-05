import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServiceError, type ManagedService, type ManagedServiceStatus } from "./types.ts";

export interface ProcessServiceConfig {
  readonly serviceId: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

const initialStatus = (serviceId: string): ManagedServiceStatus => ({
  serviceId,
  state: "stopped",
  pid: null,
  restarts: 0,
  error: null,
});

const restartDelay = (restarts: number) => Math.min(30_000, 1_000 * 2 ** Math.min(restarts, 5));

/**
 * Supervises one long-running command. A restart loop keeps a crashed hub available, and the last
 * failure stays visible in `status` so an operator can see why it keeps restarting.
 */
export const makeProcessService = Effect.fn("DiscoverServices.process")(function* (
  config: ProcessServiceConfig,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The supervisor outlives the effect that starts it, so it owns its scope instead of borrowing one.
  const supervisorScope = yield* Ref.make(yield* Scope.make());
  const status = yield* Ref.make(initialStatus(config.serviceId));
  const child = yield* Ref.make<Option.Option<ChildProcessSpawner.ChildProcessHandle>>(
    Option.none(),
  );
  const stopping = yield* Ref.make(false);
  const started = yield* Ref.make(false);

  // The spawner ties a handle to a scope; this one lives until the child exits.
  const spawnOnce = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(config.command, config.args ?? [], {
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.env === undefined ? {} : { env: config.env }),
        extendEnv: true,
        // A supervised service must not outlive the broker that owns it.
        detached: false,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const handle = yield* spawner.spawn(command);
      yield* Ref.set(child, Option.some(handle));
      yield* Ref.update(status, (value): ManagedServiceStatus => ({
        ...value,
        state: "running",
        pid: Number(handle.pid),
        error: null,
      }));
      yield* handle.exitCode;
      yield* Ref.set(child, Option.none());
    }),
  );

  const supervise: Effect.Effect<void> = Effect.gen(function* () {
    for (;;) {
      if (yield* Ref.get(stopping)) return;
      const result = yield* spawnOnce.pipe(Effect.exit);
      if (yield* Ref.get(stopping)) return;
      const restarts = (yield* Ref.get(status)).restarts + 1;
      yield* Ref.update(status, (value): ManagedServiceStatus => ({
        ...value,
        state: "failed",
        pid: null,
        restarts,
        error: result._tag === "Success" ? "The service exited." : "The service could not start.",
      }));
      yield* Effect.sleep(restartDelay(restarts));
    }
  });

  const start: Effect.Effect<void, ServiceError> = Effect.gen(function* () {
    if (yield* Ref.get(started)) return;
    yield* Ref.set(started, true);
    yield* Ref.set(stopping, false);
    yield* Ref.update(status, (value): ManagedServiceStatus => ({
      ...value,
      state: "starting",
      error: null,
    }));
    yield* Effect.forkIn(yield* Ref.get(supervisorScope))(supervise);
  });

  const stop = Effect.gen(function* () {
    yield* Ref.set(stopping, true);
    yield* Ref.set(started, false);
    yield* Scope.close(yield* Ref.get(supervisorScope), Exit.void).pipe(Effect.ignore);
    yield* Ref.set(supervisorScope, yield* Scope.make());
    const running = yield* Ref.get(child);
    if (Option.isSome(running)) {
      yield* running.value.kill().pipe(Effect.ignore);
      yield* running.value.exitCode.pipe(Effect.ignore);
    }
    yield* Ref.set(child, Option.none());
    yield* Ref.set(status, initialStatus(config.serviceId));
  });

  return {
    serviceId: config.serviceId,
    status: Ref.get(status),
    start,
    stop,
  } satisfies ManagedService;
});

export const startAll = (services: ReadonlyArray<ManagedService>) =>
  Effect.forEach(
    services,
    (service) =>
      service.start.pipe(
        Effect.catch((error) =>
          Effect.sync(() => process.stderr.write(`t3discover: ${error.message}\n`)),
        ),
      ),
    { discard: true },
  );

/** Stops every managed service, in reverse start order, when the broker shuts down. */
export const stopAll = (services: ReadonlyArray<ManagedService>) =>
  Effect.forEach([...services].reverse(), (service) => service.stop, { discard: true });
