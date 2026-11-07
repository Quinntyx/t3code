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

/** Captive-portal checks: cacheless, tiny, and answered by any working network. */
const NETWORK_PROBE_URLS: ReadonlyArray<string> = [
  "https://www.gstatic.com/generate_204",
  "https://cloudflare.com/cdn-cgi/trace",
];

const PROBE_TIMEOUT = Duration.seconds(3);
const OFFLINE_PROBE_START_MS = 2_000;
const OFFLINE_PROBE_MAX_MS = 10_000;

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

      const check = Effect.fnUntraced(function* (confirmed: boolean) {
        if (yield* probe) {
          yield* Ref.set(offlineProbeDelayMs, OFFLINE_PROBE_START_MS);
          yield* setStatus("online");
          return;
        }
        if (confirmed) {
          yield* setStatus("offline");
        }
      });

      const loop = Effect.gen(function* () {
        // A fresh client cannot trust its OS signal either way, so it checks once.
        yield* Queue.offer(requests, { _tag: "Check", confirmed: false });
        for (;;) {
          const offline = (yield* SubscriptionRef.get(status)) === "offline";
          const request = offline
            ? yield* Effect.raceFirst(
                Queue.take(requests),
                Effect.sleep(Duration.millis(yield* Ref.get(offlineProbeDelayMs))).pipe(
                  Effect.as<LivenessRequest>({ _tag: "Tick" }),
                ),
              )
            : yield* Queue.take(requests);
          switch (request._tag) {
            case "Reachable":
              yield* setStatus("online");
              break;
            case "Check":
              yield* check(request.confirmed);
              break;
            case "Tick":
              yield* check(false);
              // A long outage should not cost a request every two seconds.
              if ((yield* SubscriptionRef.get(status)) === "offline") {
                yield* Ref.update(offlineProbeDelayMs, (delay) =>
                  Math.min(delay * 2, OFFLINE_PROBE_MAX_MS),
                );
              }
              break;
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
                    // Airplane mode is authoritative at once; the check still runs,
                    // because an OS report can be wrong about a loopback server.
                    if (next === "offline") yield* setStatus("offline");
                    yield* Queue.offer(requests, { _tag: "Check", confirmed: false });
                  }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      const enqueue = (request: LivenessRequest) =>
        Queue.offer(requests, request).pipe(Effect.asVoid);

      const report = Effect.fnUntraced(function* (outcome: "reachable" | "unreachable") {
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

const probeEndpoint = Effect.fnUntraced(function* (url: string) {
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
