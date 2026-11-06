import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { startAll, stopAll } from "./process.ts";
import { ServiceError, type ManagedService, type ManagedServiceStatus } from "./types.ts";

const fakeService = (
  serviceId: string,
  log: Ref.Ref<ReadonlyArray<string>>,
  failStart = false,
): ManagedService => ({
  serviceId,
  status: Effect.succeed<ManagedServiceStatus>({
    serviceId,
    state: "stopped",
    pid: null,
    restarts: 0,
    error: null,
  }),
  start: Effect.gen(function* () {
    yield* Ref.update(log, (value) => [...value, `start:${serviceId}`]);
    if (failStart) {
      return yield* new ServiceError({ serviceId, message: `${serviceId} is misconfigured.` });
    }
  }),
  stop: Ref.update(log, (value) => [...value, `stop:${serviceId}`]),
});

it.effect("starts every managed service and stops them in reverse order", () =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const services = [
      fakeService("first", log),
      fakeService("second", log),
      fakeService("broken", log, true),
    ];
    yield* startAll(services);
    // A misconfigured service must not stop the others from starting.
    assert.deepEqual(yield* Ref.get(log), ["start:first", "start:second", "start:broken"]);
    yield* stopAll(services);
    assert.deepEqual(yield* Ref.get(log), [
      "start:first",
      "start:second",
      "start:broken",
      "stop:broken",
      "stop:second",
      "stop:first",
    ]);
  }),
);
