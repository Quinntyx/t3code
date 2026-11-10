import { AuthStandardClientScopes, type EnvironmentId } from "@t3tools/contracts";
import {
  DiscoverError,
  DiscoverHostGrant,
  type DiscoverHostConfiguration,
  type DiscoverHostRegistration,
  type DiscoverHostStatus,
  type DiscoverPairingRequest,
  type DiscoverPairingResult,
  type DiscoverTransport,
  DiscoverWork,
} from "@t3tools/contracts/discover";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveTailscalePairingBase } from "../cli/pair.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerActivation from "../serverActivation.ts";
import { buildPairingUrl } from "../startupAccess.ts";

const StoredHost = Schema.Struct({
  brokerOrigin: Schema.String,
  hostToken: Schema.String,
  transport: Schema.Literals(["tailscale", "lan"]),
});
type StoredHost = typeof StoredHost.Type;
const StoredHostJson = Schema.fromJsonString(StoredHost);
const encodeStoredHost = Schema.encodeEffect(StoredHostJson);
const decodeStoredHost = Schema.decodeUnknownEffect(StoredHostJson);
const secretName = "discover-host";
const disconnected: DiscoverHostStatus = { brokerOrigin: null, transport: null, error: null };

export const fulfillPairingRequest = Effect.fn("DiscoveryHost.fulfillPairingRequest")(
  function* (input: {
    readonly request: DiscoverPairingRequest;
    readonly environmentId: EnvironmentId;
    readonly transport: DiscoverTransport;
    readonly pairingBaseUrl: string;
    readonly createPairingLink: EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"];
  }): Effect.fn.Return<DiscoverPairingResult> {
    const now = yield* DateTime.now;
    if (
      input.request.environmentId !== input.environmentId ||
      input.request.transport !== input.transport ||
      input.request.expiresAt <= DateTime.toEpochMillis(now)
    ) {
      return { status: "failed", error: "This request is outside the discovery grant." };
    }
    const ttl = Duration.millis(
      Math.min(60_000, input.request.expiresAt - DateTime.toEpochMillis(now)),
    );
    const issued = yield* input
      .createPairingLink({
        ttl,
        scopes: AuthStandardClientScopes,
        subject: "discover",
        label: "T3 Discover",
      })
      .pipe(Effect.option);
    if (Option.isNone(issued)) {
      return { status: "failed", error: "The environment could not create a pairing link." };
    }
    return {
      status: "ready",
      pairingUrl: buildPairingUrl(input.pairingBaseUrl, issued.value.credential),
      expiresAt: DateTime.toEpochMillis(issued.value.expiresAt),
    };
  },
);

export class DiscoveryHost extends Context.Service<
  DiscoveryHost,
  {
    readonly status: () => Effect.Effect<DiscoverHostStatus>;
    readonly configure: (
      input: DiscoverHostConfiguration,
    ) => Effect.Effect<DiscoverHostStatus, DiscoverError>;
    readonly revoke: () => Effect.Effect<DiscoverHostStatus, DiscoverError>;
  }
