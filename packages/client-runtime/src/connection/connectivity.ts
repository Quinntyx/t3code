import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export interface ConnectivityService {
  readonly status: Effect.Effect<NetworkStatus>;
  readonly changes: Stream.Stream<NetworkStatus>;
  /** Re-checks reachability now. Only a platform with an active probe provides it. */
  readonly checkNow?: Effect.Effect<void>;
  /** What a real request showed about the network, which outranks a probe. */
  readonly report?: (outcome: "reachable" | "unreachable") => Effect.Effect<void>;
}

export class Connectivity extends Context.Service<Connectivity, ConnectivityService>()(
  "@t3tools/client-runtime/connection/connectivity",
) {}

const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));
