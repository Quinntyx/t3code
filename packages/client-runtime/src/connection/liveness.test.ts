import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Connectivity from "./connectivity.ts";
import * as NetworkLiveness from "./liveness.ts";
import type { NetworkStatus } from "./model.ts";

function awaitStatus(connectivity: Connectivity.ConnectivityService, expected: NetworkStatus) {
  return connectivity.changes.pipe(
    Stream.filter((status) => status === expected),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const harness = Effect.fn("TestLivenessHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly reachable?: boolean;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const reachable = yield* Ref.make(options?.reachable ?? false);
  const layer = NetworkLiveness.layer({
    probe: Ref.get(reachable),
  }).pipe(
    Layer.provide(
      Connectivity.layer({
        status: SubscriptionRef.get(networkStatus),
        changes: SubscriptionRef.changes(networkStatus),
      }),
    ),
  );
  return { networkStatus, reachable, layer };
});

describe("NetworkLiveness", () => {
  it.effect("reports the device offline when a failed attempt confirms the probe", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reachable: false });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* connectivity.report!("unreachable");
        yield* awaitStatus(connectivity, "offline");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("leaves the failure to the environment while the network answers", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reachable: true });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* connectivity.report!("unreachable");
        yield* TestClock.adjust("1 second");
        expect(yield* connectivity.status).toBe("online");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never reports the device offline from a probe alone", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reachable: false });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* connectivity.checkNow!;
        yield* TestClock.adjust("1 second");
        expect(yield* connectivity.status).toBe("online");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns online as soon as the network answers", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reachable: false });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* connectivity.report!("unreachable");
        yield* awaitStatus(connectivity, "offline");

        yield* Ref.set(test.reachable, true);
        yield* TestClock.adjust("2 seconds");
        yield* awaitStatus(connectivity, "online");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("trusts a reachable probe over an offline OS report", () =>
    Effect.gen(function* () {
      const test = yield* harness({ networkStatus: "offline", reachable: true });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* awaitStatus(connectivity, "online");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports offline at once when the OS does and the probe agrees", () =>
    Effect.gen(function* () {
      const test = yield* harness({ reachable: false });
      yield* Effect.gen(function* () {
        const connectivity = yield* Connectivity.Connectivity;
        yield* connectivity.checkNow!;
        yield* TestClock.adjust("1 second");

        yield* SubscriptionRef.set(test.networkStatus, "offline");
        yield* awaitStatus(connectivity, "offline");
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