>()("t3/discover/DiscoveryHost") {}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lock = yield* Semaphore.make(1);
  let current: StoredHost | null = null;
  let lastError: string | null = null;
  let cachedRegistration: DiscoverHostRegistration | undefined;
  let registrationExpiresAt = 0;

  const status = () =>
    Effect.sync((): DiscoverHostStatus =>
      current === null
        ? disconnected
        : { brokerOrigin: current.brokerOrigin, transport: current.transport, error: lastError },
    );

  const request = Effect.fn("DiscoveryHost.request")(
    function* <S extends Schema.Top>(
      host: { readonly brokerOrigin: string },
      token: string,
      path: string,
      method: "GET" | "POST" | "DELETE",
      schema: S & { readonly DecodingServices: never },
      body?: unknown,
    ) {
      let req = HttpClientRequest.make(method)(`${host.brokerOrigin}/api/discover${path}`);
      req = HttpClientRequest.bearerToken(req, token);
      if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
      const response = yield* http.execute(req);
      if (response.status < 200 || response.status >= 300) {
        return yield* new DiscoverError({
          message: "The discovery server rejected this host. Pair it again to restore sharing.",
        });
      }
      return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
    },
    Effect.timeout("10 seconds"),
    Effect.mapError(
      () => new DiscoverError({ message: "Could not communicate with the discovery server." }),
    ),
  );

  const registration = Effect.fn("DiscoveryHost.registration")(
    function* (transport: DiscoverTransport) {
      const descriptor = yield* environment.getDescriptor;
      let httpBaseUrl: string | undefined;
      if (transport === "tailscale") {
        const resolved = yield* resolveTailscalePairingBase({
          target: {
            descriptor,
            state: {
              host: config.host,
              port: config.port,
              ...(config.devUrl ? { devUrl: config.devUrl.toString() } : {}),
            },
          },
          servePort: config.tailscaleServePort,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        httpBaseUrl = resolved.baseUrl;
      } else {
        httpBaseUrl = (yield* endpoints.resolve()).find(
          (endpoint) => endpoint.kind === "lan",
        )?.httpBaseUrl;
      }
      if (httpBaseUrl === undefined) {
        return yield* new DiscoverError({
          message: "Enable network access before sharing this environment over LAN.",
        });
      }
      return {
        descriptor,
        endpoints: [{ transport, httpBaseUrl }],
      } satisfies DiscoverHostRegistration;
    },
    Effect.mapError(
      (cause) =>
        new DiscoverError({
          message:
            cause instanceof Error ? cause.message : "Could not prepare the sharing endpoint.",
        }),
    ),
  );

  const save = Effect.fn("DiscoveryHost.save")(
    function* (next: StoredHost) {
      const json = yield* encodeStoredHost(next);
      yield* secrets.set(secretName, new TextEncoder().encode(json));
      current = next;
      lastError = null;
    },
    Effect.mapError(
      () => new DiscoverError({ message: "Could not save discovery sharing credentials." }),
    ),
  );

  const configure = Effect.fn("DiscoveryHost.configure")(function* (
    input: DiscoverHostConfiguration,
  ) {
    if (!ManagedLimits.allowsRemoteClients(policy)) {
      return yield* new DiscoverError({
        message: ManagedLimits.refuseRemoteClients(policy).message,
      });
    }
    const url = yield* Effect.try({
      try: () => new URL(input.brokerOrigin),
      catch: () => new DiscoverError({ message: "Enter a valid discovery server URL." }),
    });
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return yield* new DiscoverError({
        message: "Discovery requires an HTTP or HTTPS origin without credentials or a path.",
      });
    }
    const target = { brokerOrigin: url.origin };
    const advertised = yield* registration(input.transport);
    const grant = yield* request(
      target,
      input.memberToken,
      "/hosts/enroll",
      "POST",
      DiscoverHostGrant,
      advertised,
    );
    const previous = current;
    const next = { ...target, hostToken: grant.hostToken, transport: input.transport };
    yield* save(next);
    cachedRegistration = advertised;
    registrationExpiresAt = DateTime.toEpochMillis(yield* DateTime.now) + 30_000;
    if (previous !== null && previous.brokerOrigin !== next.brokerOrigin) {
      yield* request(
        previous,
        previous.hostToken,
        "/hosts/enrollment",
        "DELETE",
        Schema.Unknown,
      ).pipe(Effect.ignore);
    }
    return yield* status();
  }, lock.withPermits(1));

  const revoke = Effect.fn("DiscoveryHost.revoke")(function* () {
    const previous = current;
    yield* secrets
      .remove(secretName)
      .pipe(
        Effect.mapError(
          () => new DiscoverError({ message: "Could not remove discovery sharing credentials." }),
        ),
      );
    current = null;
    cachedRegistration = undefined;
    lastError = null;
    if (previous !== null) {
      yield* request(
        previous,
        previous.hostToken,
        "/hosts/enrollment",
        "DELETE",
        Schema.Unknown,
      ).pipe(Effect.ignore);
    }
    return disconnected;
  }, lock.withPermits(1));

  const tick = Effect.fn("DiscoveryHost.tick")(function* () {
    if (current === null) return;
    if (!ManagedLimits.allowsRemoteClients(policy)) {
      lastError = ManagedLimits.refuseRemoteClients(policy).message;
      return;
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (cachedRegistration === undefined || now >= registrationExpiresAt) {
      cachedRegistration = yield* registration(current.transport);
      registrationExpiresAt = now + 30_000;
    }
    const advertised = cachedRegistration;
    yield* request(
      current,
      current.hostToken,
      "/hosts/heartbeat",
      "POST",
      Schema.Unknown,
      advertised,
    );
    const work = yield* request(current, current.hostToken, "/work", "GET", DiscoverWork);
    for (const item of work.requests) {
      const result = yield* fulfillPairingRequest({
        request: item,
        environmentId: advertised.descriptor.environmentId,
        transport: current.transport,
        pairingBaseUrl: advertised.endpoints[0]!.httpBaseUrl,
        createPairingLink: auth.createPairingLink,
      });
      yield* request(
        current,
        current.hostToken,
        `/requests/${encodeURIComponent(item.requestId)}/result`,
        "POST",
        Schema.Unknown,
        result,
      );
    }
    lastError = null;
  }, lock.withPermits(1));

  yield* ServerActivation.forkParked(
    Effect.gen(function* () {
      const stored = yield* secrets.get(secretName).pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(stored)) {
        current = yield* decodeStoredHost(new TextDecoder().decode(stored.value)).pipe(
          Effect.orElseSucceed(() => null),
        );
      }
      return yield* tick().pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            lastError = "Discovery sharing is offline. It will retry automatically.";
          }),
        ),
        Effect.andThen(Effect.sleep("3 seconds")),
        Effect.forever,
      );
    }),
  );

  return DiscoveryHost.of({ status, configure, revoke });
});

export const layer = Layer.effect(DiscoveryHost, make);
