// @effect-diagnostics-next-line nodeBuiltinImport:off -- Client keys are opaque random strings.
import * as NodeCrypto from "node:crypto";

import type {
  DiscoverServiceCapability,
  DiscoverServiceCredential,
  DiscoverServiceEndpoint,
  DiscoverServiceHealth,
  DiscoverServiceProtocol,
} from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ServiceError, type DiscoverableService, type ServiceMember } from "./types.ts";

/**
 * CLIProxyAPI keeps client keys in one list. v0 is the documented, still-supported surface for
 * that list; the v8 equivalent replaces the whole config tree, which is more than a key needs.
 */
const DEFAULT_MANAGEMENT_BASE_PATH = "/v0/management";

const ApiKeys = Schema.Struct({ "api-keys": Schema.Array(Schema.String) });
const decodeApiKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiKeys));
const isServiceError = Schema.is(ServiceError);

const joinPath = (base: string, path: string) =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const serviceFailure = (serviceId: string, message: string) =>
  new ServiceError({ serviceId, message });

export interface CliProxyServiceConfig {
  readonly serviceId: string;
  readonly label: string;
  readonly endpoints: ReadonlyArray<DiscoverServiceEndpoint>;
  readonly managementKey: string;
  readonly protocol: DiscoverServiceProtocol;
  readonly basePath: string;
  readonly managementBasePath?: string;
}

/** Client-facing base URL for one endpoint, using the protocol's default path. */
export const cliProxyBaseUrl = (endpoint: DiscoverServiceEndpoint, basePath: string): string => {
  const origin = new URL(endpoint.httpBaseUrl).origin;
  return basePath.length === 0 ? origin : `${origin}${basePath}`;
};

export const makeCliProxyService = Effect.fn("DiscoverServices.cliProxy")(function* (
  config: CliProxyServiceConfig,
) {
  const http = yield* HttpClient.HttpClient;
  const managementBasePath = config.managementBasePath ?? DEFAULT_MANAGEMENT_BASE_PATH;
  const managementOrigin = new URL(config.endpoints[0]!.httpBaseUrl).origin;
  const capabilities: ReadonlyArray<DiscoverServiceCapability> =
    config.managementKey.length > 0 ? ["key-exchange"] : [];
  const authorize = (request: HttpClientRequest.HttpClientRequest) =>
    config.managementKey.length > 0
      ? HttpClientRequest.bearerToken(request, config.managementKey)
      : request;
  const managementUrl = (path: string) =>
    joinPath(managementOrigin, joinPath(managementBasePath, path));

  const readKeys = Effect.gen(function* () {
    const response = yield* http.execute(
      authorize(HttpClientRequest.get(managementUrl("api-keys"))),
    );
    if (response.status !== 200) {
      return yield* serviceFailure(
        config.serviceId,
        `CLIProxyAPI rejected the management key (${response.status}).`,
      );
    }
    const body = yield* response.text;
    const decoded = yield* decodeApiKeys(body);
    return decoded["api-keys"];
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      isServiceError(cause)
        ? cause
        : serviceFailure(config.serviceId, "Could not read CLIProxyAPI client keys."),
    ),
  );

  const writeKeys = Effect.fn("DiscoverServices.cliProxy.write")(
    function* (keys: ReadonlyArray<string>) {
      const response = yield* http.execute(
        authorize(HttpClientRequest.put(managementUrl("api-keys"))).pipe(
          HttpClientRequest.bodyJsonUnsafe(keys),
        ),
      );
      if (response.status !== 200) {
        return yield* serviceFailure(
          config.serviceId,
          `CLIProxyAPI rejected the key update (${response.status}).`,
        );
      }
    },
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      isServiceError(cause)
        ? cause
        : serviceFailure(config.serviceId, "Could not update CLIProxyAPI client keys."),
    ),
  );

  const health: Effect.Effect<DiscoverServiceHealth> = (
    config.managementKey.length > 0
      ? http.execute(authorize(HttpClientRequest.get(managementUrl("config"))))
      : http.execute(HttpClientRequest.get(managementOrigin))
  ).pipe(
    // Any HTTP answer means the hub is up; a rejected key is a configuration problem, not an outage.
    Effect.map((): DiscoverServiceHealth => "online"),
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed((): DiscoverServiceHealth => "offline"),
  );

  const issueCredential = Effect.fn("DiscoverServices.cliProxy.issue")(function* (
    member: ServiceMember,
  ) {
    if (config.managementKey.length === 0) {
      return yield* serviceFailure(
        config.serviceId,
        "Set the CLIProxyAPI management key before linking this service.",
      );
    }
    yield* Effect.annotateCurrentSpan({ "discover.member": member.id });
    const existing = yield* readKeys;
    const apiKey = `t3d-${NodeCrypto.randomBytes(24).toString("base64url")}`;
    yield* writeKeys([...existing, apiKey]);
    return {
      protocol: config.protocol,
      baseUrl: cliProxyBaseUrl(config.endpoints[0]!, config.basePath),
      apiKey,
    } satisfies DiscoverServiceCredential;
  });

  const revokeCredential = Effect.fn("DiscoverServices.cliProxy.revoke")(function* (
    _member: ServiceMember,
    credential: DiscoverServiceCredential,
  ) {
    if (config.managementKey.length === 0) return;
    const existing = yield* readKeys;
    if (!existing.includes(credential.apiKey)) return;
    yield* writeKeys(existing.filter((key) => key !== credential.apiKey));
  });

  return {
    serviceId: config.serviceId,
    kind: "cliproxyapi",
    label: config.label,
    protocol: config.protocol,
    endpoints: config.endpoints,
    capabilities,
    health,
    issueCredential,
    revokeCredential,
  } satisfies DiscoverableService;
});
