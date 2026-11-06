import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  DiscoverDirectory,
  type DiscoverDirectoryEntry,
  type DiscoverEndpoint,
  DiscoverMembership,
  DiscoverPairingRequest,
  DiscoverPairingResult,
  DiscoverServiceLink,
  type DiscoverServiceEntry,
  type DiscoverTransport,
} from "@t3tools/contracts/discover";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { ConnectionOnboarding } from "../connection/onboarding.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { ConnectionWakeups } from "../connection/wakeups.ts";
import { ClientPresentation } from "../platform/capabilities.ts";
import {
  DiscoverMembershipStore,
  type ConnectionPersistenceError,
} from "../platform/persistence.ts";
import type { StoredDiscoverMembership } from "../platform/storageDocument.ts";
import { parseDiscoverEnrollmentUrl } from "./url.ts";
import { requestGuarded, type EnvironmentRpcInput } from "../rpc/client.ts";

export interface DirectoryDiscoveryState {
  readonly directory: null | {
    readonly directoryId: string;
    readonly label: string;
    readonly brokerOrigin: string;
  };
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly hosts: ReadonlyArray<DiscoverDirectoryEntry>;
  readonly services: ReadonlyArray<DiscoverServiceEntry>;
}

export const EMPTY_DISCOVERY_STATE: DirectoryDiscoveryState = {
  directory: null,
  refreshing: false,
  error: null,
  hosts: [],
  services: [],
};

type DiscoveryError = ConnectionAttemptError | ConnectionPersistenceError;
const isConnectionError = Schema.is(
  Schema.Union([ConnectionBlockedError, ConnectionTransientError]),
);

export class DirectoryDiscovery extends Context.Service<
  DirectoryDiscovery,
  {
    readonly state: SubscriptionRef.SubscriptionRef<DirectoryDiscoveryState>;
    readonly enroll: (input: {
      readonly enrollmentUrl: string;
      readonly transport?: DiscoverTransport;
    }) => Effect.Effect<void, DiscoveryError>;
    readonly refresh: () => Effect.Effect<void>;
    readonly disconnect: () => Effect.Effect<void, ConnectionPersistenceError>;
    readonly start: Effect.Effect<void>;
    readonly linkService: (input: {
      readonly serviceId: string;
      readonly transport?: DiscoverTransport;
    }) => Effect.Effect<DiscoverServiceLink, DiscoveryError>;
    readonly unlinkService: (serviceId: string) => Effect.Effect<void, DiscoveryError>;
    /** Reads an existing credential without minting one; null when the service is not linked. */
    readonly serviceLink: (
      serviceId: string,
    ) => Effect.Effect<DiscoverServiceLink | null, DiscoveryError>;
  }
>()("@t3tools/client-runtime/discover/service/DirectoryDiscovery") {}

function invalid(detail: string) {
  return new ConnectionBlockedError({ reason: "configuration", detail });
}

function publicDirectory(
  membership: StoredDiscoverMembership,
): NonNullable<DirectoryDiscoveryState["directory"]> {
  return {
    directoryId: membership.directoryId,
    label: membership.label,
    brokerOrigin: membership.brokerOrigin,
  };
}

function endpointOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function preferredEndpoint(host: DiscoverDirectoryEntry): DiscoverEndpoint | undefined {
  for (const transport of ["tailscale", "lan"] as const) {
    const endpoint = host.endpoints.find(
      (candidate) =>
        candidate.transport === transport && endpointOrigin(candidate.httpBaseUrl) !== null,
    );
    if (endpoint) return endpoint;
  }
  return undefined;
}

