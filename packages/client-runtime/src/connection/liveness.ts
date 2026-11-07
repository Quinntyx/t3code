import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as Connectivity from "./connectivity.ts";
import type { NetworkStatus } from "./model.ts";

/** Cacheless, tiny, and answered by any working network. */
const NETWORK_PROBE_URLS: ReadonlyArray<string> = [
  "https://www.gstatic.com/generate_204",
  "https://cloudflare.com/cdn-cgi/trace",
];

const PROBE_TIMEOUT = Duration.seconds(3);
const OFFLINE_PROBE_START_MS = 2_000;
const OFFLINE_PROBE_MAX_MS = 10_000;
// A device whose OS already reports offline has nothing to recover from quickly,
// so it checks rarely rather than every couple of seconds.
const OS_OFFLINE_PROBE_INTERVAL_MS = 30_000;

export interface NetworkLivenessOptions {
  /** True when any probe endpoint answered. */
  readonly probe: Effect.Effect<boolean>;
  readonly probeTimeout?: Duration.Input;
}

type LivenessRequest =
  | { readonly _tag: "Check"; readonly confirmed: boolean }
  | { readonly _tag: "Reachable" }
  | { readonly _tag: "Tick" };

/**
 * Wraps the platform's network signal with an active reachability check, so a
 * client can tell being offline from an environment being down. A probe never
 * goes offline alone: a network that blocks the probe endpoints would lock out
 * every environment. A failed attempt reports the evidence it needs.
 */
export const layer = (options: NetworkLivenessOptions) =>
  Layer.effect(
    Connectivity.Connectivity,
    Effect.gen(function* () {
      const platform = yield* Connectivity.Connectivity;
      const initial = yield* platform.status;
      const status = yield* SubscriptionRef.make<NetworkStatus>(initial);
      const osStatus = yield* Ref.make<NetworkStatus>(initial);
      const offlineProbeDelayMs = yield* Ref.make(OFFLINE_PROBE_START_MS);
      const requests = yield* Queue.unbounded<LivenessRequest>();

      const setStatus = (next: NetworkStatus) =>
        SubscriptionRef.modify(status, (current) =>
          current === next ? ([false, current] as const) : ([true, next] as const),
        );

      const probe = options.probe.pipe(
        Effect.timeoutOption(options.probeTimeout ?? PROBE_TIMEOUT),
        Effect.map((answered) => Option.getOrElse(answered, () => false)),
        Effect.catchCause(() => Effect.succeed(false)),
      );

      const check = Effect.fn("NetworkLiveness.check")(function* (confirmed: boolean) {
        if (yield* probe) {
          yield* Ref.set(offlineProbeDelayMs, OFFLINE_PROBE_START_MS);
          yield* setStatus("online");
          return;
        }
        if (confirmed) {
          yield* setStatus("offline");
        }
      });

      const nextProbeDelayMs = Effect.gen(function* () {
        const os = yield* Ref.get(osStatus);
        return os === "offline"
          ? OS_OFFLINE_PROBE_INTERVAL_MS
          : yield* Ref.get(offlineProbeDelayMs);
      });

      // Everything already queued folds into one probe: an outage with many
      // environments must not cost one request per environment.
      const drainRequests = Effect.gen(function* () {
        const rest: Array<LivenessRequest> = [];
        for (;;) {
          const next = yield* Queue.poll(requests);
          if (Option.isNone(next)) return rest;
          rest.push(next.value);
        }
      });

      const loop = Effect.gen(function* () {
        // A fresh client cannot trust its OS signal either way, so it checks once.
        yield* Queue.offer(requests, { _tag: "Check", confirmed: false });
        for (;;) {
          const offline = (yield* SubscriptionRef.get(status)) === "offline";
          const first = offline
            ? yield* Effect.raceFirst(
                Queue.take(requests),
                Effect.sleep(Duration.millis(yield* nextProbeDelayMs)).pipe(
                  Effect.as<LivenessRequest>({ _tag: "Tick" }),
                ),
              )
            : yield* Queue.take(requests);
          const batch = [first, ...(yield* drainRequests)];
          if (batch.some((request) => request._tag === "Reachable")) {
            yield* Ref.set(offlineProbeDelayMs, OFFLINE_PROBE_START_MS);
            yield* setStatus("online");
            continue;
          }
          yield* check(batch.some((request) => request._tag === "Check" && request.confirmed));
          if (
            batch.some((request) => request._tag === "Tick") &&
            (yield* SubscriptionRef.get(status)) === "offline"
          ) {
            // A long outage should not cost a request every two seconds.
            yield* Ref.update(offlineProbeDelayMs, (delay) =>
              Math.min(delay * 2, OFFLINE_PROBE_MAX_MS),
            );
          }
        }
      });
      yield* loop.pipe(Effect.forkScoped);

      yield* platform.changes.pipe(
        Stream.runForEach((next) =>
          Ref.getAndSet(osStatus, next).pipe(
            Effect.flatMap((previous) =>
              previous === next
                ? Effect.void
                : Effect.gen(function* () {
                    // The OS is the fastest signal in both directions, and a
                    // blocked probe must not outlive the network it described.
                    if (next === "offline") yield* setStatus("offline");
                    if (next === "online") yield* setStatus("online");
                    yield* Queue.offer(requests, { _tag: "Check", confirmed: false });
                  }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      const enqueue = (request: LivenessRequest) =>
        Queue.offer(requests, request).pipe(Effect.asVoid);

      const report = Effect.fn("NetworkLiveness.report")(function* (
        outcome: "reachable" | "unreachable",
      ) {
        yield* enqueue(
          outcome === "reachable" ? { _tag: "Reachable" } : { _tag: "Check", confirmed: true },
        );
      });

      return Connectivity.Connectivity.of({
        status: SubscriptionRef.get(status),
        changes: SubscriptionRef.changes(status),
        checkNow: enqueue({ _tag: "Check", confirmed: false }),
        report,
      });
    }),
  );

const probeEndpoint = Effect.fn("NetworkLiveness.probeEndpoint")(function* (url: string) {
  return yield* HttpClient.get(url).pipe(
    Effect.as(true),
    Effect.catchCause(() => Effect.succeed(false)),
  );
});

/**
 * Probes every endpoint in parallel; one answer is enough. An opaque response
 * counts, because a liveness check only needs the request to leave and return.
 */
export const fetchProbe = (
  urls: ReadonlyArray<string> = NETWORK_PROBE_URLS,
): Effect.Effect<boolean> =>
  Effect.forEach(urls, probeEndpoint, { concurrency: "unbounded" }).pipe(
    Effect.map((answered) => answered.some(Boolean)),
    // Tracing headers would make the browser send a preflight these hosts reject.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
    }),
    Effect.provide(FetchHttpClient.layer),
  );
