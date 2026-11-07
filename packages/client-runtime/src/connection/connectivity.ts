import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export interface ConnectivityService {
  readonly status: Effect.Effect<NetworkStatus>;
  readonly changes: Stream.Stream<NetworkStatus>;
  /** Re-checks reachability now, when the platform can. */
  readonly checkNow: Effect.Effect<void>;
  /** What a real request showed about the network, which outranks a probe. */
  readonly report: (outcome: "reachable" | "unreachable") => Effect.Effect<void>;
}

export class Connectivity extends Context.Service<Connectivity, ConnectivityService>()(
  "@t3tools/client-runtime/connection/connectivity",
) {}

// A platform that only reports the OS signal has nothing to re-check or report.
const reportNothing = Effect.fnUntraced(function* () {});

/** A platform that only reports the OS signal has nothing to re-check. */
export const layer = (service: Omit<ConnectivityService, "checkNow" | "report">) =>
  Layer.succeed(
    Connectivity,
    Connectivity.of({
      checkNow: Effect.void,
      report: reportNothing,
      ...service,
    }),
  );