/** @public */
export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const store = yield* DiscoverMembershipStore;
  const registry = yield* EnvironmentRegistry;
  const onboarding = yield* ConnectionOnboarding;
  const presentation = yield* ClientPresentation;
  const wakeups = yield* ConnectionWakeups;
  const scope = yield* Scope.Scope;
  let membership = yield* store.load;
  let generation = 0;
  let started = false;
  const operations = new Set<Fiber.Fiber<unknown, DiscoveryError>>();
  const lock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<DirectoryDiscoveryState>({
    ...EMPTY_DISCOVERY_STATE,
    directory: membership === null ? null : publicDirectory(membership),
  });

  const request = Effect.fn("DirectoryDiscovery.request")(
    function* <S extends Schema.Top>(
      origin: string,
      path: string,
      method: "GET" | "POST" | "DELETE",
      schema: S & { readonly DecodingServices: never },
      token?: string,
      body?: unknown,
    ) {
      let req = HttpClientRequest.make(method)(`${origin}/api/discover${path}`);
      if (token !== undefined) req = HttpClientRequest.bearerToken(req, token);
      if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
      const response = yield* http.execute(req);
      if (response.status < 200 || response.status >= 300) {
        return yield* response.status === 429 || response.status >= 500
          ? new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "The discovery directory is unavailable. Try again shortly.",
            })
          : invalid(
              "The discovery directory rejected this request. Check your directory membership.",
            );
      }
      return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
    },
    Effect.timeout("15 seconds"),
    Effect.mapError((error) =>
      isConnectionError(error)
        ? error
        : new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: "Could not reach the discovery directory or read its response.",
          }),
    ),
  );

  const remember = Effect.fn("DirectoryDiscovery.remember")(function* (
    environmentId: EnvironmentId,
    expected: number,
  ) {
    if (
      generation !== expected ||
      membership === null ||
      membership.seenEnvironmentIds.includes(environmentId)
    )
      return;
    const next = {
      ...membership,
      seenEnvironmentIds: [...membership.seenEnvironmentIds, environmentId],
    };
    yield* store.save(next);
    if (generation === expected) membership = next;
  });

  const importHost = Effect.fn("DirectoryDiscovery.importHost")(function* (
    host: DiscoverDirectoryEntry,
    expected: number,
  ) {
    if (generation !== expected || membership === null) return;
    const environmentId = host.descriptor.environmentId;
    if (membership.seenEnvironmentIds.includes(environmentId)) return;
    if ((yield* Clock.currentTimeMillis) - host.lastSeenAt > 30_000) return;
    if ((yield* SubscriptionRef.get(registry.entries)).has(environmentId)) {
      yield* remember(environmentId, expected);
      return;
    }
    const endpoint = preferredEndpoint(host);
    if (endpoint === undefined) return;
    const current = membership;
    const pairing = yield* request(
      current.brokerOrigin,
      "/requests",
      "POST",
      DiscoverPairingRequest,
      current.token,
      { environmentId, transport: endpoint.transport },
    );
    if (pairing.environmentId !== environmentId || pairing.transport !== endpoint.transport)
      return yield* invalid(
        "The directory returned a pairing request for a different environment.",
      );
    let result = yield* request(
      current.brokerOrigin,
      `/requests/${encodeURIComponent(pairing.requestId)}/result`,
      "GET",
      DiscoverPairingResult,
      current.token,
    );
    while (result.status === "pending") {
      if ((yield* Clock.currentTimeMillis) >= pairing.expiresAt)
        return yield* invalid("The discovery pairing request expired. Try refreshing again.");
      yield* Effect.sleep("1 second");
      result = yield* request(
        current.brokerOrigin,
        `/requests/${encodeURIComponent(pairing.requestId)}/result`,
        "GET",
        DiscoverPairingResult,
        current.token,
      );
    }
    if (result.status === "failed")
      return yield* invalid("The discovered environment could not provide a pairing link.");
    if (result.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* invalid("The discovery pairing link expired. Try refreshing again.");
    yield* Effect.try({
      try: () => {
        const url = new URL(result.pairingUrl);
        if (url.pathname === "/discover" || url.username || url.password) throw new Error();
        const target = resolveRemotePairingTarget({ pairingUrl: result.pairingUrl });
        if (endpointOrigin(target.httpBaseUrl) !== endpointOrigin(endpoint.httpBaseUrl))
          throw new Error();
      },
      catch: () =>
        invalid("The discovery pairing link does not match the advertised environment endpoint."),
    });
    if (
      generation !== expected ||
      (membership !== current && membership?.memberId !== current.memberId)
    )
      return;
    if (!(yield* SubscriptionRef.get(registry.entries)).has(environmentId)) {
      yield* onboarding.registerPairing({
        pairingUrl: result.pairingUrl,
        expectedEnvironmentId: environmentId,
      });
    }
    yield* remember(environmentId, expected);
  });

  const refreshUnlocked = Effect.fn("DirectoryDiscovery.refresh")(function* (expected: number) {
    if (membership === null || expected !== generation) return;
    const current = membership;
    yield* SubscriptionRef.update(state, (value) => ({ ...value, refreshing: true, error: null }));
    yield* Effect.gen(function* () {
      const directory = yield* request(
        current.brokerOrigin,
        "/hosts",
        "GET",
        DiscoverDirectory,
        current.token,
      );
      if (generation !== expected) return;
      yield* SubscriptionRef.update(state, (value) => ({
        ...value,
        hosts: directory.hosts,
        services: directory.services,
      }));
      for (const host of directory.hosts) {
        if (generation !== expected) return;
        yield* importHost(host, expected).pipe(
          Effect.catch(() =>
            SubscriptionRef.update(state, (value) =>
              generation === expected
                ? {
                    ...value,
                    error: "Could not connect a discovered environment. Refresh to try again.",
                  }
                : value,
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch(() =>
        SubscriptionRef.update(state, (value) =>
          generation === expected
            ? {
                ...value,
                error: "The discovery directory is unavailable. Saved connections are unchanged.",
              }
            : value,
        ),
      ),
      Effect.ensuring(
        SubscriptionRef.update(state, (value) =>
          generation === expected ? { ...value, refreshing: false } : value,
        ),
      ),
    );
  });

  const tracked = Effect.fn("DirectoryDiscovery.tracked")(function* <A>(
    operation: Effect.Effect<A, DiscoveryError>,
  ) {
    const fiber = yield* Effect.forkChild(operation);
    operations.add(fiber);
    return yield* Fiber.join(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          operations.delete(fiber);
        }),
      ),
    );
  });

  const refresh = () =>
    Effect.suspend(() => {
      const expected = generation;
      return tracked(lock.withPermits(1)(refreshUnlocked(expected))).pipe(Effect.ignore);
    });

  const localEnvironmentId = Effect.gen(function* () {
    if (presentation.metadata.surface !== "desktop") return undefined;
    const entries = yield* SubscriptionRef.get(registry.entries);
    return [...entries.values()].find((entry) => entry.target._tag === "PrimaryConnectionTarget")
      ?.target.environmentId;
  });

  const hostRequest = Effect.fn("DirectoryDiscovery.hostRequest")(function* <
    T extends typeof WS_METHODS.discoverConfigure | typeof WS_METHODS.discoverRevoke,
  >(environmentId: EnvironmentId, tag: T, input: EnvironmentRpcInput<T>) {
    return yield* registry
      .run(environmentId, requestGuarded(tag, input))
      .pipe(
        Effect.mapError((error) =>
          invalid(
            error instanceof Error
              ? error.message
              : "Could not update local discovery registration.",
          ),
        ),
      );
  });

  const enroll = Effect.fn("DirectoryDiscovery.enroll")(function* (input: {
    readonly enrollmentUrl: string;
    readonly transport?: DiscoverTransport;
  }) {
    const parsed = parseDiscoverEnrollmentUrl(input.enrollmentUrl);
    if (parsed === null)
      return yield* invalid("Enter a valid discovery enrollment URL ending in /discover#token=….");
    const expected = generation;
    yield* tracked(
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (membership !== null)
            return yield* invalid(
              "Disconnect the current discovery directory before enrolling in another.",
            );
          const localId = yield* localEnvironmentId;
          if (presentation.metadata.surface === "desktop" && localId === undefined)
            return yield* invalid("Connect your local environment before joining discovery.");
          const result = yield* request(
            parsed.brokerOrigin,
            "/enroll",
            "POST",
            DiscoverMembership,
            undefined,
            { code: parsed.code, label: presentation.metadata.label ?? "T3 Code" },
          );
          if (generation !== expected) return;
          const next = { ...result, brokerOrigin: parsed.brokerOrigin, seenEnvironmentIds: [] };
          let configured = false;
          yield* Effect.gen(function* () {
            if (localId !== undefined) {
              yield* hostRequest(localId, WS_METHODS.discoverConfigure, {
                brokerOrigin: parsed.brokerOrigin,
                memberToken: result.token,
                transport: input.transport ?? "tailscale",
              });
              configured = true;
            }
            yield* store.save(next);
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                if (configured && localId !== undefined)
                  yield* hostRequest(localId, WS_METHODS.discoverRevoke, {}).pipe(Effect.ignore);
                yield* request(
                  parsed.brokerOrigin,
                  "/membership",
                  "DELETE",
                  Schema.Struct({}),
                  result.token,
                ).pipe(Effect.ignore);
              }),
            ),
          );
          if (generation !== expected) return;
          membership = next;
          yield* SubscriptionRef.set(state, {
            ...EMPTY_DISCOVERY_STATE,
            directory: publicDirectory(next),
          });
          yield* refreshUnlocked(expected);
        }),
      ),
    );
  });

  const disconnect = Effect.fn("DirectoryDiscovery.disconnect")(function* () {
    generation++;
    const previous = membership;
    yield* Effect.forEach([...operations], Fiber.interrupt, { discard: true });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const localId = yield* localEnvironmentId;
        if (previous !== null && localId !== undefined)
          yield* hostRequest(localId, WS_METHODS.discoverRevoke, {}).pipe(Effect.ignore);
        yield* store.save(null);
        membership = null;
        yield* SubscriptionRef.set(state, EMPTY_DISCOVERY_STATE);
      }),
    );
    if (previous !== null) {
      yield* request(
        previous.brokerOrigin,
        "/membership",
        "DELETE",
        Schema.Struct({}),
        previous.token,
      ).pipe(Effect.ignore);
    }
  });

  const serviceLink = Effect.fn("DirectoryDiscovery.serviceLink")(function* (serviceId: string) {
    const current = membership;
    if (current === null) return null;
    // The timeout has to cover the body read too, or a stalled body leaves the dialog pending and
    // the per-service single-flight command blocks every later click.
    return yield* Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.bearerToken(
          HttpClientRequest.get(
            `${current.brokerOrigin}/api/discover/services/${encodeURIComponent(serviceId)}/link`,
          ),
          current.token,
        ),
      );
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300)
        return yield* invalid("The discovery directory rejected this request.");
      return yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DiscoverServiceLink)),
        Effect.mapError(() =>
          invalid("The discovery directory returned an unreadable service credential."),
        ),
      );
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError((error) =>
        isConnectionError(error)
          ? error
          : new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "Could not read the discovery service credential.",
            }),
      ),
    );
  });

  const linkService = (input: {
    readonly serviceId: string;
    readonly transport?: DiscoverTransport;
  }) =>
    Effect.suspend(() => {
      const current = membership;
      if (current === null) return invalid("Join a discovery directory before linking services.");
      const expected = generation;
      // Tracked so disconnect cancels it, and generation-checked so a late answer from the
      // previous directory cannot mark the new one linked or hand back its member's credential.
      return tracked(
        Effect.gen(function* () {
          const link = yield* request(
            current.brokerOrigin,
            `/services/${encodeURIComponent(input.serviceId)}/link`,
            "POST",
            DiscoverServiceLink,
            current.token,
            input.transport === undefined ? {} : { transport: input.transport },
          );
          if (link.serviceId !== input.serviceId)
            return yield* invalid("The directory returned a link for a different service.");
          if (generation !== expected)
            return yield* invalid("The discovery directory changed. Try again.");
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            services: value.services.map((service) =>
              service.serviceId === input.serviceId
                ? { ...service, linkedAt: link.linkedAt }
                : service,
            ),
          }));
          return link;
        }),
      );
    });

  const unlinkService = (serviceId: string) =>
    Effect.suspend(() => {
      const current = membership;
      if (current === null) return invalid("Join a discovery directory before unlinking services.");
      const expected = generation;
      return tracked(
        Effect.gen(function* () {
          yield* request(
            current.brokerOrigin,
            `/services/${encodeURIComponent(serviceId)}/link`,
            "DELETE",
            Schema.Struct({ ok: Schema.Boolean }),
            current.token,
          );
          if (generation !== expected)
            return yield* invalid("The discovery directory changed. Try again.");
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            services: value.services.map((service) =>
              service.serviceId === serviceId ? { ...service, linkedAt: null } : service,
            ),
          }));
        }),
      );
    });

  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* Stream.merge(
      Stream.tick("1 minute"),
      wakeups.changes.pipe(Stream.filter((reason) => reason !== "credentials-changed")),
    ).pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkIn(scope),
    );
    yield* refresh().pipe(Effect.forkIn(scope));
  });

  return DirectoryDiscovery.of({
    state,
    enroll,
    refresh,
    disconnect,
    start,
    linkService,
    unlinkService,
    serviceLink,
  });
});

export const layer = Layer.effect(DirectoryDiscovery, make);
